// swift-tools-version:5.9
import PackageDescription

// The SwiftPM delivery path for the example-only `bugsee-e2e-native` module
// (Task 7.6a). CI builds examples/bare both ways, and on SPM React Native
// refuses a dependency that ships no Package.swift. Hand-written, in ios/
// like @bugsee/react-native's, which makes it "self-managed": the autolinker
// references this directory instead of scaffolding one into node_modules.
//
// It follows packages/react-native/ios/Package.swift, whose comments explain
// each load-bearing setting:
//  - the product name is toSwiftName('bugsee-e2e-native');
//  - the relative `path:` values resolve through the autolinker's symlink,
//    not through this file's realpath;
//  - DEBUG/NDEBUG, the forced prefix header and C++20 are all required.
let package = Package(
  name: "BugseeE2eNative",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "BugseeE2eNative", targets: ["BugseeE2eNative"])
  ],
  dependencies: [
    .package(name: "ReactNative", path: "../../../../xcframeworks"),
    .package(name: "React-GeneratedCode", path: "../../../ios"),
  ],
  targets: [
    .target(
      name: "BugseeE2eNative",
      dependencies: [
        .product(name: "ReactHeaders", package: "ReactNative"),
        .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
        .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
      ],
      path: ".",
      exclude: ["react-native-spm-prefix.h"],
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
  ],
  cxxLanguageStandard: .cxx20
)
