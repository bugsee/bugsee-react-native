/**
 * toSwiftName('@bugsee/react-native-feedback') is ReactNativeFeedback.
 * That name is not in React Native's reserved list (ReactNative, the
 * codegen products, Autolinked), so the autolinker would not rename it.
 * Pinning it anyway keeps Package.swift's product from drifting away from
 * the name the autolinker looks up.
 *
 * Verified against RN 0.87.1's scripts/spm/spm-utils.js.
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {},
    },
  },
  spm: {
    name: 'ReactNativeFeedback',
  },
};
