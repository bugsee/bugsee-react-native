import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs each podspec's real prepare_command with a stand-in `curl`, twice at
 * once, in two package directories: two `pod install`s on one machine (B-4).
 * The download used to go to a fixed /tmp/Bugsee-<version>.zip (and
 * /tmp/feedback-spm-<version>.tar.gz), so concurrent installs overwrote and
 * deleted each other's archive mid-extract ("bad CRC" in the build lane).
 *
 * The stand-in curl refuses to write over a file that already exists and
 * holds the download open for a moment, so two runs that share one path
 * collide every time instead of now and then.
 *
 * Not in the scripts mutation gate's testMatch: it exercises the podspecs,
 * not scripts/*.ts.
 */
const repo = join(__dirname, '..', '..', '..');
const VERSION = '9.9.9-packtest';

function prepareCommand(podspec: string): string {
  const text = readFileSync(join(repo, 'packages', podspec), 'utf8');
  const match = /s\.prepare_command = <<-CMD\n([\s\S]*?)\n\s*CMD\n/.exec(text);
  if (!match) throw new Error(`${podspec}: no prepare_command heredoc`);
  return match[1]!.replace("#{native['ios']['sdk']}", VERSION);
}

const work = mkdtempSync(join(tmpdir(), 'bugsee-prepare-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const bin = join(work, 'bin');
const fixtures = join(work, 'fixtures');

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(fixtures, { recursive: true });

  // The core archive: the framework plus the SDK's own README and LICENSE at
  // the root, which must not be extracted.
  const zipRoot = join(work, 'zip-root');
  mkdirSync(join(zipRoot, 'Bugsee.xcframework'), { recursive: true });
  writeFileSync(join(zipRoot, 'Bugsee.xcframework', 'Info.plist'), 'framework\n');
  writeFileSync(join(zipRoot, 'README.md'), 'sdk readme\n');
  writeFileSync(join(zipRoot, 'LICENSE'), 'sdk licence\n');
  execFileSync('zip', ['-qr', join(fixtures, 'core.zip'), '.'], { cwd: zipRoot });

  // The feedback tag archive, laid out as codeload serves it.
  const tarRoot = join(work, 'tar-root');
  const sources = join(tarRoot, `feedback-spm-${VERSION}`, 'Sources', 'BugseeFeedback');
  mkdirSync(sources, { recursive: true });
  writeFileSync(join(sources, 'Feedback.swift'), '// feedback\n');
  execFileSync('tar', ['-czf', join(fixtures, 'feedback.tar.gz'), '-C', tarRoot, '.']);

  const curl = join(bin, 'curl');
  writeFileSync(
    curl,
    [
      '#!/bin/bash',
      'out=""; url=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac',
      'done',
      '[ -n "$out" ] || { echo "stub curl: no -o" >&2; exit 2; }',
      '[ -n "${STUB_CURL_FAIL:-}" ] && { echo "stub curl: failing on request" >&2; exit 22; }',
      // Another run is writing (or has left) this very file: a shared path.
      // noclobber makes the create exclusive (O_EXCL), so the check and the
      // create cannot interleave with the other run's.
      'if ! ( set -o noclobber; : > "$out" ) 2>/dev/null; then',
      '  echo "stub curl: $out already exists" >&2; exit 23',
      'fi',
      'echo "$out" >> "$STUB_CURL_LOG"',
      'sleep 1',
      'case "$url" in',
      `  *codeload.github.com/bugsee/feedback-spm/*) cat "${join(fixtures, 'feedback.tar.gz')}" > "$out" ;;`,
      `  *download.bugsee.com/*) cat "${join(fixtures, 'core.zip')}" > "$out" ;;`,
      '  *) echo "stub curl: unexpected url $url" >&2; exit 3 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(curl, 0o755);
});

interface Run {
  readonly code: number | null;
  readonly stderr: string;
}

function run(script: string, cwd: string, env: Record<string, string> = {}): Promise<Run> {
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', script], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TMPDIR: join(work, 'tmp'),
        STUB_CURL_LOG: join(work, 'curl.log'),
        ...env,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

beforeEach(() => {
  rmSync(join(work, 'tmp'), { recursive: true, force: true });
  mkdirSync(join(work, 'tmp'), { recursive: true });
  rmSync(join(work, 'curl.log'), { force: true });
  rmSync(join(work, 'pkg'), { recursive: true, force: true });
});

const cases = [
  {
    name: 'BugseeReactNative',
    podspec: join('react-native', 'BugseeReactNative.podspec'),
    product: join('Bugsee.xcframework', 'Info.plist'),
    stamp: '.bugsee-xcframework-version',
  },
  {
    name: 'BugseeReactNativeFeedback',
    podspec: join('react-native-feedback', 'BugseeReactNativeFeedback.podspec'),
    product: join('BugseeFeedbackSources', 'Feedback.swift'),
    stamp: '.bugsee-feedback-sources-version',
  },
] as const;

describe.each(cases)('$name prepare_command', ({ podspec, product, stamp }) => {
  it('two concurrent installs each get their own download', async () => {
    const script = prepareCommand(podspec);
    const a = join(work, 'pkg', 'a');
    const b = join(work, 'pkg', 'b');
    const [first, second] = await Promise.all([run(script, a), run(script, b)]);

    expect(first).toEqual({ code: 0, stderr: '' });
    expect(second).toEqual({ code: 0, stderr: '' });
    for (const dir of [a, b]) {
      expect(existsSync(join(dir, product))).toBe(true);
      expect(readFileSync(join(dir, stamp), 'utf8')).toBe(VERSION);
    }
    const paths = readFileSync(join(work, 'curl.log'), 'utf8').trim().split('\n');
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
  }, 30_000);

  it('downloads under TMPDIR, not a fixed /tmp path, and cleans up after itself', async () => {
    const result = await run(prepareCommand(podspec), join(work, 'pkg', 'one'));

    expect(result.code).toBe(0);
    const [path] = readFileSync(join(work, 'curl.log'), 'utf8').trim().split('\n');
    expect(path!.startsWith(join(work, 'tmp') + '/')).toBe(true);
    expect(readdirSync(join(work, 'tmp'))).toEqual([]);
  }, 30_000);

  it('leaves no partial product, stamp or staging directory when the download fails', async () => {
    const dir = join(work, 'pkg', 'fail');
    const result = await run(prepareCommand(podspec), dir, { STUB_CURL_FAIL: '1' });

    expect(result.code).not.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(join(work, 'tmp'))).toEqual([]);
  }, 30_000);
});

describe('BugseeReactNative prepare_command', () => {
  it('extracts only the framework, not the archive README or LICENSE', async () => {
    const dir = join(work, 'pkg', 'only');
    const result = await run(prepareCommand(join('react-native', 'BugseeReactNative.podspec')), dir);

    expect(result.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['.bugsee-xcframework-version', 'Bugsee.xcframework']);
  }, 30_000);
});
