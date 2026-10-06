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
  // 15.0: the SDK's own floor (7.0.0-beta2 raised it from 13.0, and the
  // bugsee/spm manifest declares .iOS(.v15)), and the rest of the wrapper's.
  // SwiftPM refuses a package that sits below a product it consumes, so this
  // cannot go lower; React Native, at 15.1 since 0.76, could not use it if it
  // did.
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "BugseeRNSupport", targets: ["BugseeRNSupport"])
  ],
  dependencies: [
    // Exact, not a range: SwiftPM will not admit a prerelease into one.
    .package(url: "https://github.com/bugsee/spm", exact: "7.0.0-beta4")
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
