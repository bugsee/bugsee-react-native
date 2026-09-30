jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { HandlerEnv, RejectionOptions } from '../handlers';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useRealTimers();
});

type HandlerMod = typeof import('../handlers');
type ReportMod = typeof import('../report');
type NativeMod = typeof import('../../__mocks__/native');

function load(envOverrides: Partial<HandlerEnv> = {}): {
  installExceptionHandlers: HandlerMod['installExceptionHandlers'];
  setExceptionCaptureEnabled: HandlerMod['setExceptionCaptureEnabled'];
  markReported: ReportMod['markReported'];
  reportHandled: jest.Mock;
  reportUnhandled: jest.Mock;
  native: NativeMod['native'];
  env: HandlerEnv;
  previous: jest.Mock;
  getHandler: () => (error: unknown, isFatal?: boolean) => void;
  lastRejectionOptions: () => RejectionOptions | undefined;
} {
  const previous = jest.fn();
  let currentHandler: (error: unknown, isFatal?: boolean) => void = previous;
  const errorUtils = {
    getGlobalHandler: jest.fn(() => currentHandler),
    setGlobalHandler: jest.fn((handler: (error: unknown, isFatal?: boolean) => void) => {
      currentHandler = handler;
    }),
  };

  let lastRejectionOptions: RejectionOptions | undefined;
  const hermesEnable = jest.fn((options: RejectionOptions) => {
    lastRejectionOptions = options;
  });
  const promiseLibEnable = jest.fn((options: RejectionOptions) => {
    lastRejectionOptions = options;
  });

  const rnOnUnhandled = jest.fn();
  const rnOnHandled = jest.fn();

  const { native } = require('../../__mocks__/native') as NativeMod;
  native.reset();

  const reportHandled = jest.fn();
  const reportUnhandled = jest.fn(() => Promise.resolve());
  jest.doMock('../report', () => {
    const actual = jest.requireActual('../report') as ReportMod;
    return {
      ...actual,
      reportHandled,
      reportUnhandled,
    };
  });

  const handlers = require('../handlers') as HandlerMod;
  const report = require('../report') as ReportMod;

  const env: HandlerEnv = {
    errorUtils: () => errorUtils,
    enableHermesTracker: () => hermesEnable,
    enablePromiseLibraryTracker: () => promiseLibEnable,
    rnDevRejectionOptions: () => ({
      onUnhandled: rnOnUnhandled,
      onHandled: rnOnHandled,
    }),
    isDev: true,
    ...envOverrides,
  };

  return {
    installExceptionHandlers: handlers.installExceptionHandlers,
    setExceptionCaptureEnabled: handlers.setExceptionCaptureEnabled,
    markReported: report.markReported,
    reportHandled,
    reportUnhandled,
    native,
    env,
    previous,
    getHandler: () => currentHandler,
    lastRejectionOptions: () => lastRejectionOptions,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('exception handlers', () => {
  it('installs once however often launch runs', () => {
    const { installExceptionHandlers, env } = load();
    const errorUtils = env.errorUtils()!;
    installExceptionHandlers(env);
    installExceptionHandlers(env);
    installExceptionHandlers(env);
    expect(errorUtils.setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(env.enableHermesTracker()!).toHaveBeenCalledTimes(1);
  });

  it('a fatal error is reported as unhandled, then the previous handler runs with the same arguments', async () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('fatal');
    getHandler()(error, true);
    expect(reportUnhandled).toHaveBeenCalledWith(error);
    expect(previous).not.toHaveBeenCalled();
    await flush();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('the previous handler waits for the report, at most 1500 ms', async () => {
    jest.useFakeTimers();
    try {
      const {
        installExceptionHandlers,
        setExceptionCaptureEnabled,
        reportUnhandled,
        previous,
        getHandler,
        env,
      } = load();
      let resolveReport!: () => void;
      reportUnhandled.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveReport = resolve;
          }),
      );
      installExceptionHandlers(env);
      setExceptionCaptureEnabled(true);
      const error = new Error('fatal-wait');
      getHandler()(error, true);
      expect(previous).not.toHaveBeenCalled();

      await flush();
      expect(previous).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1499);
      await flush();
      expect(previous).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await flush();
      expect(previous).toHaveBeenCalledTimes(1);
      expect(previous).toHaveBeenCalledWith(error, true);

      // Settling later must not run previous a second time.
      resolveReport();
      await flush();
      expect(previous).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the previous handler runs even when reporting throws', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      previous,
      getHandler,
      env,
    } = load();
    reportHandled.mockImplementation(() => {
      throw new Error('report boom');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('nonfatal');
    getHandler()(error, false);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a non-fatal error is reported as handled and the previous handler runs synchronously', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('soft');
    getHandler()(error, false);
    expect(reportHandled).toHaveBeenCalledWith(error);
    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, false);
  });

  it('an error already reported is not reported again, and the previous handler still runs', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      markReported,
      reportHandled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('once');
    expect(markReported(error)).toBe(true);
    getHandler()(error, false);
    expect(reportHandled).not.toHaveBeenCalled();
    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, false);
  });

  it('detect.crash false: nothing is reported, and the previous handler still runs', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(false);
    const error = new Error('off');
    getHandler()(error, true);
    expect(reportHandled).not.toHaveBeenCalled();
    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('relaunch can turn capture back on', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(false);
    getHandler()(new Error('a'), false);
    expect(reportHandled).not.toHaveBeenCalled();
    setExceptionCaptureEnabled(true);
    const error = new Error('b');
    getHandler()(error, false);
    expect(reportHandled).toHaveBeenCalledWith(error);
    expect(previous).toHaveBeenCalledWith(error, false);
  });

  it('with Hermes, an unhandled rejection is reported as handled', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      env,
      lastRejectionOptions,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const rejection = new Error('rej');
    lastRejectionOptions()!.onUnhandled(1, rejection);
    expect(reportHandled).toHaveBeenCalledWith(rejection);
  });

  it("in dev, RN's own rejection handlers still run", () => {
    const rnOnUnhandled = jest.fn();
    const rnOnHandled = jest.fn();
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      env,
      lastRejectionOptions,
    } = load({
      isDev: true,
      rnDevRejectionOptions: () => ({
        onUnhandled: rnOnUnhandled,
        onHandled: rnOnHandled,
      }),
    });
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const rejection = new Error('dev-rej');
    lastRejectionOptions()!.onUnhandled(7, rejection);
    expect(rnOnUnhandled).toHaveBeenCalledWith(7, rejection);
    lastRejectionOptions()!.onHandled(7);
    expect(rnOnHandled).toHaveBeenCalledWith(7);
  });

  it('in release, no RN rejection handlers are called', () => {
    const rnOnUnhandled = jest.fn();
    const rnOnHandled = jest.fn();
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      env,
      lastRejectionOptions,
    } = load({
      isDev: false,
      rnDevRejectionOptions: () => ({
        onUnhandled: rnOnUnhandled,
        onHandled: rnOnHandled,
      }),
    });
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    lastRejectionOptions()!.onUnhandled(3, new Error('rel'));
    lastRejectionOptions()!.onHandled(3);
    expect(rnOnUnhandled).not.toHaveBeenCalled();
    expect(rnOnHandled).not.toHaveBeenCalled();
  });

  it("without Hermes, the promise library's tracker gets the same options", () => {
    const {
      installExceptionHandlers,
      env,
      lastRejectionOptions,
    } = load({
      enableHermesTracker: () => undefined,
    });
    const promiseEnable = env.enablePromiseLibraryTracker()!;
    installExceptionHandlers(env);
    expect(promiseEnable).toHaveBeenCalledTimes(1);
    const options = lastRejectionOptions();
    expect(options).toEqual(
      expect.objectContaining({
        allRejections: true,
        onUnhandled: expect.any(Function),
        onHandled: expect.any(Function),
      }),
    );
  });

  it('onHandled reports nothing', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      reportUnhandled,
      env,
      lastRejectionOptions,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    lastRejectionOptions()!.onHandled(9);
    expect(reportHandled).not.toHaveBeenCalled();
    expect(reportUnhandled).not.toHaveBeenCalled();
  });

  it('without ErrorUtils, only the rejection tracker is installed, with one warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const hermesEnable = jest.fn();
    const {
      installExceptionHandlers,
      env,
    } = load({
      errorUtils: () => undefined,
      enableHermesTracker: () => hermesEnable,
    });
    installExceptionHandlers(env);
    installExceptionHandlers(env);
    expect(hermesEnable).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      '[Bugsee] ErrorUtils is unavailable; uncaught JS errors are not reported',
    );
    warn.mockRestore();
  });

  it('detect.crash false: an unhandled rejection is not reported', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      env,
      lastRejectionOptions,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(false);
    lastRejectionOptions()!.onUnhandled(1, new Error('off-rej'));
    expect(reportHandled).not.toHaveBeenCalled();
  });

  it('an already-reported rejection is not reported again', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      markReported,
      reportHandled,
      env,
      lastRejectionOptions,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const rejection = new Error('once-rej');
    expect(markReported(rejection)).toBe(true);
    lastRejectionOptions()!.onUnhandled(2, rejection);
    expect(reportHandled).not.toHaveBeenCalled();
  });

  it('in dev, missing RN rejection options do not throw', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      env,
      lastRejectionOptions,
    } = load({
      isDev: true,
      rnDevRejectionOptions: () => undefined,
    });
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const rejection = new Error('no-rn');
    expect(() => lastRejectionOptions()!.onUnhandled(4, rejection)).not.toThrow();
    expect(() => lastRejectionOptions()!.onHandled(4)).not.toThrow();
    expect(reportHandled).toHaveBeenCalledWith(rejection);
  });

  it('in dev, RN options without onUnhandled/onHandled do not throw', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      env,
      lastRejectionOptions,
    } = load({
      isDev: true,
      rnDevRejectionOptions: () => ({}),
    });
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    expect(() => lastRejectionOptions()!.onUnhandled(5, new Error('partial'))).not.toThrow();
    expect(() => lastRejectionOptions()!.onHandled(5)).not.toThrow();
  });

  it('capture defaults to enabled without setExceptionCaptureEnabled', () => {
    const {
      installExceptionHandlers,
      reportHandled,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    // Deliberately skip setExceptionCaptureEnabled — the module default is on.
    const error = new Error('default-on');
    getHandler()(error, false);
    expect(reportHandled).toHaveBeenCalledWith(error);
  });

  it('with neither Hermes nor the promise library, install still succeeds', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { installExceptionHandlers, env } = load({
      enableHermesTracker: () => undefined,
      enablePromiseLibraryTracker: () => undefined,
    });
    expect(() => installExceptionHandlers(env)).not.toThrow();
    warn.mockRestore();
  });

  it('isFatal omitted is treated as handled, not unhandled', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('no-flag');
    getHandler()(error);
    expect(reportHandled).toHaveBeenCalledWith(error);
    expect(reportUnhandled).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledWith(error, undefined);
  });

  it('a fatal report that settles before the deadline runs previous once', async () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportUnhandled,
      previous,
      getHandler,
      env,
    } = load();
    reportUnhandled.mockImplementation(() => Promise.resolve());
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    const error = new Error('fast-fatal');
    getHandler()(error, true);
    expect(previous).not.toHaveBeenCalled();
    await flush();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('reporting that throws warns once across errors', () => {
    const {
      installExceptionHandlers,
      setExceptionCaptureEnabled,
      reportHandled,
      previous,
      getHandler,
      env,
    } = load();
    reportHandled.mockImplementation(() => {
      throw new Error('report boom');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installExceptionHandlers(env);
    setExceptionCaptureEnabled(true);
    getHandler()(new Error('a'), false);
    getHandler()(new Error('b'), false);
    expect(previous).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Bugsee] exception handler failed while reporting',
    );
    warn.mockRestore();
  });
});
