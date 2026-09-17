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

  // These parsers decide whether CI notices a floor change at all. A pattern
  // that quietly matches the wrong line reports success on a drifted build.
  it('tolerates spacing variations in a Swift manifest', () => {
    expect(parseSwiftPlatform('platforms:[.iOS(.v15)],')).toBe('15.0');
    expect(parseSwiftPlatform('platforms:   [.iOS(.v15)],')).toBe('15.0');
  });

  it('reads minSdk regardless of the spacing around it', () => {
    expect(parseGradleMinSdk('    minSdk   21\n')).toBe(21);
    expect(parseGradleMinSdk('    minSdk 21   \n')).toBe(21);
  });

  // Anchored to the line start, so a differently-named setting that merely
  // ends in "minSdk" cannot be read as the library's own floor.
  it('does not read a different setting that ends in minSdk', () => {
    expect(parseGradleMinSdk('  targetminSdk 24\n  minSdk 21\n')).toBe(21);
  });

  it('reads the podspec floor with no space before the arrow', () => {
    expect(parsePodspecFallback("{ :ios=>'15.1' }")).toBe('15.1');
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

  // NOTE: whether the floor is a version CI actually builds is asserted in
  // single-source.test.ts, which reads .github/workflows/ci.yml. This file
  // used to "check" it by comparing the constant to itself, which passed with
  // the workflow cut down to a single version.
  // 0.80 is the hard technical floor: codegenConfig.ios.modulesProvider, the
  // fix for the TurboModule name colliding with the SDK's Bugsee class, does
  // not exist before it.
  it('stays above the modulesProvider floor', () => {
    const minor = Number(REACT_NATIVE_SUPPORT.floor.split('.')[1]);
    expect(minor).toBeGreaterThanOrEqual(80);
  });

  // Two-digit minors and patches are already here (0.81.10 exists), so a
  // regex that only accepts single digits silently rejects real versions.
  it('accepts multi-digit version components', () => {
    expect(parsePeerFloor('{"peerDependencies":{"react-native":">=0.81.10"}}'))
      .toBe('0.81.10');
    expect(parsePeerFloor('{"peerDependencies":{"react-native":">=10.11.12"}}'))
      .toBe('10.11.12');
  });

  // Unanchored, these would accept a compound range and report only the part
  // that happened to match -- claiming a floor nobody declared.
  it('rejects a compound range that merely contains a floor', () => {
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"~0.5 >=0.81.0"}}'))
      .toThrow(/floor/);
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":">=0.81.0 <2"}}'))
      .toThrow(/floor/);
  });

  it('rejects a missing react-native peer entry outright', () => {
    expect(() => parsePeerFloor('{"peerDependencies":{}}')).toThrow(/floor/);
    expect(() => parsePeerFloor('{}')).toThrow(/floor/);
  });

  it('rejects a range too loose to correspond to a tested version', () => {
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"*"}}'))
      .toThrow(/floor/);
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"*"}}'))
      .toThrow(/looser range/);
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"*"}}'))
      .toThrow(/CI never builds/);
    expect(() => parsePeerFloor('{"peerDependencies":{"react-native":"^0.81.0"}}'))
      .toThrow(/floor/);
  });
});
