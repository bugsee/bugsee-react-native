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
// --tag is required: a default of `latest` would let a forgotten flag put a beta where nobody asked.
//
// Auth is whatever `npm publish` finds: in CI that is the OIDC trusted-publisher exchange (no token);
// for the one-time bootstrap it is NODE_AUTH_TOKEN / ~/.npmrc.
//
// Why `yarn pack` and then `npm publish <tarball>`: yarn 4 runs each package's `prepack`
// (the SNAPSHOT-pin gate and the native-versions staging) and `postpack`, which `npm pack` would run
// too but which a plain `npm publish` of a directory would not stage the same way. Publishing the
// tarball with npm keeps the OIDC path on npm itself (>= 11.5.1), which yarn does not speak.
//
// Idempotent: a re-run after a partial failure skips what is already published. It stops at the
// first failure so a broken package never lets its dependents publish against it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackages } from './check-publishable.mjs';

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = flag('--dry-run');
  const tag = value('--tag');
  if (!tag) {
    console.error('--tag <dist-tag> is required (e.g. --tag beta)');
    process.exit(2);
  }
  const only = value('--only')?.split(',');
  const packages = topologicalOrder(loadPackages()).filter(
    (p) => !only || only.includes(p.json.name),
  );
  // `latest` is what `yarn add <pkg>` installs. A prerelease there makes the beta the default install,
  // and npm will not unpublish it after 72 hours.
  const prereleases = packages.filter((p) => p.json.version.includes('-'));
  if (tag === 'latest' && prereleases.length > 0) {
    console.error(
      `refusing --tag latest for prerelease ${prereleases.map((p) => `${p.json.name}@${p.json.version}`).join(', ')}`,
    );
    process.exit(2);
  }
  const tarballDir = value('--tarballs');
  const out = tarballDir ? resolve(tarballDir) : resolve(value('--pack-to') ?? mkdtempSync(join(tmpdir(), 'bugsee-publish-')));
  mkdirSync(out, { recursive: true });
  let done = 0;
  let skipped = 0;

  for (const { dir, json } of packages) {
    const { name, version } = json;
    if (!dryRun && published(name, version)) {
      console.log(`skip     ${name}@${version} (already on npm)`);
      skipped++;
      continue;
    }
    const cwd = join(root, 'packages', dir);
    const tarball = join(out, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    if (tarballDir) {
      if (!existsSync(tarball)) throw new Error(`${name}: ${tarball} is missing; pack it in the check job first`);
    } else {
      run('yarn', ['pack', '--out', tarball], { cwd });
    }
    const args = ['publish', tarball, '--tag', tag, '--access', 'public'];
    if (dryRun) args.push('--dry-run');
    console.log(`${dryRun ? 'dry-run ' : 'publish '} ${name}@${version} (tag ${tag})`);
    try {
      process.stdout.write(run('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
      done++;
    } catch (error) {
      const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      // The registry accepts a publish (202) and makes it readable a few minutes later, so a re-run can
      // find a package that is "not there" to `npm view` yet but is already published.
      if (/cannot publish over the previously published versions?/i.test(text)) {
        console.log(`skip     ${name}@${version} (accepted earlier; not readable yet)`);
        skipped++;
        continue;
      }
      process.stderr.write(text);
      throw error;
    }
  }
  console.log(
    `\n${done} ${dryRun ? 'checked' : 'published'}, ${skipped} skipped, of ${packages.length}.`,
  );
}
