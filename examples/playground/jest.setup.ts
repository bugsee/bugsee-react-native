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

// Global facade mocks. Task 3 tests rely on the REAL option exports, which bugseeMock re-exports.
jest.mock('@bugsee/react-native', () => jest.requireActual('./test/bugseeMock'));
jest.mock('@bugsee/react-native-feedback', () => jest.requireActual('./test/feedbackMock'));
jest.mock('./modules/playground-native', () => jest.requireActual('./test/nativeMock'));

jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  return { CameraView: View, useCameraPermissions: () => [{ granted: true }, jest.fn()] };
});
jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual('react-native');
  return { WebView: View, default: View };
});
jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  const passThrough = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  const withScreen = () => Object.assign(({ children }: { children?: React.ReactNode }) => passThrough({ children }), { Screen: () => null });
  return {
    useLocalSearchParams: () => ({}),
    Slot: passThrough,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
    Link: Text,
    Stack: withScreen(),
    Tabs: withScreen(),
    Redirect: () => null,
  };
});
