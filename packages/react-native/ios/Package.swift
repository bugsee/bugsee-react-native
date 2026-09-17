// swift-tools-version:5.9
import PackageDescription

// Hand-written, and deliberately so: React Native treats a dependency that
// ships its own Package.swift as "self-managed" and references this directory
// directly instead of scaffolding one. Four things here are load-bearing and
// non-obvious; see docs/design/plans for the spike that established them.
//
//  1. The product name must equal the `spm.name` pinned in
//     react-native.config.js. toSwiftName('@bugsee/react-native') yields
//     'ReactNative', which is reserved, so the autolinker would otherwise
//     rename us and look for a product that does not exist.
//
//  2. The relative `path:` values resolve through the symlink the autolinker
//     creates at <app>/ios/build/generated/autolinking/libs/<SwiftName>, not
//     through this file's realpath. They are the same for a root-level and an
//     ios/ layout precisely because of that indirection.
//
//  3. DEBUG/NDEBUG are mandatory, not cosmetic. NDEBUG changes ShadowNode
//     layout in the prebuilt React.framework, so omitting them links fine in
//     Debug and fails in Release.
//
//  4. There is no prefix header under SPM; react-native-spm-prefix.h is
//     force-included to replace the .pch CocoaPods generates.
let package = Package(
  name: "BugseeReactNative",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "BugseeReactNative", targets: ["BugseeReactNative"])
  ],
  dependencies: [
    .package(name: "ReactNative", path: "../../../../xcframeworks"),
    .package(name: "React-GeneratedCode", path: "../../../ios"),
    .package(path: "Support"),
  ],
  targets: [
    .target(
      name: "BugseeReactNative",
      dependencies: [
        .product(name: "ReactHeaders", package: "ReactNative"),
        .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
        .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
        .product(name: "BugseeRNSupport", package: "Support"),
      ],
      path: ".",
      exclude: ["Support", "react-native-spm-prefix.h"],
      publicHeadersPath: ".",
      cSettings: [
        .unsafeFlags(["-include", "react-native-spm-prefix.h"])
      ],
      cxxSettings: [
        .define("DEBUG", .when(configuration: .debug)),
        .define("NDEBUG", .when(configuration: .release)),
        .unsafeFlags(["-include", "react-native-spm-prefix.h"]),
      ]
    )
  ]
)
