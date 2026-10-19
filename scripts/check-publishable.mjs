#!/usr/bin/env node
// Release gate: every publishable package is public, carries the metadata npm needs, and the set ships
// ONE version. The wrapper reports its own package.json version to the SDK (`src/version.ts`, the
// Android `WRAPPER_VERSION` build field, the podspec), so a package left behind at another version
// would claim the wrong one in every report.
//
//   node scripts/check-publishable.mjs          # exits 1 and lists every violation
//   node scripts/check-publishable.mjs --list   # print the publishable package names, one per line
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_README_CHARS = 400;
const REPO_URL = 'git+https://github.com/bugsee/bugsee-react-native.git';

export function loadPackages() {
  return readdirSync(join(root, 'packages'))
    .map((dir) => ({
      dir,
      json: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')),
    }))
    .filter(({ json }) => !json.private);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = loadPackages();
  if (process.argv.includes('--list')) {
    for (const { json } of packages) console.log(json.name);
    process.exit(0);
  }

  const errors = [];
  const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8');
  if (!/^MIT License/.test(rootLicense)) errors.push('LICENSE: the repository license is not MIT');
  if (packages.length === 0) errors.push('no publishable packages found');

  const versions = new Set(packages.map(({ json }) => json.version));
  if (versions.size > 1)
    errors.push(`packages disagree on the version: ${[...versions].sort().join(', ')}`);
  const version = packages[0]?.json.version;
  if (version === '0.0.0') errors.push('version is still the 0.0.0 placeholder');

  for (const { dir, json } of packages) {
    const where = `${json.name} (packages/${dir})`;
    if (json.publishConfig?.access !== 'public')
      errors.push(`${where}: publishConfig.access must be "public"`);
    if (json.repository?.url !== REPO_URL)
      errors.push(`${where}: repository.url must be ${REPO_URL}`);
    if (json.repository?.directory !== `packages/${dir}`)
      errors.push(`${where}: repository.directory must be packages/${dir}`);
    if (json.license !== 'MIT') errors.push(`${where}: license must be "MIT" (is ${json.license})`);
    const licensePath = join(root, 'packages', dir, 'LICENSE');
    if (!existsSync(licensePath)) errors.push(`${where}: LICENSE file missing`);
    else if (readFileSync(licensePath, 'utf8') !== rootLicense)
      errors.push(`${where}: LICENSE differs from the repository LICENSE`);
    // The README is the npm page. A one-line placeholder published as-is is what this catches.
    const readmePath = join(root, 'packages', dir, 'README.md');
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
    if (readme.length < MIN_README_CHARS)
      errors.push(`${where}: README.md missing or shorter than ${MIN_README_CHARS} characters`);
    else if (!/^#{1,3} Licen[sc]e\b/m.test(readme))
      errors.push(`${where}: README.md has no License section`);
    for (const [dep, range] of Object.entries({
      ...json.dependencies,
      ...json.optionalDependencies,
    })) {
      if (/^(github:|git\+|git:|file:|link:|https?:|workspace:)/.test(range))
        errors.push(`${where}: ${dep} is a non-registry dependency (${range})`);
    }
    // A peer range that does not match this very release makes the pair uninstallable without
    // --force. Semver ranges such as "*" or ">=7" exclude a prerelease like 7.0.0-beta1, so test the
    // range against the sibling's actual version with npm's own rules (no includePrerelease: npm does not
    // use it, so a range it would reject must not pass here), and reject "*" outright.
    for (const { json: other } of packages) {
      const range = json.peerDependencies?.[other.name];
      if (!range) continue;
      if (range === '*' && other.version.includes('-'))
        errors.push(
          `${where}: peer ${other.name}@"*" never matches the prerelease ${other.version}; use ^${other.version}`,
        );
      else if (!semver.satisfies(other.version, range))
        errors.push(`${where}: peer ${other.name}@${range} does not match ${other.version}`);
    }
  }

  if (errors.length) {
    console.error(errors.join('\n'));
    console.error(`\n${errors.length} problem(s).`);
    process.exit(1);
  }
  console.log(`${packages.length} publishable packages, all at ${version}.`);
}
