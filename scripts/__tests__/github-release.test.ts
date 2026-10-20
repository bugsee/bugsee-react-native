import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * github-release.mjs run against stub `gh` and `git` that answer from environment variables and log every
 * call, from a temp tree with fixed package versions (so the suite does not depend on the repo's version, and,
 * like the release job, the tree has no node_modules).
 */
const repoScripts = join(__dirname, '..');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
// Both fake tarballs are empty files.
const EMPTY_INTEGRITY = `sha512-${createHash('sha512').update('').digest('base64')}`;

interface Setup {
  versions?: [string, string];
  releaseExists?: boolean;
  releaseLookupFails?: boolean;
  draftExists?: boolean;
  remoteTag?: string; // the sha `git ls-remote` prints on refs/tags/<tag>; '' = no tag
  remoteTagDeref?: string; // the sha it prints on refs/tags/<tag>^{} (an annotated tag's commit)
  npm?: 'match' | 'mismatch' | 'notfound' | 'late' | 'error'; // what `npm view ... dist.integrity` answers (default match)
  args?: string[];
  npmTags?: string;
  tarballs?: boolean;
}

function run(setup: Setup = {}) {
  const versions = setup.versions ?? ['7.0.0-beta3', '7.0.0-beta3'];
  const dir = mkdtempSync(join(tmpdir(), 'github-release-'));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of ['github-release.mjs', 'load-packages.mjs']) {
    copyFileSync(join(repoScripts, file), join(root, 'scripts', file));
  }
  const names: [string, string][] = [
    ['react-native', '@bugsee/react-native'],
    ['react-native-feedback', '@bugsee/react-native-feedback'],
  ];
  names.forEach(([d, name], i) => {
    mkdirSync(join(root, 'packages', d), { recursive: true });
    writeFileSync(join(root, 'packages', d, 'package.json'), JSON.stringify({ name, version: versions[i] }));
  });
  writeFileSync(
    join(root, 'native-versions.json'),
    JSON.stringify({ android: { sdk: '7.4.2', gradlePlugin: '4.0.8' }, ios: { sdk: '7.0.0-beta7' } }),
  );
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs);
  if (setup.tarballs !== false) {
    writeFileSync(join(tarballs, `bugsee-react-native-${versions[0]}.tgz`), '');
    writeFileSync(join(tarballs, `bugsee-react-native-feedback-${versions[1]}.tgz`), '');
  }
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
{ printf 'gh'; for a in "$@"; do printf ' %s' "$(printf '%s' "$a" | tr '\n' ' ')"; done; echo; } >> "${log}"
if [ "$1 $2" = "release view" ]; then
  [ -n "$STUB_LOOKUP_FAILS" ] && { echo "HTTP 401: Bad credentials" >&2; exit 1; }
  [ -n "$STUB_RELEASE_EXISTS" ] && { echo '{"tagName":"x"}'; exit 0; }
  echo "release not found" >&2; exit 1
fi
if [ "$1 $2" = "release list" ]; then
  [ -n "$STUB_DRAFT_EXISTS" ] && echo '[{"tagName":"v7.0.0-beta3","isDraft":true}]' || echo '[]'
  exit 0
fi
exit 0
`,
  );
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
{ printf 'git'; for a in "$@"; do printf ' %s' "$a"; done; echo; } >> "${log}"
if [ "$1" = "ls-remote" ]; then
  tag="\${4#refs/tags/}"
  [ -n "$STUB_REMOTE_TAG" ] && printf '%s\trefs/tags/%s\n' "$STUB_REMOTE_TAG" "$tag"
  [ -n "$STUB_REMOTE_TAG_DEREF" ] && printf '%s\trefs/tags/%s^{}\n' "$STUB_REMOTE_TAG_DEREF" "$tag"
fi
exit 0
`,
  );
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
{ printf 'npm'; for a in "$@"; do printf ' %s' "$a"; done; echo; } >> "${log}"
count_file="${dir}/npm-count"
n=$(cat "$count_file" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$count_file"
case "$STUB_NPM" in
  mismatch) echo "sha512-DIFFERENT"; exit 0;;
  notfound) echo "npm error code E404" >&2; exit 1;;
  error) echo "npm error code E503" >&2; exit 1;;
  late) if [ "$n" -le 2 ]; then echo "npm error code E404" >&2; exit 1; fi; echo "${EMPTY_INTEGRITY}"; exit 0;;
  *) echo "${EMPTY_INTEGRITY}"; exit 0;;
esac
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
  const args = setup.args ?? ['--sha', SHA, '--tarballs', tarballs, '--npm-tags', setup.npmTags ?? 'beta,latest'];
  const result = spawnSync('node', [join(root, 'scripts', 'github-release.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_RELEASE_EXISTS: setup.releaseExists ? '1' : '',
      STUB_LOOKUP_FAILS: setup.releaseLookupFails ? '1' : '',
      STUB_REMOTE_TAG: setup.remoteTag ?? '',
      STUB_REMOTE_TAG_DEREF: setup.remoteTagDeref ?? '',
      STUB_NPM: setup.npm ?? 'match',
      VERIFY_ATTEMPTS: '4',
      VERIFY_RETRY_DELAY_MS: '10',
      STUB_DRAFT_EXISTS: setup.draftExists ? '1' : '',
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, calls, stdout: result.stdout, stderr: result.stderr };
}

const creates = (calls: string[]) => calls.filter((c) => c.startsWith('gh release create'));

describe('github-release.mjs', () => {
  it('creates the release and its tag at the commit, as a prerelease for a beta, with the tarballs attached', () => {
    const r = run();
    expect(r.status).toBe(0);
    const [create] = creates(r.calls);
    expect(create).toContain('release create v7.0.0-beta3');
    expect(create).toContain(`--target ${SHA}`);
    expect(create).toContain('--prerelease');
    expect(create).toContain('--generate-notes');
    expect(create).toContain('bugsee-react-native-7.0.0-beta3.tgz');
    expect(create).toContain('bugsee-react-native-feedback-7.0.0-beta3.tgz');
  });

  it('puts the packages, dist-tags and native pins in the notes', () => {
    const r = run();
    const notes = (creates(r.calls)[0] ?? '').split('--notes ')[1] ?? '';
    expect(notes).toContain('@bugsee/react-native@7.0.0-beta3');
    expect(notes).toContain('@bugsee/react-native-feedback@7.0.0-beta3');
    expect(notes).toContain('`beta`, `latest`');
    expect(notes).toContain('Android SDK 7.4.2 (Gradle plugin 4.0.8), iOS SDK 7.0.0-beta7');
  });

  it('does not mark a stable version as a prerelease', () => {
    const r = run({ versions: ['7.1.0', '7.1.0'] });
    expect(r.status).toBe(0);
    expect(creates(r.calls)[0]).toContain('release create v7.1.0');
    expect(creates(r.calls)[0]).not.toContain('--prerelease');
  });

  it('leaves an existing release alone (a re-run is green)', () => {
    const r = run({ releaseExists: true });
    expect(r.status).toBe(0);
    expect(creates(r.calls)).toEqual([]);
  });

  it('refuses to go on when it cannot tell whether the release exists', () => {
    const r = run({ releaseLookupFails: true });
    expect(r.status).not.toBe(0);
    expect(creates(r.calls)).toEqual([]);
  });

  it('stops, creating nothing, when an unfinished draft release exists for the tag', () => {
    const r = run({ draftExists: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('draft release');
    expect(creates(r.calls)).toEqual([]);
  });

  it('lists each dist-tag once in the notes', () => {
    const r = run({ npmTags: 'beta,latest,beta,' });
    const notes = (creates(r.calls)[0] ?? '').split('--notes ')[1] ?? '';
    expect(notes.match(/`beta`/g)).toHaveLength(1);
  });

  it('fails, creating nothing, when the tag already exists at a different commit', () => {
    const r = run({ remoteTag: OTHER });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('never moved');
    expect(creates(r.calls)).toEqual([]);
  });

  it('reuses a tag that already exists at the same commit', () => {
    const r = run({ remoteTag: SHA });
    expect(r.status).toBe(0);
    expect(creates(r.calls)).toHaveLength(1);
    expect(r.stdout).toContain('tag already existed at this commit');
  });

  it('verifies each tarball against npm before creating anything', () => {
    const r = run();
    expect(r.calls.filter((c) => c.startsWith('npm view'))).toHaveLength(2);
    expect(r.stdout).toContain('verified @bugsee/react-native@7.0.0-beta3');
  });

  it('refuses, creating nothing, when npm has a different tarball for the version', () => {
    const r = run({ npm: 'mismatch' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('published from a different commit');
    expect(creates(r.calls)).toEqual([]);
  });

  it('retries a version npm does not show yet, then succeeds', () => {
    const r = run({ npm: 'late' });
    expect(r.status).toBe(0);
    expect(creates(r.calls)).toHaveLength(1);
  });

  it('gives up, creating nothing, when the version never shows up on npm', () => {
    const r = run({ npm: 'notfound' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not visible on npm');
    expect(creates(r.calls)).toEqual([]);
  });

  it('does not retry an npm failure that is not "not found"', () => {
    const r = run({ npm: 'error' });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c.startsWith('npm view'))).toHaveLength(1);
    expect(creates(r.calls)).toEqual([]);
  });

  it('reuses an annotated tag whose commit matches (the tag object has its own sha)', () => {
    const r = run({ remoteTag: OTHER, remoteTagDeref: SHA });
    expect(r.status).toBe(0);
    expect(creates(r.calls)).toHaveLength(1);
  });

  it('fails when an annotated tag points at a different commit, whatever its own sha is', () => {
    const r = run({ remoteTag: SHA, remoteTagDeref: OTHER });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('never moved');
    expect(creates(r.calls)).toEqual([]);
  });

  it('requires the tarballs for a real release', () => {
    expect(run({ args: ['--sha', SHA] }).status).toBe(2);
  });

  it('refuses packages that disagree on the version', () => {
    const r = run({ versions: ['7.0.0-beta3', '7.0.0-beta2'] });
    expect(r.status).not.toBe(0);
    expect(creates(r.calls)).toEqual([]);
  });

  it('requires a full commit sha', () => {
    expect(run({ args: ['--sha', 'main'] }).status).toBe(2);
    expect(run({ args: [] }).status).toBe(2);
  });

  it('prints the plan and creates nothing in a dry run', () => {
    const r = run({ args: ['--sha', SHA, '--dry-run'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('release v7.0.0-beta3 (prerelease)');
    expect(creates(r.calls)).toEqual([]);
  });
});
