// swift-tools-version:5.9
import PackageDescription

/// Pure marshalling shared by the iOS bridge.
///
/// A package of its own so `swift test` can exercise it against the real
/// Bugsee framework without React Native, codegen, an Xcode project or a
/// device. The TurboModule that calls into it needs all four, and is covered
/// by the example app instead.
let package = Package(
  name: "BugseeRNSupport",
  // 13.0, matching the Bugsee SDK itself (`LC_BUILD_VERSION minos` in the
  // xcframework, and `.iOS(.v13)` in bugsee/spm). Nothing here links React, so
  // nothing forces this above the SDK -- and a wrapper that raised the floor
  // would drop devices the SDK still supports, silently.
  platforms: [.iOS(.v13)],
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
