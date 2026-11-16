/**
 * Fails when the option manifest each native SDK published for the PINNED version disagrees with the
 * option fixtures this package ships. Run in CI and before a publish.
 *
 * Usage: cli-check-published-manifests.ts [--dir <directory>]
 *
 * By default the manifests are fetched from download.bugsee.com (override the base with
 * BUGSEE_OPTIONS_MANIFEST_BASE). `--dir` reads `<directory>/<platform>/<version>.json` instead, for
 * working offline. An unreachable manifest FAILS the check: a gate that passes when it cannot look is
 * not a gate. The fetch is retried, since the file is immutable and only the network can be flaky.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANIFEST_BASE,
  checkPublished,
  manifestUrl,
  parseManifest,
  type Platform,
  type PublishedOption,
} from './published-manifest.ts';

const root = join(import.meta.dirname, '..');
const options = join(root, 'packages', 'react-native', 'src', 'options');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const pinned = readJson<{ android: { sdk: string }; ios: { sdk: string } }>(
  join(root, 'native-versions.json'),
);
const keys = readJson<{ shared: string[]; ios: string[]; android: string[] }>(
  join(options, 'option-keys.json'),
);
const androidManifest = readJson<{ options: PublishedOption[] }>(
  join(options, 'android-options-manifest.json'),
);

const dirFlag = process.argv.indexOf('--dir');
const dir = dirFlag === -1 ? undefined : process.argv[dirFlag + 1];
const base = process.env.BUGSEE_OPTIONS_MANIFEST_BASE ?? MANIFEST_BASE;

async function load(platform: Platform, version: string): Promise<string> {
  if (dir !== undefined) {
    return readFileSync(join(dir, platform, `${version}.json`), 'utf8');
  }
  const url = manifestUrl(base, platform, version);
  let failure = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        return await response.text();
      }
      failure = `HTTP ${response.status}`;
      // A manifest that is not there will not appear by asking again (the CDN answers a missing
      // key with 403 or 404).
      if (response.status === 403 || response.status === 404) {
        break;
      }
    } catch (error) {
      failure = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw new Error(`could not fetch ${url}: ${failure}`);
}

let failed = false;
for (const platform of ['android', 'ios'] as const) {
  const version = pinned[platform].sdk;
  try {
    const published = parseManifest(await load(platform, version), `${platform} ${version} manifest`);
    const problems = checkPublished({
      platform,
      pinnedVersion: version,
      published,
      knownKeys: [...keys.shared, ...keys[platform]],
      committed: platform === 'android' ? androidManifest.options : undefined,
    });
    if (problems.length === 0) {
      console.log(`${platform} ${version}: aligned (${published.options.length} published options)`);
    } else {
      failed = true;
      console.error(`${platform} ${version}: ${problems.length} misalignment(s)`);
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
    }
  } catch (error) {
    failed = true;
    console.error(`${platform} ${version}: ${(error as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
