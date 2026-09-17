/**
 * The device e2e runs on its own config: the workspace's unit-test config
 * ignores `examples/` on purpose, because these tests need a phone plugged in
 * and have no business running in a plain `yarn test`.
 */
module.exports = {
  rootDir: __dirname,
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Pinned explicitly: ts-jest would otherwise pick up the example app's
  // tsconfig, which extends @react-native/typescript-config and describes a
  // React Native bundle, not a Node script.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: `${__dirname}/tsconfig.json` }],
  },
  testMatch: ['<rootDir>/*.test.ts'],
  // The device driver spawns adb/devicectl and reports the whole captured log
  // on failure; truncating it would hide the reason.
  verbose: true,
};
