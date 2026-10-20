#!/usr/bin/env node
// Tag the released commit and publish a GitHub release for it. Runs after the npm publish, in the
// Release workflow's last job, which holds `contents: write` and nothing else.
//
//   node scripts/github-release.mjs --sha <commit> --tarballs <dir> [--npm-tags beta,latest] [--dry-run]
//
// - The tag is `v<version>` (every publishable package ships one version, checked here again), created
//   at the commit the workflow ran on, the one `check` packed and validated.
// - A prerelease version (a hyphen before any +build metadata) is marked as a prerelease.
// - The packed tarballs are attached, so the release carries the exact bytes that went to npm.
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

function releaseExists(tag) {
  try {
    run('gh', ['release', 'view', tag, '--json', 'tagName']);
    return true;
  } catch (error) {
    if (/release not found|not found|HTTP 404/i.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) return false;
    throw error; // anything else (auth, network) is not "no release": do not go on to create one blindly
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
  const { version, tag, prerelease, notes } = plan({ npmTags });
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

  if (releaseExists(tag)) {
    console.log(`skip     release ${tag} already exists`);
    process.exit(0);
  }
  // A published release is found above; a DRAFT is not (a failed asset upload leaves one). Creating a second
  // release for the tag would be wrong and deleting someone's draft is not this script's call: stop and say so.
  if (draftExists(tag)) {
    console.error(`a draft release for ${tag} exists (an earlier run did not finish): publish or delete it, then re-run.`);
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
