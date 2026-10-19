#!/usr/bin/env node
// Publish every publishable package, dependencies first, skipping versions already on npm.
//
//   node scripts/publish-all.mjs --dry-run --tag beta   # pack + `npm publish --dry-run`, publishes nothing
//   node scripts/publish-all.mjs --tag beta             # publish under a dist-tag
//   node scripts/publish-all.mjs --only @bugsee/react-native
//   node scripts/publish-all.mjs --tag beta --dry-run --pack-to DIR   # also keep the tarballs in DIR
//   node scripts/publish-all.mjs --tag beta --tarballs DIR            # publish the tarballs in DIR, pack nothing
//
// --pack-to / --tarballs split the release in two: a job without publish rights packs and validates,
// and the job that holds the OIDC token publishes exactly those bytes, with no install step of its
// own (a dependency's install script could otherwise ask for the token).
//
// --tag is required, with no default: which tag a release moves is always a deliberate choice. A
// prerelease may be `latest` (the SDK is itself a beta, so the first beta is the default install).
//
// Auth is whatever `npm publish` finds: in CI that is the OIDC trusted-publisher exchange (no token);
// for the one-time bootstrap it is NODE_AUTH_TOKEN / ~/.npmrc.
//
// Why `yarn pack` and then `npm publish <tarball>`: yarn 4 runs each package's `prepack`
// (the SNAPSHOT-pin gate and the native-versions staging) and `postpack`, which `npm pack` would run
// too but which a plain `npm publish` of a directory would not stage the same way. Publishing the
// tarball with npm keeps the OIDC path on npm itself (>= 11.5.1), which yarn does not speak.
//
//   node scripts/publish-all.mjs --tag beta --also-tag latest        # then point `latest` at the same version
//
// `npm publish` moves exactly one dist-tag. --also-tag adds the others with `npm dist-tag add`, once
// EVERY package is published (also for a version already on npm, so a re-run repairs a tag left
// behind; for such a package the primary --tag is applied the same way, so re-running with another --tag
// moves it instead of succeeding and doing nothing). If a publish fails, no extra tag is moved. (`--tag` itself is set by `npm publish`, package
// by package: with `--tag latest` a failure part-way leaves `latest` split until a re-run, which is safe
// because publishing is idempotent.) If a tag step fails the packages are still published; the failures are listed at the end
// (exit 3) with the command to run by hand. Moving a tag needs the publisher's dist-tag right, which a
// trusted-publisher token may not carry.
//
// Whenever `latest` would be set (as --tag or --also-tag) to a prerelease, the script checks first that
// `latest` does not currently point at a stable release, and refuses before anything is published if it
// does or if it cannot tell (a registry error other than "never published").
//
// Needs Node 22.18+ (npm-trust-all.mjs loads a .ts module through type stripping).
// Idempotent: a re-run after a partial failure skips what is already published. It stops at the
// first failure so a broken package never lets its dependents publish against it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, loadPackages } from './load-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });

/** Dependencies before dependents, so a package never publishes ahead of what it needs. */
export function topologicalOrder(packages) {
  const byName = new Map(packages.map((p) => [p.json.name, p]));
  const ordered = [];
  const state = new Map();
  const visit = (pkg) => {
    const seen = state.get(pkg.json.name);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`dependency cycle through ${pkg.json.name}`);
    state.set(pkg.json.name, 'visiting');
    const deps = {
      ...pkg.json.dependencies,
      ...pkg.json.optionalDependencies,
      ...pkg.json.peerDependencies,
    };
    for (const name of Object.keys(deps).sort()) if (byName.has(name)) visit(byName.get(name));
    state.set(pkg.json.name, 'done');
    ordered.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.json.name.localeCompare(b.json.name)))
    visit(pkg);
  return ordered;
}

const published = (name, version) => {
  try {
    // stderr is piped, not inherited: a never-published package is an expected E404 here, and npm's
    // red error text for it reads like a failed publish.
    return (
      run('npm', ['view', `${name}@${version}`, 'version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() === version
    );
  } catch {
    return false; // E404: never published
  }
};

const tagFailures = [];

/** A prerelease has a hyphen before any `+build` metadata: `1.0.0+build-1` is stable, `1.0.0-beta.1+x` is not. */
export const isPrerelease = (version) => (version.split('+', 1)[0] ?? '').includes('-');

/** A dist-tag name npm will take as a tag: not an option (leading dash), not a version. */
export const isTagName = (t) => /^[a-z][a-z0-9._-]*$/i.test(t) && !/^v?\d/.test(t);

/**
 * What `latest` points at: 'none' (never published), 'prerelease' (a prerelease or the 0.0.0-stage
 * placeholder), 'stable', or 'unknown' when the registry could not be read. 'unknown' counts as a refusal.
 */
function latestState(name) {
  try {
    const current = run('npm', ['view', name, 'dist-tags.latest', '--prefer-online'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!current) return 'none';
    return isPrerelease(current) ? 'prerelease' : `stable ${current}`;
  } catch (error) {
    return /E404/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`) ? 'none' : 'unknown';
  }
}

/** Why `latest` may not be set to this prerelease, or undefined when it may. */
function latestRefusal(name, version) {
  const state = latestState(name);
  if (state === 'unknown') return `${name}: cannot read what latest points at, so not moving it to ${version}`;
  if (state.startsWith('stable')) return `${name}: latest is ${state}; refusing to move it to prerelease ${version}`;
  return undefined;
}

/**
 * True when the registry already has `tag` on `version`. Skipping then keeps a re-run from failing on
 * a redundant move (`npm dist-tag add` needs the dist-tag right even when nothing changes, which a
 * trusted-publisher token may not carry). A read error is "unknown": the move is attempted.
 */
function tagAlreadyAt(name, tag, version) {
  try {
    return (
      run('npm', ['view', name, `dist-tags.${tag}`, '--prefer-online'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() === version
    );
  } catch {
    return false;
  }
}

/**
 * Points each extra dist-tag at this version. Idempotent. Failures are collected, never thrown, so a
 * tag problem cannot stop a package from publishing; run only after the whole set is published.
 */
function addTags(name, version, tags, dryRun) {
  for (const extra of tags) {
    console.log(`${dryRun ? 'dry-run ' : 'tag     '} ${name}@${version} -> ${extra}`);
    if (dryRun) continue;
    if (tagAlreadyAt(name, extra, version)) {
      console.log(`         ${name}: ${extra} already points at ${version}`);
      continue;
    }
    try {
      run('npm', ['dist-tag', 'add', `${name}@${version}`, extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`);
      tagFailures.push(`${name}@${version}: run \`npm dist-tag add ${name}@${version} ${extra}\``);
    }
  }
}

if (isEntryPoint(import.meta.url)) {
  const dryRun = flag('--dry-run');
  const tag = value('--tag');
  if (!tag) {
    console.error('--tag <dist-tag> is required (e.g. --tag beta)');
    process.exit(2);
  }
  const only = value('--only')?.split(',');
  const alsoTags = (value('--also-tag')?.split(',') ?? []).map((t) => t.trim()).filter((t) => t && t !== tag);
  for (const name of [tag, ...alsoTags]) {
    if (!isTagName(name)) {
      console.error(`not a usable dist-tag: ${JSON.stringify(name)}`);
      process.exit(2);
    }
  }
  const packages = topologicalOrder(loadPackages()).filter(
    (p) => !only || only.includes(p.json.name),
  );

  // Before anything is published, and in a dry run too (it only reads): `latest` may only take a
  // prerelease when it does not now point at a stable release (see the header), so a refusal shows in
  // the unprivileged check job, before anyone approves the publish.
  if ([tag, ...alsoTags].includes('latest')) {
    const refusals = packages
      .filter((p) => isPrerelease(p.json.version))
      .map((p) => latestRefusal(p.json.name, p.json.version))
      .filter(Boolean);
    if (refusals.length > 0) {
      for (const refusal of refusals) console.error(refusal);
      process.exit(2);
    }
  }

  const tarballDir = value('--tarballs');
  const out = tarballDir
    ? resolve(tarballDir)
    : resolve(value('--pack-to') ?? mkdtempSync(join(tmpdir(), 'bugsee-publish-')));
  mkdirSync(out, { recursive: true });
  let done = 0;
  let skipped = 0;
  const settled = []; // every package that is now on npm at its version, to tag once all are

  try {
    for (const { dir, json } of packages) {
      const { name, version } = json;
      if (!dryRun && published(name, version)) {
        console.log(`skip     ${name}@${version} (already on npm)`);
        skipped++;
        settled.push({ name, version, alreadyThere: true });
        continue;
      }
      const cwd = join(root, 'packages', dir);
      const tarball = join(out, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
      if (tarballDir) {
        if (!existsSync(tarball)) {
          throw new Error(`${name}: ${tarball} is missing; pack it in the check job first`);
        }
      } else {
        run('yarn', ['pack', '--out', tarball], { cwd });
      }
      const args = ['publish', tarball, '--tag', tag, '--access', 'public'];
      if (dryRun) args.push('--dry-run');
      console.log(`${dryRun ? 'dry-run ' : 'publish '} ${name}@${version} (tag ${tag})`);
      try {
        process.stdout.write(run('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
        done++;
        settled.push({ name, version });
      } catch (error) {
        const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        // The registry accepts a publish (202) and makes it readable a few minutes later, so a re-run can
        // find a package that is "not there" to `npm view` yet but is already published.
        if (/cannot publish over the previously published versions?/i.test(text)) {
          console.log(`skip     ${name}@${version} (accepted earlier; not readable yet)`);
          skipped++;
          settled.push({ name, version, alreadyThere: true });
          continue;
        }
        process.stderr.write(text);
        throw error;
      }
    }
  } catch (error) {
    if (alsoTags.length > 0 || tag === 'latest') console.error(
      `\nA publish failed: no --also-tag was moved${tag === 'latest' ? '; `latest` may already point at an earlier package of the set, so re-run to finish' : ''}.`,
    );
    throw error;
  }

  // A package that was already on npm was not touched by `npm publish`, so its primary tag is applied
  // here too: a re-run with a different --tag moves it instead of reporting success and doing nothing.
  for (const { name, version, alreadyThere } of settled) {
    addTags(name, version, alreadyThere ? [tag, ...alsoTags] : alsoTags, dryRun);
  }
  console.log(
    `\n${done} ${dryRun ? 'checked' : 'published'}, ${skipped} skipped, of ${packages.length}.`,
  );
  if (tagFailures.length > 0) {
    console.error('\nEvery package is published, but a tag was not moved:');
    for (const failure of tagFailures) console.error(`  ${failure}`);
    process.exit(3);
  }
}
