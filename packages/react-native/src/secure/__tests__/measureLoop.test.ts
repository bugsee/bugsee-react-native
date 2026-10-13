/**
 * One timer re-measures every mounted `<BugseeSecure>`. `onLayout` does not
 * fire when an ancestor scrolls, so without the loop a region measured once
 * stays where the view used to be while the view itself is recorded.
 */
import type * as LoopModule from '../measureLoop';

type Loop = typeof LoopModule;

let loop: Loop;

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  loop = require('../measureLoop');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the shared re-measure loop', () => {
  it('one interval serves every measurer', () => {
    const setInterval = jest.spyOn(globalThis, 'setInterval');
    const first = jest.fn();
    const second = jest.fn();

    loop.addMeasurer(first);
    loop.addMeasurer(second);

    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('the interval stops when the last measurer leaves', () => {
    const first = jest.fn();
    const second = jest.fn();
    const removeFirst = loop.addMeasurer(first);
    const removeSecond = loop.addMeasurer(second);

    removeFirst();
    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    removeSecond();
    expect(jest.getTimerCount()).toBe(0);
    // A remover called again once the loop is idle is harmless.
    expect(() => removeSecond()).not.toThrow();

    // And starts again for the next one.
    const third = jest.fn();
    loop.addMeasurer(third);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    expect(third).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ticks every 100 ms', () => {
    expect(loop.SECURE_REMEASURE_MS).toBe(100);
    const measure = jest.fn();
    loop.addMeasurer(measure);

    jest.advanceTimersByTime(99);
    expect(measure).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(measure).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(100);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  // Two components may share one measure function; removing one must not
  // stop measuring the other, and a stale remover must not remove anything.
  it('removes only the registration it was returned for', () => {
    const measure = jest.fn();
    const removeFirst = loop.addMeasurer(measure);
    loop.addMeasurer(measure);

    removeFirst();
    removeFirst();
    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    expect(measure).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  // A region nobody re-measures goes stale while its view moves, so one
  // broken measurer must not starve the rest.
  it('a throwing measurer does not starve the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('boom');
    loop.addMeasurer(() => {
      throw error;
    });
    const healthy = jest.fn();
    loop.addMeasurer(healthy);

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    expect(healthy).toHaveBeenCalledTimes(1);
    // The class name only: the error's message is the app's, and may carry app data.
    expect(warn).toHaveBeenCalledWith('[Bugsee] a secure-region measurer threw', 'Error');
  });

  // errorName runs inside the isolating catch; an error whose name getter
  // throws must not escape it and abort the tick.
  it('a measurer throwing an error with a throwing name still does not starve the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    class Weird extends Error {
      override get name(): string {
        throw this;
      }
    }
    loop.addMeasurer(() => {
      throw new Weird('s3cret');
    });
    const healthy = jest.fn();
    loop.addMeasurer(healthy);

    // Not `.not.toThrow()`: Jest would describe the thrown value by reading
    // the same hostile `name`.
    let escaped = false;
    try {
      jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    } catch {
      escaped = true;
    }
    expect(escaped).toBe(false);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] a secure-region measurer threw', 'Error');
  });
});


// While a view is withdrawn as hidden, or clipped, it re-measures before
// every frame, so it is masked again (or follows a scroll into view) within a
// frame rather than a 100 ms tick.
describe('the shared per-frame re-measure', () => {
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  let frames: Map<number, () => void>;
  let cancelled: number[];

  /** Installs a fake requestAnimationFrame, or only one half of it. */
  function fakeFrames(halves: Array<'request' | 'cancel'> = ['request', 'cancel']): void {
    frames = new Map();
    cancelled = [];
    let next = 0;
    if (halves.includes('request')) {
      g.requestAnimationFrame = (callback: () => void) => {
        next += 1;
        frames.set(next, callback);
        return next;
      };
    }
    if (halves.includes('cancel')) {
      g.cancelAnimationFrame = (handle: number) => {
        cancelled.push(handle);
        frames.delete(handle);
      };
    }
  }

  /** Runs the one pending frame. */
  function runFrame(): void {
    expect(frames.size).toBe(1);
    const [handle, callback] = [...frames][0]!;
    frames.delete(handle);
    callback();
  }

  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
    jest.dontMock('../ancestry');
  });

  it('one frame callback serves every frame measurer, in one measure pass', () => {
    fakeFrames();
    const passes: unknown[] = [];
    jest.doMock('../ancestry', () => ({
      measurePass: (pass: () => void) => {
        passes.push(pass);
        pass();
      },
    }));
    jest.resetModules();
    loop = require('../measureLoop');
    const first = jest.fn();
    const second = jest.fn();

    loop.addFrameMeasurer(first);
    loop.addFrameMeasurer(second);
    expect(frames.size).toBe(1);

    runFrame();
    expect(passes).toHaveLength(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // And again before the next frame, while any are left.
    expect(frames.size).toBe(1);
  });

  it('stops requesting frames when the last frame measurer leaves', () => {
    fakeFrames();
    const removeFirst = loop.addFrameMeasurer(jest.fn());
    const removeSecond = loop.addFrameMeasurer(jest.fn());

    removeFirst();
    expect(cancelled).toEqual([]);
    removeSecond();
    expect(cancelled).toEqual([1]);
    expect(frames.size).toBe(0);
  });

  it('requests no next frame when the measurers left during the frame', () => {
    fakeFrames();
    let remove: () => void = () => undefined;
    remove = loop.addFrameMeasurer(() => remove());

    runFrame();

    expect(frames.size).toBe(0);
  });

  it('starts again for a measurer added after it stopped', () => {
    fakeFrames();
    loop.addFrameMeasurer(jest.fn())();
    const measure = jest.fn();

    loop.addFrameMeasurer(measure);
    runFrame();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('one measurer that throws does not stop the rest', () => {
    fakeFrames();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('detached');
    const later = jest.fn();
    loop.addFrameMeasurer(() => {
      throw failure;
    });
    loop.addFrameMeasurer(later);

    runFrame();

    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] a secure-region measurer threw', failure.name);
    expect(frames.size).toBe(1);
  });

  it.each([
    ['no requestAnimationFrame', []],
    ['only requestAnimationFrame', ['request']],
    ['only cancelAnimationFrame', ['cancel']],
  ] as Array<[string, Array<'request' | 'cancel'>]>)('falls back to a timer with %s', (_, halves) => {
    fakeFrames(halves);
    const measure = jest.fn();
    const remove = loop.addFrameMeasurer(measure);

    jest.advanceTimersByTime(loop.FRAME_MS - 1);
    expect(measure).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    remove();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('frames run beside the tick, each on its own', () => {
    fakeFrames();
    const ticked = jest.fn();
    const framed = jest.fn();
    loop.addMeasurer(ticked);
    loop.addFrameMeasurer(framed);

    runFrame();
    expect([ticked.mock.calls.length, framed.mock.calls.length]).toEqual([0, 1]);
    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    expect([ticked.mock.calls.length, framed.mock.calls.length]).toEqual([1, 1]);
  });
});
