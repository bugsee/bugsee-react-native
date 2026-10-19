import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * publish-all.mjs run against a stub `npm` that answers from environment variables and logs every
 * call, so the dist-tag rules are exercised without a registry.
 */
const repoScripts = join(__dirname, '..');
const names = ['@bugsee/react-native', '@bugsee/react-native-feedback'];
const dirs: Record<string, string> = {
  '@bugsee/react-native': 'react-native',
  '@bugsee/react-native-feedback': 'react-native-feedback',
};
const VERSION = '7.0.0-beta1';

interface Env {
  latest?: string;
  viewFails?: string;
  tagFails?: boolean;
  publishFails?: boolean;
  version?: string;
  published?: boolean;
  tagAt?: string;
  publishExists?: boolean;
}

function run(args: string[], env: Env) {
  const version = env.version ?? VERSION;
  const dir = mkdtempSync(join(tmpdir(), 'publish-all-'));
  // The script reads package versions from the tree it sits in, so it runs from a temp copy with a
  // fixed version: the suite does not depend on what version the repo is at, and the copy has no
  // node_modules, which the publish job does not have either.
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of ['publish-all.mjs', 'load-packages.mjs']) {
    copyFileSync(join(repoScripts, file), join(root, 'scripts', file));
  }
  for (const name of names) {
    mkdirSync(join(root, 'packages', dirs[name] as string), { recursive: true });
    writeFileSync(join(root, 'packages', dirs[name] as string, 'package.json'), JSON.stringify({ name, version }));
  }
  const script = join(root, 'scripts', 'publish-all.mjs');
  const log = join(dir, 'calls.log');
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs);
  for (const name of names) {
    writeFileSync(join(tarballs, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`), '');
  }
  const stub = join(dir, 'npm');
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  view)
    case "$2" in
      *@${version}) if [ -n "$STUB_PUBLISHED" ]; then echo "${version}"; exit 0; fi; echo "npm error code E404" >&2; exit 1;;
    esac
    if [ -n "$STUB_VIEW_FAILS" ]; then echo "npm error code $STUB_VIEW_FAILS" >&2; exit 1; fi
    case "$3" in
      dist-tags.latest) echo "$STUB_LATEST"; exit 0;;
      dist-tags.*) echo "$STUB_TAG_AT"; exit 0;;
    esac
    echo "$STUB_LATEST"; exit 0;;
  dist-tag) [ -n "$STUB_TAG_FAILS" ] && { echo "npm error code E403" >&2; exit 1; }; exit 0;;
  publish) [ -n "$STUB_PUBLISH_EXISTS" ] && { echo "npm error cannot publish over the previously published versions" >&2; exit 1; }; [ -n "$STUB_PUBLISH_FAILS" ] && { echo "npm error code E500" >&2; exit 1; }; exit 0;;
esac
exit 0
`,
  );
  chmodSync(stub, 0o755);
  const result = spawnSync('node', [script, ...args, '--tarballs', tarballs], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_LATEST: env.latest ?? '',
      STUB_VIEW_FAILS: env.viewFails ?? '',
      STUB_TAG_FAILS: env.tagFails ? '1' : '',
      STUB_PUBLISH_FAILS: env.publishFails ? '1' : '',
      STUB_PUBLISHED: env.published ? '1' : '',
      STUB_TAG_AT: env.tagAt ?? '',
      STUB_PUBLISH_EXISTS: env.publishExists ? '1' : '',
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, calls, stderr: result.stderr };
}

const publishes = (calls: string[]) => calls.filter((c) => c.startsWith('publish'));
const tags = (calls: string[]) => calls.filter((c) => c.startsWith('dist-tag'));

describe('publish-all.mjs dist-tag rules', () => {
  it('refuses --tag latest for a prerelease while latest is a stable release, before publishing', () => {
    const r = run(['--tag', 'latest'], { latest: '7.0.0' });
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });

  it('refuses in a dry run too, so the unprivileged check job shows it before approval', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest', '--dry-run'], { latest: '7.0.0' });
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });

  it('does not apply the prerelease rule to a stable version', () => {
    const r = run(['--tag', 'latest'], { latest: '7.0.0', version: '7.0.1' });
    expect(r.status).toBe(0);
    expect(publishes(r.calls)).toHaveLength(2);
  });

  it('reads build metadata correctly: a stable version with a hyphen in its metadata is stable', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '7.0.0+build-1' });
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });

  it('refuses --also-tag latest the same way', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '7.0.0' });
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });

  it('refuses when it cannot tell what latest points at', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { viewFails: 'E503' });
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });

  it('allows latest when it points at a prerelease or the placeholder', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '0.0.0-stage' });
    expect(r.status).toBe(0);
    expect(publishes(r.calls)).toHaveLength(2);
    expect(tags(r.calls)).toHaveLength(2);
  });

  it('treats a never-published package as allowed', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { viewFails: 'E404' });
    expect(r.status).toBe(0);
  });

  it('moves the extra tag only after every package is published', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '' });
    const firstTag = r.calls.findIndex((c) => c.startsWith('dist-tag'));
    const lastPublish = r.calls.map((c) => c.startsWith('publish')).lastIndexOf(true);
    expect(firstTag).toBeGreaterThan(lastPublish);
  });

  it('publishes everything and exits 3 listing the commands when a tag cannot be moved', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '', tagFails: true });
    expect(publishes(r.calls)).toHaveLength(2);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`npm dist-tag add @bugsee/react-native@${VERSION} latest`);
    expect(r.stderr).toContain(`npm dist-tag add @bugsee/react-native-feedback@${VERSION} latest`);
  });

  it('applies the primary tag to a package that is already on npm, so a re-run with another tag moves it', () => {
    const r = run(['--tag', 'latest'], { latest: '0.0.0-stage', published: true });
    expect(r.status).toBe(0);
    expect(publishes(r.calls)).toEqual([]);
    expect(tags(r.calls)).toEqual([
      `dist-tag add @bugsee/react-native@${VERSION} latest`,
      `dist-tag add @bugsee/react-native-feedback@${VERSION} latest`,
    ]);
  });

  it('does not move a tag the registry already has on the version, so a re-run stays green', () => {
    const r = run(['--tag', 'beta'], { published: true, tagAt: VERSION });
    expect(r.status).toBe(0);
    expect(tags(r.calls)).toEqual([]);
  });

  it('moves a tag that points at another version', () => {
    const r = run(['--tag', 'beta'], { published: true, tagAt: '9.9.9' });
    expect(tags(r.calls)).toHaveLength(2);
  });

  it('applies only the extra tags to a publish accepted earlier but not readable yet', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '', publishExists: true });
    expect(r.status).toBe(0);
    expect(tags(r.calls).every((c) => c.endsWith(' latest'))).toBe(true);
    expect(tags(r.calls)).toHaveLength(2);
  });

  it('moves no tag when a publish fails', () => {
    const r = run(['--tag', 'beta', '--also-tag', 'latest'], { latest: '', publishFails: true });
    expect(r.status).not.toBe(0);
    expect(tags(r.calls)).toEqual([]);
    expect(r.stderr).toContain('no --also-tag was moved');
  });

  it.each(['--registry=https://x', '7.1.0', '-x'])('rejects the extra tag %p when it is not a tag name', (bad) => {
    const r = run(['--tag', 'beta', '--also-tag', bad], {});
    expect(r.status).toBe(2);
    expect(publishes(r.calls)).toEqual([]);
  });
});
