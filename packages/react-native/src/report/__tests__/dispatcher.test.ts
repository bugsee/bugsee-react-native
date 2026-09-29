// The dispatcher holds real module-level state (the current handler, whether
// it has subscribed) that must not leak between tests, so every test starts
// from a freshly required module -- exactly the singleton `jest.resetModules`
// exists for. `native` is re-required alongside it: after `resetModules`, the
// dispatcher's own `require('../NativeBugsee')` re-runs the mock factory and
// gets a NEW mock instance, so a `native` bound before the reset would be
// asserting against the wrong object.
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';
import type { setReportHandler as SetReportHandler } from '../dispatcher';
import type { BugseeReport } from '../types';
import { ReportErrorCode } from '../errors';

let native: typeof NativeMock;
let setReportHandler: typeof SetReportHandler;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  ({ native } = require('../../__mocks__/native'));
  ({ setReportHandler } = require('../dispatcher'));
});

afterEach(() => {
  jest.useRealTimers();
});

/** Drains the microtask queue -- generously, since idling on an unresolved
 * promise is harmless and the exact number of hops through
 * `.then().catch().finally()` is an implementation detail. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function emit(overrides: Partial<{
  handleId: string;
  phase: string;
  reportId: string;
  type: string;
  deadlineMs: number;
}> = {}): void {
  native.emitReportHandlerRequest({
    handleId: 'h1',
    phase: 'before',
    reportId: 'r1',
    type: 'bug',
    deadlineMs: 5000,
    ...overrides,
  });
}

describe('setReportHandler', () => {
  it('invokes onBeforeReportCreated for phase "before" and completes after it resolves', async () => {
    let received: BugseeReport | undefined;
    setReportHandler({
      onBeforeReportCreated: (report) => {
        received = report;
      },
    });

    emit({ handleId: 'h1', phase: 'before' });
    await flush();

    expect(received).toBeDefined();
    expect(received?.id).toBe('r1');
    expect(native.completeReportHandler).toHaveBeenCalledWith('h1');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
  });

  it('invokes onAfterReportCreated for phase "after"', async () => {
    let received: BugseeReport | undefined;
    setReportHandler({
      onAfterReportCreated: (report) => {
        received = report;
      },
    });

    emit({ handleId: 'h2', phase: 'after', type: 'crash' });
    await flush();

    expect(received).toBeDefined();
    expect(received?.type).toBe('crash');
    expect(native.completeReportHandler).toHaveBeenCalledWith('h2');
  });

  // A bare `callback(proxy)` call reads `handler?.onAfterReportCreated` off
  // its object and invokes it detached from that object, so a class-based
  // handler's `this` would be `undefined` inside the method -- the resulting
  // TypeError gets caught and logged as "the handler threw", so the handler
  // would silently do nothing rather than fail loudly. The dispatcher must
  // call back on the handler it read the method from.
  it('invokes a class-instance handler method with the handler as `this`', async () => {
    native.reportUpdate.mockResolvedValue(undefined);

    class RecordingHandler {
      readonly tag = 'from-this';

      onAfterReportCreated(report: BugseeReport): Promise<void> {
        // Reads `this` -- a detached call makes this throw instead.
        return report.setLabels([this.tag]);
      }
    }

    setReportHandler(new RecordingHandler());

    emit({ handleId: 'h2b', phase: 'after' });
    await flush();

    expect(native.reportUpdate).toHaveBeenCalledWith('h2b', {
      labels: ['from-this'],
    });
    expect(native.completeReportHandler).toHaveBeenCalledWith('h2b');
  });

  it('completes immediately when no handler is set', () => {
    // A handler must have existed once to force the native subscription --
    // otherwise the event never reaches the dispatcher at all. Both phases
    // are exercised: a null handler must be safe for whichever ternary
    // branch a phase takes.
    setReportHandler({
      onBeforeReportCreated: () => {},
      onAfterReportCreated: () => {},
    });
    setReportHandler(null);

    emit({ handleId: 'h3', phase: 'before' });
    emit({ handleId: 'h3b', phase: 'after' });

    expect(native.completeReportHandler).toHaveBeenCalledWith('h3');
    expect(native.completeReportHandler).toHaveBeenCalledWith('h3b');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(2);
  });

  it('completes immediately when the phase has no callback', () => {
    setReportHandler({ onBeforeReportCreated: () => {} });

    emit({ handleId: 'h4', phase: 'after' });

    expect(native.completeReportHandler).toHaveBeenCalledWith('h4');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
  });

  it('completes exactly once when the callback throws synchronously', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setReportHandler({
      onBeforeReportCreated: () => {
        throw new Error('boom');
      },
    });

    emit({ handleId: 'h5' });
    await flush();

    expect(native.completeReportHandler).toHaveBeenCalledWith('h5');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Bugsee] report handler threw',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('completes exactly once when the callback rejects, and nothing is unhandled', async () => {
    // Real timers for this one test: Node only reports an unhandled
    // rejection after a full macrotask boundary passes with the rejection
    // still unhandled, not merely after the microtask queue drains -- a
    // `flush()` of `await Promise.resolve()` never crosses that boundary, so
    // detaching the listener right after it would let this test pass even
    // with the dispatcher's `.catch` deleted. Fake timers also fake
    // `setImmediate`, which is exactly the macrotask boundary this needs, so
    // they have to come out for this test specifically.
    jest.useRealTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    setReportHandler({
      onAfterReportCreated: async () => {
        throw new Error('nope');
      },
    });

    emit({ handleId: 'h6', phase: 'after' });
    await flush();
    // Crosses a real macrotask boundary, so a rejection still unhandled at
    // this point would have been reported by now.
    await new Promise((resolve) => setImmediate(resolve));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(native.completeReportHandler).toHaveBeenCalledWith('h6');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a throwing completeReportHandler is logged, never an unhandled rejection', async () => {
    // Real timers, for the macrotask boundary: see the test above.
    jest.useRealTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const failure = new Error('bridge is gone');
    native.completeReportHandler.mockImplementation(() => {
      throw failure;
    });

    setReportHandler({ onAfterReportCreated: () => {} });
    emit({ handleId: 'h10', phase: 'after' });
    await flush();
    await new Promise((resolve) => setImmediate(resolve));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(native.completeReportHandler).toHaveBeenCalledWith('h10');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Bugsee] could not complete the report handler',
      failure,
    );
    errorSpy.mockRestore();
  });

  it('setReportHandler(null) tells native no phase is wanted', () => {
    setReportHandler(null);

    expect(native.setReportHandlerPhases).toHaveBeenCalledWith(false, false);
  });

  it('setReportHandler(null) as the very first call never subscribes', () => {
    setReportHandler(null);

    expect(native.reportHandlerRequestListenerCount()).toBe(0);
  });

  it('subscribes to onReportHandlerRequest at most once across repeated calls', () => {
    setReportHandler({ onBeforeReportCreated: () => {} });
    expect(native.reportHandlerRequestSubscribeCallCount()).toBe(1);

    setReportHandler({ onAfterReportCreated: () => {} });
    setReportHandler(null);
    setReportHandler({ onBeforeReportCreated: () => {} });

    expect(native.reportHandlerRequestSubscribeCallCount()).toBe(1);
    expect(native.reportHandlerRequestListenerCount()).toBe(1);
  });

  it('an unrecognised phase completes immediately without invoking any callback', () => {
    const seen: string[] = [];
    setReportHandler({
      onBeforeReportCreated: () => {
        seen.push('before');
      },
      onAfterReportCreated: () => {
        seen.push('after');
      },
    });

    emit({ handleId: 'h8', phase: 'duringLaunchRecovery' });

    expect(seen).toEqual([]);
    expect(native.completeReportHandler).toHaveBeenCalledWith('h8');
  });

  it('the proxy dies once the callback settles, before its deadline, and its timer is cleared', async () => {
    let captured: BugseeReport | undefined;
    setReportHandler({
      onBeforeReportCreated: (report) => {
        captured = report;
      },
    });

    emit({ handleId: 'h9', deadlineMs: 60000 });
    await flush();

    expect(native.completeReportHandler).toHaveBeenCalledWith('h9');
    // The deadline timer must be cleared once the callback settles -- a timer
    // still pending here would mean it leaks until it fires on its own.
    expect(jest.getTimerCount()).toBe(0);

    await expect(captured?.getSummary()).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
  });

  it('registers only the phases the handler defines', () => {
    setReportHandler({ onAfterReportCreated: () => {} });
    expect(native.setReportHandlerPhases).toHaveBeenLastCalledWith(false, true);

    setReportHandler({
      onBeforeReportCreated: () => {},
      onAfterReportCreated: () => {},
    });
    expect(native.setReportHandlerPhases).toHaveBeenLastCalledWith(true, true);

    setReportHandler({ onBeforeReportCreated: () => {} });
    expect(native.setReportHandlerPhases).toHaveBeenLastCalledWith(true, false);
  });

  it('a handler replaced mid-flight finishes with the callback captured at dispatch', async () => {
    const secondSeen: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    setReportHandler({
      onAfterReportCreated: async () => {
        // Replaces the handler from inside the in-flight callback, so the
        // swap is guaranteed to land before this delivery settles.
        setReportHandler({
          onAfterReportCreated: () => {
            secondSeen.push('called');
          },
        });
        await firstGate;
      },
    });

    emit({ handleId: 'h7', phase: 'after' });
    await flush();

    releaseFirst();
    await flush();

    expect(secondSeen).toEqual([]);
    expect(native.completeReportHandler).toHaveBeenCalledWith('h7');
    expect(native.completeReportHandler).toHaveBeenCalledTimes(1);
  });

  it('two onAfter deliveries for one report get two independent proxies', async () => {
    const seen: BugseeReport[] = [];
    setReportHandler({
      onAfterReportCreated: (report) => {
        seen.push(report);
      },
    });

    emit({ handleId: 'hA', phase: 'after' });
    emit({ handleId: 'hB', phase: 'after' });
    await flush();

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(native.completeReportHandler).toHaveBeenCalledWith('hA');
    expect(native.completeReportHandler).toHaveBeenCalledWith('hB');
  });

  it('the proxy dies at deadlineMs even if the callback never settles', async () => {
    let captured: BugseeReport | undefined;
    setReportHandler({
      onAfterReportCreated: (report) => {
        captured = report;
        return new Promise<void>(() => {
          // Never settles.
        });
      },
    });

    emit({ handleId: 'hC', phase: 'after', deadlineMs: 1000 });
    await flush();

    jest.advanceTimersByTime(1000);
    await flush();

    expect(captured).toBeDefined();
    await expect(captured?.getSummary()).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
    expect(native.reportRead).not.toHaveBeenCalled();
    // The callback never settled, so JS must never tell native it did.
    expect(native.completeReportHandler).not.toHaveBeenCalled();
  });
});
