/**
 * React Native derives a Swift package name for every autolinked dependency
 * with `toSwiftName()`, which strips the npm scope. That turns
 * `@bugsee/react-native` into `ReactNative` — which is in RN's
 * RESERVED_SWIFT_NAMES, alongside ReactCodegen, Autolinked and the header
 * products.
 *
 * Left alone, the autolinker silently "scope-borrows" to `BugseeReactNative`,
 * and THAT becomes the product name `ios/Package.swift` must vend. Pinning it
 * here makes the contract explicit instead of emergent, and stops a future
 * change to RN's collision handling from renaming our product underneath us.
 *
 * Verified against RN 0.87.1:
 *   toSwiftName('@bugsee/react-native') === 'ReactNative'  // reserved
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {},
    },
  },
  spm: {
    name: 'BugseeReactNative',
  },
};
