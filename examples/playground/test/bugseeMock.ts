// Facade mock for @bugsee/react-native. Installed globally by jest.setup.ts, which first mocks
// @bugsee/react-native/src/NativeBugsee so jest.requireActual below can load the real package.
import * as React from 'react';
import { View } from 'react-native';

const actual = jest.requireActual('@bugsee/react-native') as Record<string, unknown>;

const METHODS = [
  'launch', 'relaunch', 'stop', 'setSecureRectangles', 'startBlackout', 'endBlackout', 'isBlackout', 'captureViewHierarchy',
  'onLifecycleEvent', 'onStatusChange', 'setReportHandler', 'upload', 'showReportDialog', 'createReport', 'log', 'setNetworkFilter',
  'addNetworkEvent', 'setLogFilter', 'addBreadcrumb', 'setBreadcrumbFilter', 'event', 'trace', 'setAttribute', 'getAttribute',
  'getAllAttributes', 'clearAttribute', 'clearAllAttributes', 'setUserIdentifier', 'getUserIdentifier', 'clearUserIdentifier',
  'attach', 'getStatus', 'getLaunchOptions', 'testNativeCrash', 'testJsCrash', 'logException', 'logUnhandledException', 'notify',
  'startTransaction', 'startSpan', 'getActiveSpan', 'deleteCollectedDataOnDevice',
] as const;

function makeSpan(): Record<string, unknown> {
  const span: Record<string, unknown> = {};
  span.startChildSpan = jest.fn(() => makeSpan());
  for (const m of ['setName', 'setStatus', 'setAttribute', 'setDescription']) span[m] = jest.fn(() => span);
  span.finish = jest.fn();
  return span;
}

// Mirrors packages/react-native/src/index.ts: only these return promises; everything else is synchronous.
const resolves: Record<string, unknown> = {
  launch: true, relaunch: true, stop: true, isBlackout: true, deleteCollectedDataOnDevice: true,
  getStatus: 2, getLaunchOptions: {}, getAllAttributes: {},
  createReport: undefined, setAttribute: undefined, getAttribute: undefined, clearAttribute: undefined,
  clearAllAttributes: undefined, getUserIdentifier: undefined, attach: undefined, logUnhandledException: undefined,
};

function makeBugsee(): Record<string, jest.Mock> & { appearance: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  for (const m of METHODS) {
    b[m] = m in resolves ? jest.fn(async () => resolves[m]) : jest.fn();
  }
  for (const m of ['onLifecycleEvent', 'onStatusChange']) b[m] = jest.fn(() => ({ remove: jest.fn() }));
  b.testJsCrash = jest.fn();
  b.startTransaction = jest.fn(() => makeSpan());
  b.startSpan = jest.fn(() => makeSpan());
  b.getActiveSpan = jest.fn(() => makeSpan());
  b.createReport = jest.fn(async () => ({
    read: jest.fn(), update: jest.fn(), addFileAttachment: jest.fn(), addDataAttachment: jest.fn(),
    upload: jest.fn(async () => true),
  }));
  // Pass-through, like the real wrap renders Root unchanged: render tests of the root layout keep working.
  b.wrap = jest.fn((Root: unknown) => Root);
  b.appearance = {};
  return b as never;
}

const passThrough = ({ children }: { children?: React.ReactNode }) => React.createElement(View, null, children);

module.exports = {
  ...actual,
  __esModule: true,
  default: makeBugsee(),
  BugseeSecure: passThrough,
  ErrorBoundary: passThrough,
};
