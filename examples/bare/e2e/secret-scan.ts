/**
 * The device half of the campaign secret scan (N-29): pulled bundles are
 * scanned for every token this app could hold before bundles.ts deletes
 * them, so "no token in any pulled bundle" is checked on every run, kept or
 * not. scripts/cli-campaign-secret-scan.ts does the same for logs and kept
 * files after the run, and fails the run on any `SECRET-SCAN FOUND` line
 * this prints.
 *
 * Secrets: the placeholder token, and whatever the app under test's
 * credentials.json and android/bugsee.properties hold (`E2E_APP_DIR`), plus
 * any credentials.json listed in `E2E_SECRET_SCAN_CREDENTIALS` (`:`-separated
 * paths, e.g. the staging worktree's). A finding names where, never what.
 * A finding in a file named in `E2E_SECRET_SCAN_KNOWN` is printed as KNOWN
 * and does not fail the run (campaign-secrets.ts `parseKnown`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Secret,
  describeFinding,
  describeKnown,
  isKnownFile,
  needlesOf,
  parseKnown,
  scanBytes,
  secretsOf,
} from '../../../scripts/campaign-secrets';
import { APP_DIR } from './device';

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The secrets this run could leak (see the top of this file). */
export function runSecrets(): Secret[] {
  const extra = (process.env.E2E_SECRET_SCAN_CREDENTIALS ?? '').split(':').filter(path => path !== '');
  return secretsOf([
    {
      origin: 'app',
      json: readIf(join(APP_DIR, 'credentials.json')),
      properties: readIf(join(APP_DIR, 'android', 'bugsee.properties')),
    },
    ...extra.map(path => ({ origin: path, json: readIf(path) })),
  ]);
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path).flatMap(name => filesUnder(join(path, name)));
}

/**
 * Scans every file under `paths`; prints one `SECRET-SCAN FOUND` line per
 * finding and a summary, and returns the finding lines. Throws when
 * `E2E_SECRET_SCAN_STRICT=1` and something was found.
 */
export function scanPaths(paths: readonly string[], what = 'pulled bundles'): string[] {
  const needles = needlesOf(runSecrets());
  // A pulled `.bundle.zip` is also extracted next to itself, and the
  // extracted files are what a finding should name (and what
  // E2E_SECRET_SCAN_KNOWN matches); its stored entries would only repeat them.
  const files = paths.flatMap(filesUnder).filter(file => !file.endsWith('.bundle.zip'));
  const known = parseKnown(process.env.E2E_SECRET_SCAN_KNOWN);
  const found: string[] = [];
  const accepted: string[] = [];
  for (const file of files) {
    for (const finding of scanBytes(readFileSync(file), needles)) {
      if (isKnownFile(file, known)) {
        accepted.push(describeKnown(file, finding));
      } else {
        found.push(describeFinding(file, finding));
      }
    }
  }
  for (const line of [...found, ...accepted]) {
    console.log(line);
  }
  console.log(`SECRET-SCAN ${what}: ${files.length} file(s), ${found.length} finding(s), ${accepted.length} known`);
  if (found.length > 0 && process.env.E2E_SECRET_SCAN_STRICT === '1') {
    throw new Error(`secret scan: ${found.length} finding(s) in ${what}:\n${found.join('\n')}`);
  }
  return found;
}
