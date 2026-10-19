import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * publish-all.mjs run against a stub `npm` that answers from environment variables and logs every
 * call, so the dist-tag rules are exercised without a registry.
 */
const root = join(__dirname, '..', '..');
const script = join(root, 'scripts', 'publish-all.mjs');
const names = ['@bugsee/react-native', '@bugsee/react-native-feedback'];

function run(args: string[], env: { latest?: string; viewFails?: string; tagFails?: boolean; publishFails?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-all-'));
  const log = join(dir, 'calls.log');
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs);
  for (const name of names) {
    writeFileSync(join(tarballs, `${name.replace('@', '').replace('/', '-')}-7.0.0-beta1.tgz`), '');
  }
  const stub = join(dir, 'npm');
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  view)
    case "$2" in
      *@7.0.0-beta1) echo "npm error code E404" >&2; exit 1;;
    esac
    if [ -n "$STUB_VIEW_FAILS" ]; then echo "npm error code $STUB_VIEW_FAILS" >&2; exit 1; fi
    echo "$STUB_LATEST"; exit 0;;
  dist-tag) [ -n "$STUB_TAG_FAILS" ] && { echo "npm error code E403" >&2; exit 1; }; exit 0;;
  publish) [ -n "$STUB_PUBLISH_FAILS" ] && { echo "npm error code E500" >&2; exit 1; }; exit 0;;
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
    expect(r.stderr).toContain('npm dist-tag add @bugsee/react-native@7.0.0-beta1 latest');
    expect(r.stderr).toContain('npm dist-tag add @bugsee/react-native-feedback@7.0.0-beta1 latest');
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
