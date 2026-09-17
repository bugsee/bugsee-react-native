import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IOS_FLOOR,
  REACT_NATIVE_SUPPORT,
  REACT_NATIVE_FLOORS,
  SDK_FLOORS,
  parseGradleMinSdk,
  parsePeerFloor,
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

});

describe('iOS sits at 15 everywhere, deliberately', () => {
  // BugseeRNSupport links no React, so it *could* sit at the SDK's 13.0. It
  // does not, because no RN app can reach 13.0 anyway -- see IOS_FLOOR.
  it('ios/Support/Package.swift declares the wrapper floor, not the SDK\'s', () => {
    const declared = parseSwiftPlatform(read('ios', 'Support', 'Package.swift'));
    expect(declared).toBe(IOS_FLOOR.spm);
    expect(declared).not.toBe(SDK_FLOORS.iosDeploymentTarget);
  });

  it('the wrapper floor is exactly what React Native imposes', () => {
    expect(IOS_FLOOR.spm).toBe(REACT_NATIVE_FLOORS.iosSpmDeploymentTarget);
    expect(IOS_FLOOR.podFallback).toBe(
      REACT_NATIVE_FLOORS.iosPodDeploymentTargetFallback,
    );
  });
});

describe('where React Native binds, the floor is React Native\'s', () => {
  // This one CANNOT be 13.0: the target consumes React-GeneratedCode, which
  // declares .iOS(.v15), and SwiftPM fails the build rather than resolve it.
  it('ios/Package.swift matches RN\'s generated package', () => {
    expect(parseSwiftPlatform(read('ios', 'Package.swift')))
      .toBe(IOS_FLOOR.spm);
  });

  // The podspec reads RN's own min_ios_version_supported at install time, so
  // it tracks whichever RN the app is on. The literal is only the fallback for
  // evaluation outside an RN app, e.g. `pod spec lint`.
  it('the podspec tracks RN rather than hardcoding a floor', () => {
    expect(read('BugseeReactNative.podspec')).toMatch(/min_ios_version_supported/);
  });

  it('the podspec fallback matches RN\'s CocoaPods floor', () => {
    expect(parsePodspecFallback(read('BugseeReactNative.podspec')))
      .toBe(IOS_FLOOR.podFallback);
  });
});

describe('the React Native floor', () => {
  it('is what package.json declares to consumers', () => {
    expect(parsePeerFloor(read('package.json'))).toBe(REACT_NATIVE_SUPPORT.floor);
  });

  // Claiming a floor CI never builds is how "supported" quietly becomes
  // "untested". The lowest matrix entry must be the floor itself.
  it('is the lowest version CI builds', () => {
    const lowest = [...REACT_NATIVE_SUPPORT.matrix].sort((a, b) =>
      Number(a.split('.')[1]) - Number(b.split('.')[1]),
    )[0];
    expect(REACT_NATIVE_SUPPORT.floor.startsWith(`${lowest}.`)).toBe(true);
  });

  // 0.80 is the hard technical floor: codegenConfig.ios.modulesProvider, the
  // fix for the TurboModule name colliding with the SDK's Bugsee class, does
  // not exist before it.
  it('stays above the modulesProvider floor', () => {
    const minor = Number(REACT_NATIVE_SUPPORT.floor.split('.')[1]);
    expect(minor).toBeGreaterThanOrEqual(80);
  });

  it('rejects a range too loose to correspond to a tested version', () => {
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"*"}}'))
      .toThrow(/floor/);
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"^0.81.0"}}'))
      .toThrow(/floor/);
  });
});
