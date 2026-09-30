/**
 * `RootErrorReporter` (and `Bugsee.wrap` which mounts it) reports an uncaught
 * render error, then rethrows so RN's fatal path still runs. Report / capture
 * helpers are mocked so failures here are about the soft-then-fatal sequence.
 */
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';

import type * as HandlersModule from '../handlers';
import type * as ReportModule from '../report';

jest.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android' },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);
jest.mock('../../viewtree/requests', () => ({
  __esModule: true,
  registerAnchor: jest.fn(),
  unregisterAnchor: jest.fn(),
  markWrapComponent: jest.fn(),
}));

let reportUnhandledDeferred: {
  promise: Promise<void>;
  resolve: () => void;
} | undefined;

const reportUnhandled = jest.fn((): Promise<void> => {
  if (reportUnhandledDeferred !== undefined) {
    return reportUnhandledDeferred.promise;
  }
  return Promise.resolve();
});
const markReported = jest.fn(() => true);
const isExceptionCaptureEnabled = jest.fn(() => true);

jest.mock('../report', () => {
  const actual = jest.requireActual('../report') as typeof ReportModule;
  return {
    ...actual,
    get reportUnhandled() {
      return reportUnhandled;
    },
    get markReported() {
      return markReported;
    },
  };
});

jest.mock('../handlers', () => {
  const actual = jest.requireActual('../handlers') as typeof HandlersModule;
  return {
    ...actual,
    get isExceptionCaptureEnabled() {
      return isExceptionCaptureEnabled;
    },
  };
});

import { ErrorBoundary } from '../ErrorBoundary';
import { RootErrorReporter } from '../RootErrorReporter';
import { wrap } from '../../viewtree/anchor';
import { UNHANDLED_REPORT_WAIT_MS } from '../report';

(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: ReactTestRenderer[] = [];
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  reportUnhandledDeferred = undefined;
  markReported.mockImplementation(() => true);
  isExceptionCaptureEnabled.mockImplementation(() => true);
  reportUnhandled.mockImplementation(() => {
    if (reportUnhandledDeferred !== undefined) {
      return reportUnhandledDeferred.promise;
    }
    return Promise.resolve();
  });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.useRealTimers();
});

afterEach(() => {
  act(() => mounted.forEach((renderer) => renderer.unmount()));
  mounted = [];
  consoleError.mockRestore();
  jest.useRealTimers();
});

function render(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock: () => ({}),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(renderer as ReactTestRenderer);
  return renderer as ReactTestRenderer;
}

function ThrowOnce({ error, armed }: { error: unknown; armed: { value: boolean } }): ReactElement {
  if (armed.value) {
    throw error;
  }
  return createElement('child-ok');
}

function deferUnhandled(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  reportUnhandledDeferred = { promise, resolve };
  return reportUnhandledDeferred;
}

describe('RootErrorReporter', () => {
  it('a render error below wrap is reported as unhandled, then rethrown', async () => {
    const error = new Error('root-boom');
    const Wrapped = wrap(function App() {
      return <ThrowOnce error={error} armed={{ value: true }} />;
    });

    let caught: unknown;
    try {
      render(<Wrapped />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } catch (e) {
      caught = e;
    }

    expect(markReported).toHaveBeenCalledWith(error);
    expect(reportUnhandled).toHaveBeenCalledTimes(1);
    expect(reportUnhandled).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        componentStack: expect.stringContaining('ThrowOnce'),
      }),
    );
    expect(caught).toBe(error);
  });

  it('renders nothing while the report is in flight', async () => {
    const error = new Error('in-flight');
    deferUnhandled();

    const renderer = render(
      <RootErrorReporter>
        <ThrowOnce error={error} armed={{ value: true }} />
      </RootErrorReporter>,
    );

    expect(reportUnhandled).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON()).toBeNull();

    let caught: unknown;
    try {
      await act(async () => {
        reportUnhandledDeferred!.resolve();
        await reportUnhandledDeferred!.promise;
        await Promise.resolve();
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(error);
  });

  it('rethrows after 1500 ms when native never answers', async () => {
    jest.useFakeTimers();
    const error = new Error('slow-native');
    reportUnhandled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, UNHANDLED_REPORT_WAIT_MS);
        }),
    );

    let caught: unknown;
    try {
      render(
        <RootErrorReporter>
          <ThrowOnce error={error} armed={{ value: true }} />
        </RootErrorReporter>,
      );
      await act(async () => {
        jest.advanceTimersByTime(UNHANDLED_REPORT_WAIT_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    } catch (e) {
      caught = e;
    }

    expect(reportUnhandled).toHaveBeenCalledTimes(1);
    expect(caught).toBe(error);
  });

  it("an error the app's own boundary catches is never seen by the root", () => {
    const error = new Error('app-caught');

    const renderer = render(
      <RootErrorReporter>
        <ErrorBoundary fallback={createElement('app-fallback')}>
          <ThrowOnce error={error} armed={{ value: true }} />
        </ErrorBoundary>
      </RootErrorReporter>,
    );

    expect(renderer.root.findByType('app-fallback' as never)).toBeTruthy();
    expect(reportUnhandled).not.toHaveBeenCalled();
  });

  it('with detect.crash false it rethrows without reporting', async () => {
    isExceptionCaptureEnabled.mockReturnValue(false);
    const error = new Error('capture-off');

    let caught: unknown;
    try {
      render(
        <RootErrorReporter>
          <ThrowOnce error={error} armed={{ value: true }} />
        </RootErrorReporter>,
      );
      await act(async () => {
        await Promise.resolve();
      });
    } catch (e) {
      caught = e;
    }

    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(caught).toBe(error);
  });

  it('an error already reported is rethrown without a second report', async () => {
    const error = new Error('dup');
    markReported.mockReturnValue(false);

    let caught: unknown;
    try {
      render(
        <RootErrorReporter>
          <ThrowOnce error={error} armed={{ value: true }} />
        </RootErrorReporter>,
      );
      await act(async () => {
        await Promise.resolve();
      });
    } catch (e) {
      caught = e;
    }

    expect(markReported).toHaveBeenCalledWith(error);
    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(caught).toBe(error);
  });
});
