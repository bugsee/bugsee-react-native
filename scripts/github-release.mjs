#!/usr/bin/env node
// Tag the released commit and publish a GitHub release for it. Runs after the npm publish, in the
// Release workflow's last job, which holds `contents: write` and nothing else.
//
//   node scripts/github-release.mjs --sha <commit> --tarballs <dir> [--npm-tags beta,latest] [--dry-run]
//
// - The tag is `v<version>` (every publishable package ships one version, checked here again), created
//   at the commit the workflow ran on, the one `check` packed and validated.
// - A prerelease version (a hyphen before any +build metadata) is marked as a prerelease.
// - The packed tarballs are attached, so the release carries the exact bytes that went to npm. That holds
//   only if THIS run published them: before creating anything the script compares each tarball's integrity
//   with what npm has for that version, and refuses on a mismatch (a version published earlier from another
//   commit, then a fresh run that skipped the publish as already done). npm may need a few minutes to show a
//   new version, so a not-yet-visible version is retried.
// - Notes: a short header (npm packages, tags, native SDK pins, docs) followed by GitHub's generated
//   notes (the PRs merged since the previous tag).
//
// Idempotent, like publish-all.mjs: a re-run after a partial failure skips what exists. A release that
// already exists is left alone. A tag that already exists at a DIFFERENT commit is an error: a tag is
// never moved, and a mismatch means something other than this release owns that name.
//
// Node built-ins only (no install step in the job that runs it): scripts/__tests__/release-scripts-imports.test.ts
// holds the line. Needs `gh` and `git` on PATH and GH_TOKEN in the environment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, isPrerelease, loadPackages } from './load-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

/** The release notes header. Pure, so it can be read in one place. */
export function notesHeader({ packages, version, npmTags, native }) {
  const lines = [
    `Published to npm as \`${version}\`:`,
    '',
    ...packages.map((p) => `- \`${p.json.name}@${version}\``),
    '',
  ];
  if (npmTags.length > 0) lines.push(`npm dist-tags: ${npmTags.map((t) => `\`${t}\``).join(', ')}.`, '');
  lines.push(`\`npm install ${packages[0]?.json.name}@${version}\``, '');
  if (native?.android && native?.ios) {
    lines.push(
      `Native SDKs: Android SDK ${native.android.sdk} (Gradle plugin ${native.android.gradlePlugin}), iOS SDK ${native.ios.sdk}.`,
      '',
    );
  }
  lines.push('Documentation: https://docs.bugsee.com/sdk/react_native/overview', '');
  return lines.join('\n');
}

/** What the release needs, from the repository: the version, tag name, prerelease flag, notes header. */
export function plan({ npmTags = [] } = {}) {
  const packages = loadPackages();
  const versions = new Set(packages.map((p) => p.json.version));
  if (versions.size !== 1) {
    throw new Error(`the publishable packages disagree on the version: ${[...versions].sort().join(', ')}`);
  }
  const version = packages[0]?.json.version;
  if (!version) throw new Error('no publishable packages found');
  const nativePath = join(root, 'native-versions.json');
  const native = existsSync(nativePath) ? JSON.parse(readFileSync(nativePath, 'utf8')) : undefined;
  return {
    packages,
    version,
    tag: `v${version}`,
    prerelease: isPrerelease(version),
    notes: notesHeader({ packages, version, npmTags, native }),
  };
}

/** The commit a tag points at on the remote ('' when the tag does not exist). Annotated tags dereference. */
function remoteTagCommit(tag) {
  const out = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const refs = new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/).reverse()),
  );
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? '';
}

/** 'published', 'draft' or 'none'. `gh release view` may or may not find a draft, so isDraft is read from what it finds. */
function releaseState(tag) {
  try {
    const found = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft']) || '{}');
    return found.isDraft ? 'draft' : 'published';
  } catch (error) {
    if (/release not found|not found|HTTP 404/i.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) return 'none';
    throw error; // anything else (auth, network) is not "no release": do not go on to create one blindly
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The registry's integrity string for a file: `sha512-<base64>`, as npm records it for a tarball. */
export const integrityOf = (file) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

/**
 * Refuses unless npm has, for each package at this version, exactly the tarball about to be attached. A version
 * that is not visible yet (E404, the registry takes minutes) is retried; any other failure is an error.
 */
async function verifyPublished(packages, version, tarballDir) {
  const attempts = Number(process.env.VERIFY_ATTEMPTS ?? 12);
  const delay = Number(process.env.VERIFY_RETRY_DELAY_MS ?? 20000);
  for (const { json } of packages) {
    const file = join(resolve(tarballDir), `${json.name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    if (!existsSync(file)) throw new Error(`${json.name}: ${file} is missing from the tarballs`);
    const expected = integrityOf(file);
    let seen;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        seen = run('npm', ['view', `${json.name}@${version}`, 'dist.integrity', '--prefer-online']).trim();
        break;
      } catch (error) {
        const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        if (!/E404|not found/i.test(text)) throw error;
        if (attempt === attempts) throw new Error(`${json.name}@${version} is not visible on npm after ${attempts} attempts`, { cause: error });
        await sleep(delay);
      }
    }
    if (seen !== expected) {
      throw new Error(
        `${json.name}@${version} on npm (${seen}) is not the tarball this run packed (${expected}): the version was published from a different commit. Not creating a release.`,
      );
    }
    console.log(`verified ${json.name}@${version} matches the tarball`);
  }
}

/** Whether an unpublished (draft) release for the tag exists: `gh release view` only finds published ones. */
function draftExists(tag) {
  const releases = JSON.parse(run('gh', ['release', 'list', '--limit', '200', '--json', 'tagName,isDraft']) || '[]');
  return releases.some((r) => r.tagName === tag && r.isDraft);
}

if (isEntryPoint(import.meta.url)) {
  const sha = value('--sha');
  const tarballDir = value('--tarballs');
  const npmTags = [...new Set((value('--npm-tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
  const dryRun = argv.includes('--dry-run');
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    console.error('--sha <40-hex commit> is required');
    process.exit(2);
  }
  const { packages, version, tag, prerelease, notes } = plan({ npmTags });
  const assets = tarballDir
    ? readdirSync(resolve(tarballDir))
        .filter((f) => f.endsWith('.tgz'))
        .sort()
        .map((f) => join(resolve(tarballDir), f))
    : [];

  console.log(`release ${tag} (${prerelease ? 'prerelease' : 'stable'}) at ${sha}, ${assets.length} tarball(s)`);
  if (dryRun) {
    console.log(notes);
    process.exit(0);
  }

  const state = releaseState(tag);
  if (state === 'published') {
    console.log(`skip     release ${tag} already exists`);
    process.exit(0);
  }
  // A DRAFT (a failed asset upload leaves one) is not complete: skipping it would report success with the release
  // unpublished, creating a second release for the tag would be wrong, and deleting someone's draft is not this
  // script's call. `gh release view` may not see a draft at all, so the draft list is checked as well.
  if (state === 'draft' || draftExists(tag)) {
    console.error(`a draft release for ${tag} exists (an earlier run did not finish): publish or delete it, then re-run.`);
    process.exit(1);
  }
  if (!tarballDir) {
    console.error('--tarballs <dir> is required for a real release: it is what gets attached and verified against npm');
    process.exit(2);
  }
  try {
    await verifyPublished(packages, version, tarballDir);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const tagged = remoteTagCommit(tag);
  if (tagged && tagged.toLowerCase() !== sha.toLowerCase()) {
    console.error(`${tag} already exists at ${tagged}, not at ${sha}. A tag is never moved: resolve it by hand.`);
    process.exit(1);
  }
  // With an existing tag at this commit gh reuses it; otherwise gh creates the tag at --target.
  const args = ['release', 'create', tag, ...assets, '--target', sha, '--title', tag, '--generate-notes', '--notes', notes];
  if (prerelease) args.push('--prerelease');
  process.stdout.write(run('gh', args));
  console.log(`created  release ${tag}${tagged ? ' (tag already existed at this commit)' : ' and its tag'} for ${version}`);
}
