import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REACT_NATIVE_FLOORS,
  SDK_FLOORS,
  parseGradleMinSdk,
  parsePodspecFallback,
  parseSwiftPlatform,
} from '../platform-floors';

const pkg = join(__dirname, '..', '..', 'packages', 'react-native');
const read = (...p: string[]) => readFileSync(join(pkg, ...p), 'utf8');

describe('parsers', () => {
  it('reads a bare .vNN as NN.0', () => {
    expect(parseSwiftPlatform('platforms: [.iOS(.v13)],')).toBe('13.0');
  });

  // SwiftPM spells a point release with an underscore. Reading .v15_1 as "15"
  // would silently compare the wrong number.
  it('reads .vNN_M as NN.M', () => {
    expect(parseSwiftPlatform('platforms: [.iOS(.v15_1)],')).toBe('15.1');
  });

  it('ignores other platforms in the same list', () => {
    expect(parseSwiftPlatform('platforms: [.tvOS(.v14), .iOS(.v13)],')).toBe('13.0');
  });

  it('reads a plain podspec floor', () => {
    expect(parsePodspecFallback("s.platforms = { :ios => '15.1' }")).toBe('15.1');
  });

  // The real declaration is a ternary. Taking the first quoted version would
  // read the condition's value, not the fallback.
  it('reads the fallback, not the first literal, out of a ternary', () => {
    expect(
      parsePodspecFallback(
        "s.platforms = { :ios => defined?(x) ? '99.9' : '15.1' }",
      ),
    ).toBe('15.1');
  });

  it('refuses to guess when no iOS platform is declared', () => {
    expect(() => parseSwiftPlatform('platforms: [.tvOS(.v14)],')).toThrow(/iOS/);
    expect(() => parseGradleMinSdk('android { }')).toThrow(/minSdk/);
    expect(() => parsePodspecFallback('s.name = "x"')).toThrow(/:ios/);
  });
});

describe('the wrapper does not raise the floor above the SDK it wraps', () => {
  // The Android manifest merger takes the max, so declaring the SDK's own 21
  // costs nothing and keeps API 21-23 devices reachable. React Native's 24 is
  // the *app's* constraint, and must not be copied into the library.
  it('android/build.gradle declares the AAR minSdk', () => {
    expect(parseGradleMinSdk(read('android', 'build.gradle')))
      .toBe(SDK_FLOORS.androidMinSdk);
  });

  // BugseeRNSupport depends on bugsee/spm and nothing else -- no React. There
  // is therefore nothing forcing it above the SDK's own 13.0.
  it('ios/Support/Package.swift declares the SDK deployment target', () => {
    expect(parseSwiftPlatform(read('ios', 'Support', 'Package.swift')))
      .toBe(SDK_FLOORS.iosDeploymentTarget);
  });
});

describe('where React Native binds, the floor is React Native\'s', () => {
  // This one CANNOT be 13.0: the target consumes React-GeneratedCode, which
  // declares .iOS(.v15), and SwiftPM fails the build rather than resolve it.
  it('ios/Package.swift matches RN\'s generated package', () => {
    expect(parseSwiftPlatform(read('ios', 'Package.swift')))
      .toBe(REACT_NATIVE_FLOORS.iosSpmDeploymentTarget);
  });

  // The podspec reads RN's own min_ios_version_supported at install time, so
  // it tracks whichever RN the app is on. The literal is only the fallback for
  // evaluation outside an RN app, e.g. `pod spec lint`.
  it('the podspec tracks RN rather than hardcoding a floor', () => {
    expect(read('BugseeReactNative.podspec')).toMatch(/min_ios_version_supported/);
  });

  it('the podspec fallback matches RN\'s CocoaPods floor', () => {
    expect(parsePodspecFallback(read('BugseeReactNative.podspec')))
      .toBe(REACT_NATIVE_FLOORS.iosPodDeploymentTargetFallback);
  });
});
