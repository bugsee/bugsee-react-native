// react-native is not resolvable in this unit environment. The mock is
// mutable so the collector can be exercised against different runtimes —
// which is the point: these facts are whatever the host app happens to be.
const constants: { reactNativeVersion?: unknown } = {};
jest.mock('react-native', () => ({ Platform: { get constants() { return constants; } } }));

import { collectWrapperFacts, formatReactNativeVersion } from '../collect';


describe('formatReactNativeVersion', () => {
  // Platform.constants.reactNativeVersion is the reliable source: the
  // react-native package.json is not importable from a consuming app, and
  // hardcoding a version would be wrong the moment the app upgrades.
  it('joins the parts', () => {
    expect(formatReactNativeVersion({ major: 0, minor: 87, patch: 1 }))
      .toBe('0.87.1');
  });

  it('appends a prerelease when present', () => {
    expect(formatReactNativeVersion({
      major: 0, minor: 88, patch: 0, prerelease: 'rc.1',
    })).toBe('0.88.0-rc.1');
  });

  it('ignores a null prerelease, which is how RN spells "none"', () => {
    expect(formatReactNativeVersion({
      major: 0, minor: 87, patch: 1, prerelease: null,
    })).toBe('0.87.1');
  });

  // A 0 patch is falsy; a version built with `||` would drop it.
  it('keeps a zero component', () => {
    expect(formatReactNativeVersion({ major: 0, minor: 0, patch: 0 }))
      .toBe('0.0.0');
  });

  // Platform.constants is typed, but the value crosses from native and a
  // wrong-typed component would otherwise render as "0.undefined.1".
  it.each([
    ['major', { major: '0', minor: 87, patch: 1 }],
    ['minor', { major: 0, minor: null, patch: 1 }],
    ['patch', { major: 0, minor: 87, patch: undefined }],
  ])('reports unknown when %s is not a number', (_name, version) => {
    expect(formatReactNativeVersion(version as never)).toBe('unknown');
  });

  it('reports unknown rather than inventing a version', () => {
    expect(formatReactNativeVersion(undefined)).toBe('unknown');
    expect(formatReactNativeVersion({} as never)).toBe('unknown');
  });
});

describe('collectWrapperFacts', () => {
  const hermesGlobal = globalThis as { HermesInternal?: unknown };

  beforeEach(() => {
    constants.reactNativeVersion = { major: 0, minor: 87, patch: 1 };
    delete hermesGlobal.HermesInternal;
  });

  it('passes the package version through', () => {
    expect(collectWrapperFacts('2.0.0').version).toBe('2.0.0');
  });

  it('reads the React Native version from Platform.constants', () => {
    expect(collectWrapperFacts('2.0.0').reactNativeVersion).toBe('0.87.1');
  });

  it('detects Hermes from the global it installs', () => {
    expect(collectWrapperFacts('2.0.0').hermes).toBe(false);
    hermesGlobal.HermesInternal = {};
    expect(collectWrapperFacts('2.0.0').hermes).toBe(true);
  });

  // Platform.constants is typed as always present, but a host can be mid
  // upgrade or a test double; an unknown version is better than a crash.
  it('survives Platform.constants being empty', () => {
    delete constants.reactNativeVersion;
    expect(collectWrapperFacts('2.0.0').reactNativeVersion).toBe('unknown');
  });
});
