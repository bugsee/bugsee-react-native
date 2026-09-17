// swift-tools-version:5.9
import PackageDescription

/// Pure marshalling shared by the iOS bridge.
///
/// A package of its own so its tests can exercise it against the real Bugsee
/// framework without React Native, codegen or a device.
///
/// Run them with:
///
///     xcodebuild test -scheme BugseeRNSupport \
///       -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'
///
/// NOT `swift test`: that builds for arm64-apple-macosx, and the xcframework
/// ships no macOS slice, so it fails with "'Bugsee/Bugsee.h' file not found".
/// An earlier version of this comment claimed `swift test` worked; it never
/// did, and CI ran these tests nowhere at all.
let package = Package(
  name: "BugseeRNSupport",
  // 15.0, matching the rest of the wrapper rather than the SDK's own 13.0.
  // Nothing here links React, so this target *could* sit at 13.0 -- but no
  // React Native app can: RN has floored at 15.1 since 0.76, and every
  // version with SPM support is above that. A lower number here would only
  // advertise reach that no consumer can use, and the native SDK is moving
  // to 15+ as well.
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "BugseeRNSupport", targets: ["BugseeRNSupport"])
  ],
  dependencies: [
    // Exact, not a range: SwiftPM will not admit a prerelease into one.
    .package(url: "https://github.com/bugsee/spm", exact: "7.0.0-beta1")
  ],
  targets: [
    .target(
      name: "BugseeRNSupport",
      dependencies: [.product(name: "Bugsee", package: "spm")],
      publicHeadersPath: "include"
    ),
    .testTarget(
      name: "BugseeRNSupportTests",
      dependencies: ["BugseeRNSupport"]
    ),
  ]
)
