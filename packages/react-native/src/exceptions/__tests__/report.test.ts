jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { buildExceptionPayload } from '../payload';
import { encodeBridgeObject } from '../../bridge/json';
import { encodeExceptionOptions } from '../options';

beforeEach(() => {
  // Fresh WeakSet / warn-once flag: markReported is module-global.
  jest.resetModules();
});

/**
 * Re-require report AND the native mock after resetModules so both share the
 * same mock instance (resetModules re-evaluates `__mocks__/native`).
 */
function load(): {
  reportHandled: typeof import('../report').reportHandled;
  reportUnhandled: typeof import('../report').reportUnhandled;
  EXCEPTION_MAX_AGGREGATE: number;
  UNHANDLED_REPORT_WAIT_MS: number;
  native: typeof import('../../__mocks__/native').native;
} {
  const { native } = require('../../__mocks__/native') as typeof import('../../__mocks__/native');
  native.reset();
  const report = require('../report') as typeof import('../report');
  return {
    reportHandled: report.reportHandled,
    reportUnhandled: report.reportUnhandled,
    EXCEPTION_MAX_AGGREGATE: report.EXCEPTION_MAX_AGGREGATE,
    UNHANDLED_REPORT_WAIT_MS: report.UNHANDLED_REPORT_WAIT_MS,
    native,
  };
}

describe('report', () => {
  it('a handled error crosses as its payload and options', () => {
    const { reportHandled: report, native } = load();
    const error = new Error('boom');
    report(error, { domain: 'auth', labels: ['a'], includeVideo: false });
    const payload = buildExceptionPayload({
      error,
      platformOS: 'android',
    });
    expect(native.logException).toHaveBeenCalledTimes(1);
    expect(native.logException).toHaveBeenCalledWith(
      encodeBridgeObject(payload as unknown as Record<string, unknown>),
      encodeExceptionOptions({ domain: 'auth', labels: ['a'], includeVideo: false }),
    );
  });

  it('an unhandled error crosses to logUnhandledException', async () => {
    const { reportUnhandled: report, native } = load();
    const error = new Error('fatal');
    await report(error);
    const payload = buildExceptionPayload({ error, platformOS: 'android' });
    expect(native.logUnhandledException).toHaveBeenCalledTimes(1);
    expect(native.logUnhandledException).toHaveBeenCalledWith(
      encodeBridgeObject(payload as unknown as Record<string, unknown>),
    );
  });

  it('an object is reported once, whichever route sees it first', async () => {
    const {
      reportHandled: handled,
      reportUnhandled: unhandled,
      native,
    } = load();
    const error = new Error('once');
    handled(error);
    expect(native.logException).toHaveBeenCalledTimes(1);
    handled(error);
    expect(native.logException).toHaveBeenCalledTimes(1);
    await unhandled(error);
    expect(native.logUnhandledException).not.toHaveBeenCalled();
  });

  it('a primitive is reported every time', () => {
    const { reportHandled: report, native } = load();
    report('a');
    report('a');
    report(42);
    report(42);
    expect(native.logException).toHaveBeenCalledTimes(4);
  });

  it('a handled AggregateError is split, first 10 only', () => {
    const {
      reportHandled: report,
      EXCEPTION_MAX_AGGREGATE: cap,
      native,
    } = load();
    expect(cap).toBe(10);
    const inners = Array.from({ length: 12 }, (_, i) => new Error(`inner-${i}`));
    report(new AggregateError(inners, 'agg'));
    expect(native.logException).toHaveBeenCalledTimes(10);
    for (let i = 0; i < 10; i += 1) {
      const payload = buildExceptionPayload({
        error: inners[i],
        platformOS: 'android',
      });
      expect(native.logException).toHaveBeenNthCalledWith(
        i + 1,
        encodeBridgeObject(payload as unknown as Record<string, unknown>),
        null,
      );
    }
  });

  it('a shared Error crosses once when reported as an inner then as an AggregateError', () => {
    const { reportHandled: report, native } = load();
    const inner = new Error('shared');
    report(inner);
    expect(native.logException).toHaveBeenCalledTimes(1);
    report(new AggregateError([inner], 'agg'));
    expect(native.logException).toHaveBeenCalledTimes(1);
  });

  it('a shared Error crosses once when reported as an AggregateError then as an inner', () => {
    const { reportHandled: report, native } = load();
    const inner = new Error('shared');
    report(new AggregateError([inner], 'agg'));
    expect(native.logException).toHaveBeenCalledTimes(1);
    report(inner);
    expect(native.logException).toHaveBeenCalledTimes(1);
  });

  it('an unhandled AggregateError is one report', async () => {
    const { reportUnhandled: report, native } = load();
    const agg = new AggregateError([new Error('a'), new Error('b')], 'agg');
    await report(agg);
    expect(native.logUnhandledException).toHaveBeenCalledTimes(1);
    const payload = buildExceptionPayload({ error: agg, platformOS: 'android' });
    expect(native.logUnhandledException).toHaveBeenCalledWith(
      encodeBridgeObject(payload as unknown as Record<string, unknown>),
    );
  });

  it('reportUnhandled resolves when native resolves', async () => {
    const { reportUnhandled: report, native } = load();
    let resolveNative!: () => void;
    native.logUnhandledException.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveNative = resolve;
      }),
    );
    let settled = false;
    const p = report(new Error('wait')).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveNative();
    await p;
    expect(settled).toBe(true);
  });

  it('reportUnhandled resolves after 1500 ms when native never does', async () => {
    jest.useFakeTimers();
    try {
      const { reportUnhandled: report, UNHANDLED_REPORT_WAIT_MS: wait, native } =
        load();
      expect(wait).toBe(1500);
      native.logUnhandledException.mockReturnValue(new Promise(() => {}));
      let settled = false;
      const p = report(new Error('hang')).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1499);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await p;
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reportUnhandled resolves, and warns once, when native rejects or throws', async () => {
    const { reportUnhandled: report, native } = load();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      native.logUnhandledException.mockRejectedValue(new Error('native fail'));
      await expect(report(new Error('a'))).resolves.toBeUndefined();
      native.logUnhandledException.mockImplementation(() => {
        throw new Error('sync throw');
      });
      await expect(report(new Error('b'))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reportHandled never throws, even when native throws', () => {
    const { reportHandled: report, native } = load();
    native.logException.mockImplementation(() => {
      throw new Error('native boom');
    });
    expect(() => report(new Error('x'))).not.toThrow();
  });

  it('a payload with a lone surrogate crosses well-formed', () => {
    const { reportHandled: report, native } = load();
    const cut = 'hi \u{1F600}'.slice(0, 4);
    const error = new Error(cut);
    report(error);
    expect(native.logException).toHaveBeenCalledTimes(1);
    const [payloadJson] = native.logException.mock.calls[0]!;
    expect(typeof payloadJson).toBe('string');
    expect(payloadJson).toContain('\uFFFD');
    expect(() => JSON.parse(payloadJson as string)).not.toThrow();
    const raw = buildExceptionPayload({ error, platformOS: 'android' });
    expect(payloadJson).toBe(
      encodeBridgeObject(raw as unknown as Record<string, unknown>),
    );
  });
});
