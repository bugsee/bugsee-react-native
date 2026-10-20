import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readNativeVersions } from '../../native-versions';
import { releaseBlockers } from '../../releasable-pins';

/**
 * What the published tarballs hold, packed the two ways a release can be cut:
 * `npm pack` and `yarn pack` (Yarn 4, the repo's own). Both run the packages'
 * prepack/postpack, as `npm publish` and `yarn npm publish` do.
 *
 * Found by the campaign's build lane (BLK-17, B-3, B-5): native-versions.json
 * was in neither tarball, so `pod install` and Gradle configuration failed in
 * every app that installed the package from npm; `yarn pack` dropped the
 * compiled Expo config plugin that app.plugin.js requires; and both shipped
 * the Jest tests.
 *
 * Not in the scripts mutation gate's testMatch on purpose: it packs the real
 * packages, which a Stryker sandbox has no install state for.
 */
const repo = join(__dirname, '..', '..', '..');
const rootVersions = JSON.parse(readFileSync(join(repo, 'native-versions.json'), 'utf8')) as unknown;

// While native-versions.json pins something unreleasable (a local Android
// -SNAPSHOT during beta validation), both packages' prepack refuses to pack at
// all -- that refusal is the release guard, and it is what this file asserts
// in that state. The tarball-content suites need a tarball, so they run only
// once the pins are releasable again (and always under BUGSEE_RELEASE=1,
// where an unreleasable pin must fail loudly rather than be skipped).
const blockers = releaseBlockers(
  readNativeVersions(),
  readFileSync(join(repo, 'packages/react-native/ios/Support/Package.resolved'), 'utf8'),
);
const packable = blockers.length === 0 || process.env.BUGSEE_RELEASE === '1';
const describeTarballs = packable ? describe : describe.skip;

type Tool = 'npm' | 'yarn';
type Pkg = 'react-native' | 'react-native-feedback';

const work = mkdtempSync(join(tmpdir(), 'bugsee-pack-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function pack(tool: Tool, pkg: Pkg): string {
  const cwd = join(repo, 'packages', pkg);
  const out = join(work, tool, pkg);
  execFileSync('mkdir', ['-p', out]);
  if (tool === 'npm') {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd, stdio: 'pipe' });
  } else {
    execFileSync('yarn', ['pack', '--out', join(out, 'package.tgz')], { cwd, stdio: 'pipe' });
  }
  const [tgz] = readdirSync(out).filter((name) => name.endsWith('.tgz'));
  if (!tgz) throw new Error(`${tool} pack wrote no tarball for ${pkg}`);
  return join(out, tgz);
}

const listing = (tgz: string): string[] =>
  execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0 && !line.endsWith('/'))
    .map((line) => line.replace(/^package\//, ''))
    .sort();

const entry = (tgz: string, path: string): string =>
  execFileSync('tar', ['-xzOf', tgz, `package/${path}`], { encoding: 'utf8' });

const tarballs = new Map<string, string>();
beforeAll(() => {
  if (!packable) return;
  for (const tool of ['npm', 'yarn'] as const) {
    for (const pkg of ['react-native', 'react-native-feedback'] as const) {
      tarballs.set(`${tool} ${pkg}`, pack(tool, pkg));
    }
  }
}, 240_000);

const TEST_ONLY = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /^src\/testSupport\//,
  /^android\/src\/test\//,
];

describeTarballs.each(['npm', 'yarn'] as const)('%s pack', (tool) => {
  describe.each(['react-native', 'react-native-feedback'] as const)('@bugsee/%s', (pkg) => {
    const tgz = () => tarballs.get(`${tool} ${pkg}`)!;

    it('ships native-versions.json, identical to the repo root pins', () => {
      expect(listing(tgz())).toContain('native-versions.json');
      expect(JSON.parse(entry(tgz(), 'native-versions.json'))).toEqual(rootVersions);
    });

    it('ships no tests, mocks or test fixtures', () => {
      const shipped = listing(tgz()).filter((path) => TEST_ONLY.some((re) => re.test(path)));
      expect(shipped).toEqual([]);
    });

    it('leaves no staged native-versions.json behind in the package', () => {
      expect(existsSync(join(repo, 'packages', pkg, 'native-versions.json'))).toBe(false);
    });
  });

  it('ships what the core package needs at build and run time', () => {
    const files = listing(tarballs.get(`${tool} react-native`)!);
    expect(files).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'LICENSE',
        'BugseeReactNative.podspec',
        'react-native.config.js',
        'app.plugin.js',
        // app.plugin.js requires the compiled plugin, which reads its baked pins.
        'plugin/build/index.js',
        'plugin/build/native-versions.js',
        'plugin/build/native-versions.baked.json',
        'src/index.ts',
        'src/NativeBugsee.ts',
        'src/options/option-keys.json',
        'android/build.gradle',
        'android/src/main/AndroidManifest.xml',
        'ios/BugseeModule.mm',
        'ios/Package.swift',
        'ios/Support/Package.swift',
        'scripts/bugsee-xcode.sh',
        'scripts/bugsee-sourcemaps.gradle',
        'scripts/compose-then-inject.js',
        'scripts/hermes-sourcemaps.js',
        'scripts/hermesc-preserve-js.sh',
      ]),
    );
  });

  // ios/Support/Package.swift declares a test target. SwiftPM refuses to load
  // a manifest whose test target has no sources ("overlapping sources"), and
  // the 0.87+ SPM delivery loads that manifest, so these sources must ship.
  it('keeps the SPM test target sources the Support manifest declares', () => {
    const files = listing(tarballs.get(`${tool} react-native`)!);
    expect(files.some((path) => path.startsWith('ios/Support/Tests/BugseeRNSupportTests/'))).toBe(true);
  });

  it('ships what the feedback package needs at build and run time', () => {
    const files = listing(tarballs.get(`${tool} react-native-feedback`)!);
    expect(files).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'LICENSE',
        'BugseeReactNativeFeedback.podspec',
        'react-native.config.js',
        'src/index.ts',
        'src/NativeBugseeFeedback.ts',
        'android/build.gradle',
        'ios/Package.swift',
      ]),
    );
  });
});

describeTarballs('npm and yarn pack the same files', () => {
  it.each(['react-native', 'react-native-feedback'] as const)('@bugsee/%s', (pkg) => {
    expect(listing(tarballs.get(`yarn ${pkg}`)!)).toEqual(listing(tarballs.get(`npm ${pkg}`)!));
  });
});

(packable ? describe.skip : describe)('while the pins are not releasable', () => {
  it.each([
    ['npm', 'react-native'],
    ['npm', 'react-native-feedback'],
    ['yarn', 'react-native'],
    ['yarn', 'react-native-feedback'],
  ] as const)('%s pack refuses @bugsee/%s', (tool, pkg) => {
    let output = '';
    try {
      pack(tool, pkg);
    } catch (error) {
      const failed = error as { stdout?: Buffer | string; stderr?: Buffer | string };
      output = `${failed.stdout?.toString() ?? ''}${failed.stderr?.toString() ?? ''}`;
      // Yarn 4 does not echo a failed lifecycle script; it names a log file.
      const log = /logs can be found here: (\S+?\.log)/.exec(output)?.[1];
      if (log !== undefined && existsSync(log)) output += readFileSync(log, 'utf8');
    }
    expect(output).toContain('native-versions.json is not releasable');
    expect(existsSync(join(repo, 'packages', pkg, 'native-versions.json'))).toBe(false);
  });
});

/**
 * The shell scripts the build hooks exec directly must be executable in the tarball: React Native's
 * Hermes task runs `hermesCommand` as a program and the bare Xcode phase runs `bugsee-xcode.sh` the
 * same way. `yarn pack` drops the executable bit, which is why releases are packed with `npm pack`
 * (7.0.0-beta1 and beta2 shipped these as 0644; see scripts/exec-bits.ts).
 */
describeTarballs('executable bits (npm pack, the release tool)', () => {
  const tgz = pack('npm', 'react-native');
  const modes = new Map(
    execFileSync('tar', ['-tvzf', tgz], { encoding: 'utf8' })
      .split('\n')
      .map((line) => /^(\S{10})\s+.*?\s(package\/\S.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[2] as string, m[1] as string] as const),
  );

  it.each([
    'scripts/bugsee-xcode.sh',
    'scripts/hermesc-preserve-js.sh',
    'scripts/hermesc-preserve-js.js',
    'scripts/compose-then-inject.js',
  ])('%s is executable', (path) => {
    expect(modes.get(`package/${path}`)?.[3]).toBe('x');
  });
});
