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
  NativeSecureField: () => React.createElement(View),
};
