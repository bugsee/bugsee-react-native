import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The podspec's `prepare_command` is what puts Bugsee.xcframework into the
 * pod. `BUGSEE_IOS_XCFRAMEWORK_ZIP` lets it take a locally built zip instead
 * of downloading one -- needed while an SDK version is pinned before it is
 * published (3.P2).
 *
 * The danger is not the override working; it is the override LINGERING. A
 * local build stamped like the published one would satisfy the version cache
 * forever, and every later `pod install` -- a teammate's, CI's -- would ship
 * it silently. These run the real command, as Ruby evaluates it from the
 * podspec, with a `curl` on PATH that records the call and fails, so "it
 * downloaded" and "it did not" are both observable.
 */
const podspecPath = join(
  __dirname, '..', '..', 'packages', 'react-native', 'BugseeReactNative.podspec',
);
const VERSION = (JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'native-versions.json'), 'utf8'),
) as { ios: { sdk: string } }).ios.sdk;

/**
 * Evaluates the podspec with Ruby, against a stub `Pod::Spec` that records
 * attributes, and returns `prepare_command` exactly as CocoaPods would get it
 * -- interpolation, escapes and all. No regex over Ruby source.
 */
const EVAL_SPEC = `
module Pod
  class Spec
    attr_reader :attrs
    def initialize
      @attrs = {}
      yield self
    end
    def method_missing(name, *args)
      @attrs[name.to_s.chomp('=')] = args.first
    end
    def respond_to_missing?(*) = true
  end
end
path = ARGV.fetch(0)
print eval(File.read(path), TOPLEVEL_BINDING, path).attrs.fetch('prepare_command')
`;

function prepareCommand(overrideZip?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUGSEE_IOS_XCFRAMEWORK_ZIP;
  if (overrideZip !== undefined) env.BUGSEE_IOS_XCFRAMEWORK_ZIP = overrideZip;
  const r = spawnSync('ruby', ['-e', EVAL_SPEC, podspecPath], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`evaluating the podspec failed: ${r.stderr}`);
  return r.stdout;
}

let root: string;
let pod: string;
let bin: string;
let curlLog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podspec-override-'));
  pod = join(root, 'pod');
  bin = join(root, 'bin');
  curlLog = join(root, 'curl.log');
  mkdirSync(pod);
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh\necho "$@" >> '${curlLog}'\necho 'curl shim: no network in tests' >&2\nexit 22\n`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A zip laid out like the published one: the xcframework plus README/LICENSE. */
function localZip(marker: string, name = 'bugsee-spm-xcframework.zip'): string {
  const staging = join(root, `staging-${marker}`);
  mkdirSync(join(staging, 'Bugsee.xcframework'), { recursive: true });
  writeFileSync(join(staging, 'Bugsee.xcframework', 'Info.plist'), marker);
  writeFileSync(join(staging, 'README.md'), 'readme');
  writeFileSync(join(staging, 'LICENSE'), 'license');
  const zip = join(root, name);
  rmSync(zip, { force: true });
  const r = spawnSync('zip', ['-qr', zip, 'Bugsee.xcframework', 'README.md', 'LICENSE'], {
    cwd: staging,
  });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  return zip;
}

function sha256Prefix(file: string): string {
  const r = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' });
  return r.stdout.slice(0, 16);
}

function run(overrideZip?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.BUGSEE_IOS_XCFRAMEWORK_ZIP;
  if (overrideZip !== undefined) env.BUGSEE_IOS_XCFRAMEWORK_ZIP = overrideZip;
  // Evaluated under the same environment `pod install` would see.
  return spawnSync('bash', ['-c', prepareCommand(overrideZip)], { cwd: pod, env, encoding: 'utf8' });
}

const stamp = () => readFileSync(join(pod, '.bugsee-xcframework-version'), 'utf8');
const curlCalled = () => existsSync(curlLog);

describe('podspec prepare_command: BUGSEE_IOS_XCFRAMEWORK_ZIP', () => {
  it('an override zip is copied and stamped +local', () => {
    const zip = localZip('local-build');

    const r = run(zip);

    expect(r.status).toBe(0);
    expect(curlCalled()).toBe(false);
    expect(readFileSync(join(pod, 'Bugsee.xcframework', 'Info.plist'), 'utf8')).toBe('local-build');
    expect(stamp()).toBe(`${VERSION}+local.${sha256Prefix(zip)}`);
    expect(r.stderr).toContain(
      'WARNING: Bugsee.xcframework comes from BUGSEE_IOS_XCFRAMEWORK_ZIP, not download.bugsee.com',
    );
    // Only the framework, as for a download: README/LICENSE would ship in npm.
    expect(existsSync(join(pod, 'README.md'))).toBe(false);
    expect(existsSync(join(pod, 'LICENSE'))).toBe(false);
  });

  it('a missing override path fails naming the variable', () => {
    const r = run(join(root, 'does-not-exist.zip'));

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUGSEE_IOS_XCFRAMEWORK_ZIP');
    expect(curlCalled()).toBe(false);
  });

  it('a directory is not a zip, and fails the same way', () => {
    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUGSEE_IOS_XCFRAMEWORK_ZIP');
  });

  it('unsetting the override after a local build re-downloads', () => {
    expect(run(localZip('local-build')).status).toBe(0);

    run();

    expect(curlCalled()).toBe(true);
    expect(readFileSync(curlLog, 'utf8')).toContain(
      `https://download.bugsee.com/sdk/ios/spm/Bugsee-${VERSION}.zip`,
    );
  });

  it('an unchanged published stamp does not re-download', () => {
    mkdirSync(join(pod, 'Bugsee.xcframework'));
    writeFileSync(join(pod, '.bugsee-xcframework-version'), VERSION);

    const r = run();

    expect(r.status).toBe(0);
    expect(curlCalled()).toBe(false);
    expect(r.stderr).not.toContain('WARNING');
  });

  // CocoaPods runs prepare_command only when it thinks the pod changed, and
  // for a :path pod that means the podspec's checksum -- a hash of the
  // evaluated spec, prepare_command's text included. An environment variable
  // the SCRIPT reads changes nothing there, so `pod install` after unsetting
  // it would never rerun the script, and the local build would stay. Seen
  // with CocoaPods 1.17.0 on the example before the podspec folded this in.
  describe("the override changes the podspec's checksum, so CocoaPods reruns it", () => {
    it('setting or unsetting the override changes prepare_command', () => {
      expect(prepareCommand(localZip('a'))).not.toBe(prepareCommand());
    });

    it('a rebuilt zip at the same path changes prepare_command', () => {
      const first = prepareCommand(localZip('a'));
      expect(prepareCommand(localZip('b'))).not.toBe(first);
    });

    it('without the override, prepare_command is stable', () => {
      expect(prepareCommand()).toBe(prepareCommand());
    });
  });
});
