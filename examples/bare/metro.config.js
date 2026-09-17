const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const library = path.resolve(workspaceRoot, 'packages', 'react-native');

/**
 * Metro does not follow a workspace symlink out of the app directory on its
 * own. All three settings below are load-bearing, and they fail in sequence:
 * without `watchFolders` the library's sources are outside the project root
 * and Metro refuses to serve them; with that fixed but no `extraNodeModules`,
 * `@bugsee/react-native` resolves to the symlink's realpath and Metro treats
 * it as a second project; and with both fixed but no `nodeModulesPaths`, the
 * library's own requires — `@babel/runtime` first — resolve against its
 * directory and miss the workspace's hoisted tree.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [library, path.resolve(workspaceRoot, 'node_modules')],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    extraNodeModules: {
      '@bugsee/react-native': library,
      // The library declares react and react-native as peers; point them at
      // the app's single copy so there are never two Reacts in the bundle.
      react: path.resolve(__dirname, 'node_modules', 'react'),
      'react-native': path.resolve(__dirname, 'node_modules', 'react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
