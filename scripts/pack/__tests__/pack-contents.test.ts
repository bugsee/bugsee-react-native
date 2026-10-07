import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe.each(['npm', 'yarn'] as const)('%s pack', (tool) => {
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

describe('npm and yarn pack the same files', () => {
  it.each(['react-native', 'react-native-feedback'] as const)('@bugsee/%s', (pkg) => {
    expect(listing(tarballs.get(`yarn ${pkg}`)!)).toEqual(listing(tarballs.get(`npm ${pkg}`)!));
  });
});
