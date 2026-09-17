import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readNativeVersions } from '../native-versions';
import {
  REACT_NATIVE_SUPPORT,
  SDK_FLOORS,
  parseCiCompatMatrix,
  parseGradleJavaLevel,
  parseGradleMinSdk,
  parseResolvedPin,
  parseSpmName,
  parseSpmPin,
  parseSwiftProduct,
} from '../platform-floors';

const repo = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8');
const pkg = (...p: string[]) => read('packages', 'react-native', ...p);

// Every one of these guards a value that previously appeared in two places
// with nothing comparing them. Each was found by review, and each was proved
// by changing one copy and watching the whole suite pass.
describe('native SDK versions come from one place', () => {
  const versions = readNativeVersions();

  // The podspec downloads the xcframework for native-versions.json's version,
  // while SwiftPM resolves whatever tag this manifest names. Disagree, and the
  // two delivery paths ship DIFFERENT SDKs, both building green.
  it('the SPM pin matches native-versions.json', () => {
    expect(parseSpmPin(pkg('ios', 'Support', 'Package.swift')))
      .toBe(versions.ios.sdk);
  });

  // A third copy of the same number, and the one that actually decides what
  // `swift test` and a local build resolve.
  it('the resolved lockfile matches native-versions.json', () => {
    expect(parseResolvedPin(pkg('ios', 'Support', 'Package.resolved')))
      .toBe(versions.ios.sdk);
  });

  // Swift manifests are hand-formatted; a pattern assuming one space finds
  // nothing and the guard silently stops guarding.
  it('reads the pin regardless of spacing', () => {
    expect(parseSpmPin('.package(url:"https://github.com/bugsee/spm",exact:"7.1.0")'))
      .toBe('7.1.0');
    expect(parseSpmPin('.package(url:   "https://github.com/bugsee/spm" ,  exact:   "7.1.0")'))
      .toBe('7.1.0');
  });

  it('the pin is exact, because SwiftPM will not take a prerelease from a range', () => {
    expect(() => parseSpmPin('.package(url: "https://github.com/bugsee/spm", from: "7.0.0")'))
      .toThrow(/exact/);
  });
});

describe('the SPM product name is pinned end to end', () => {
  // toSwiftName('@bugsee/react-native') yields 'ReactNative', which is in RN's
  // RESERVED_SWIFT_NAMES, so the autolinker renames us. The pin and the
  // manifest's product must therefore agree exactly; if they drift, the app
  // build fails with "product 'X' ... not found", far from the cause.
  it('react-native.config.js and Package.swift name the same product', () => {
    const pinned = parseSpmName(pkg('react-native.config.js'));
    expect(pinned).toBe(parseSwiftProduct(pkg('ios', 'Package.swift')));
    expect(pinned).toBe('BugseeReactNative');
  });

  it('refuses a config with no spm block at all', () => {
    expect(() => parseSpmName('module.exports = { dependency: {} };'))
      .toThrow(/spm\.name/);
  });
});

describe('the Android compile level matches the SDK', () => {
  // Commit "match the SDK's floors -- minSdk 21, Java 8" asserted only the
  // first half. Emitting newer bytecode than the library being bridged to
  // buys nothing and narrows who can consume the wrapper.
  it('compiles at Java 8, like the SDK it wraps', () => {
    const levels = parseGradleJavaLevel(pkg('android', 'build.gradle'));
    expect(levels).toEqual(['VERSION_1_8', 'VERSION_1_8']);
  });

  it('still declares the SDK minSdk', () => {
    expect(parseGradleMinSdk(pkg('android', 'build.gradle')))
      .toBe(SDK_FLOORS.androidMinSdk);
  });
});

describe('the RN support matrix is the one CI runs', () => {
  // This previously compared REACT_NATIVE_SUPPORT.matrix against itself, so
  // the test named "is the lowest version CI builds" passed with CI cut down
  // to a single version. Read the workflow instead.
  it('matches the workflow, not a copy of it', () => {
    expect(parseCiCompatMatrix(read('.github', 'workflows', 'ci.yml')))
      .toEqual([...REACT_NATIVE_SUPPORT.matrix]);
  });

  it('includes the declared floor', () => {
    const matrix = parseCiCompatMatrix(read('.github', 'workflows', 'ci.yml'));
    expect(matrix.some((m) => REACT_NATIVE_SUPPORT.floor.startsWith(`${m}.`)))
      .toBe(true);
  });
});
