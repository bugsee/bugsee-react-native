// swift-tools-version:5.9
import PackageDescription

// Hand-written, like the core package's manifest. The autolinker treats a
// dependency that ships Package.swift as self-managed. The React path values
// resolve through the symlink at
// <app>/ios/build/generated/autolinking/libs/ReactNativeFeedback, which is
// why they match the core package's even though this file lives in a
// different package. toSwiftName('@bugsee/react-native-feedback') is
// ReactNativeFeedback, pinned in react-native.config.js.
//
// bugsee/feedback-spm is exact, and so is bugsee/spm. The feedback package
// already pins the core exactly; declaring the same pin here is what lets
// this target import Bugsee (SwiftPM does not expose a transitive product)
// and what makes a mismatched core fail resolution instead of linking.
let package = Package(
  name: "ReactNativeFeedback",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "ReactNativeFeedback", targets: ["ReactNativeFeedback"])
  ],
  dependencies: [
    .package(name: "ReactNative", path: "../../../../xcframeworks"),
    .package(name: "React-GeneratedCode", path: "../../../ios"),
    .package(url: "https://github.com/bugsee/spm", exact: "7.0.0-beta4"),
    .package(url: "https://github.com/bugsee/feedback-spm", exact: "7.0.0-beta4"),
  ],
  targets: [
    .target(
      name: "ReactNativeFeedback",
      dependencies: [
        .product(name: "ReactHeaders", package: "ReactNative"),
        .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
        .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
        .product(name: "Bugsee", package: "spm"),
        .product(name: "BugseeFeedback", package: "feedback-spm"),
      ],
      path: ".",
      exclude: ["react-native-spm-prefix.h"],
      publicHeadersPath: ".",
      cSettings: [
        .unsafeFlags(["-include", "react-native-spm-prefix.h"]),
        // The ObjC client imports the Swift module. The .mm is C++ and does
        // not get cSettings, so the flag is repeated below.
        .define("BUGSEE_FEEDBACK_SPM", to: "1"),
      ],
      cxxSettings: [
        .define("DEBUG", .when(configuration: .debug)),
        .define("NDEBUG", .when(configuration: .release)),
        // This target does not compile the Swift sources. The generated
        // header belongs to the BugseeFeedback product. The .mm is built
        // with -fno-cxx-modules, so it cannot import that module; the ObjC
        // client does.
        .define("BUGSEE_FEEDBACK_SPM", to: "1"),
        .unsafeFlags(["-include", "react-native-spm-prefix.h"]),
      ]
    )
  ],
  cxxLanguageStandard: .cxx20
)
