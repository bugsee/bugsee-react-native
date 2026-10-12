jest.mock('@react-native-async-storage/async-storage', () => jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

// The real NativeBugsee needs the New Architecture and a TurboModule; stub only that module so the
// package's real option exports (BugseeLaunchOptions, createDefaultLaunchOptions, endpointFor) stay real.
jest.mock('@bugsee/react-native/src/NativeBugsee', () => {
  const store: Record<string | symbol, unknown> = {};
  return {
    __esModule: true,
    default: new Proxy(store, { get: (t, p) => (t[p] ??= jest.fn()) }),
  };
});
