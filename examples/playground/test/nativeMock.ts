import * as React from 'react';
import { View } from 'react-native';

module.exports = {
  __esModule: true,
  PlaygroundNative: {
    available: true,
    supportsNdk: true,
    crash: jest.fn(),
    crashNdk: jest.fn(),
    hangMainThread: jest.fn(),
    log: jest.fn(),
    request: jest.fn(async () => ({ status: 200, body: '{}' })),
  },
  NATIVE_UNAVAILABLE: 'native module unavailable (Expo Go or a missing dev build)',
  NativeSecureField: () => React.createElement(View),
};
