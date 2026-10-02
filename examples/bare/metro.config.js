const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const library = path.resolve(workspaceRoot, 'packages', 'react-native');
// Same reason as the core library: the workspace symlink's realpath is
// outside the app, and Metro will not serve it unless it is a watch folder
// and an extraNodeModules entry.
const feedback = path.resolve(workspaceRoot, 'packages', 'react-native-feedback');
// The example-only native test helpers (Task 7.6a), a workspace sibling.
const e2eNative = path.resolve(workspaceRoot, 'examples', 'e2e-native');

/**
 * Real paths of the node_modules trees. A git worktree may symlink them at
 * the main clone (so yarn does not reinstall); Metro refuses to serve a file
 * whose realpath is outside projectRoot/watchFolders, so the resolved
 * destinations must be listed explicitly.
 */
const appNodeModules = fs.realpathSync(path.resolve(__dirname, 'node_modules'));
const rootNodeModules = fs.realpathSync(path.resolve(workspaceRoot, 'node_modules'));

/**
 * The app's own copies. The library's `react` and `react-native` imports must
 * land here, never on another copy in the workspace: two Reacts break every
 * hook (`<BugseeSecure>` is the library's first), and two React Natives mean
 * the library talks to a renderer that is not the one on screen.
 */
const SINGLETONS = new Set(['react', 'react-native']);
const appOrigin = path.resolve(__dirname, 'index.js');

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
  watchFolders: [library, feedback, e2eNative, rootNodeModules, appNodeModules],
  resolver: {
    // extraNodeModules below is only a FALLBACK: Metro tries the hierarchical
    // node_modules lookup first. From the library's sources that lookup finds
    // the workspace root's react (a root devDependency, for the library's
    // tests) and the library's own react-native (its devDependency), and
    // bundles them next to the app's. So these two are resolved as if the app
    // had asked for them, deep imports included (react/jsx-runtime,
    // react-native/Libraries/...).
    resolveRequest: (context, moduleName, platform) => {
      const packageName = moduleName.split('/')[0];
      if (SINGLETONS.has(packageName)) {
        return context.resolveRequest(
          { ...context, originModulePath: appOrigin },
          moduleName,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
    nodeModulesPaths: [appNodeModules, rootNodeModules],
    extraNodeModules: {
      '@bugsee/react-native': library,
      '@bugsee/react-native-feedback': feedback,
      'bugsee-e2e-native': e2eNative,
      // The library declares react and react-native as peers; point them at
      // the app's single copy so there are never two Reacts in the bundle.
      react: path.join(appNodeModules, 'react'),
      'react-native': path.join(appNodeModules, 'react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
