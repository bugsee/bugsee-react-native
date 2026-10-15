/**
 * One timer re-measures every mounted `<BugseeSecure>`. `onLayout` does not
 * fire when an ancestor scrolls, so without the loop a region measured once
 * stays where the view used to be while the view itself is recorded.
 */
import type * as LoopModule from '../measureLoop';

// The loop publishes each tick's and frame's changes together; what that
// does is the registry's, tested there.
const mockTogether: string[] = [];
const mockRetries: boolean[] = [];
jest.mock('../registry', () => ({
  publishTogether: (changes: () => void, retryFailed = false) => {
    mockRetries.push(retryFailed);
    mockTogether.push('start');
    try {
      changes();
    } finally {
      mockTogether.push('end');
    }
  },
}));

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

// Round 3: what a static, clipped view costs is bounded. Its clipping nodes
// are watched (once a frame each, whatever the number of views under them),
// and the tick re-checks every parked view by measuring it alone.
describe('watched nodes and parked views', () => {
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  let where: Map<unknown, unknown>;
  let measured: unknown[];

  beforeEach(() => {
    where = new Map();
    measured = [];
    jest.resetModules();
    jest.doMock('../ancestry', () => ({
      measurePass: (pass: () => void) => pass(),
      measureFiber: (fiber: unknown) => {
        measured.push(fiber);
        const at = where.get(fiber);
        if (at instanceof Error) {
          throw at;
        }
        return at;
      },
    }));
    loop = require('../measureLoop');
  });

  afterEach(() => {
    jest.dontMock('../ancestry');
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  const node = (): never => ({}) as never;
  const frame = (): void => {
    jest.advanceTimersByTime(loop.FRAME_MS);
  };

  it('measures a watched node once a frame, however many watch it, and wakes them when it moves', () => {
    const content = node();
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    const first = jest.fn();
    const second = jest.fn();
    loop.watchNode(content, first);
    loop.watchNode(content, second);

    frame();
    frame();
    // Once when first watched, then once a frame.
    expect(measured).toEqual([content, content, content]);
    expect(first).not.toHaveBeenCalled();

    where.set(content, { x: 0, y: -5, width: 10, height: 10 });
    frame();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['answers nothing', undefined],
    ['answers 0/0/0/0', null],
    ['throws', new Error('detached')],
  ])('wakes when a node that answered goes on to %s, and when it comes back', (_, gone) => {
    const content = node();
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    const moved = jest.fn();
    loop.watchNode(content, moved);
    frame();

    where.set(content, gone);
    frame();
    expect(moved).toHaveBeenCalledTimes(1);
    frame();
    expect(moved).toHaveBeenCalledTimes(1);

    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    frame();
    expect(moved).toHaveBeenCalledTimes(2);
  });

  it('a node watched for its props alone is never measured, and wakes when its props change', () => {
    const host = { memoizedProps: { visible: true } } as never as { memoizedProps: unknown };
    where.set(host, { x: 0, y: 0, width: 10, height: 10 });
    const changed = jest.fn();
    loop.watchNode(host as never, changed, false);
    frame();
    where.set(host, { x: 0, y: 5, width: 10, height: 10 });
    frame();
    expect(measured).toEqual([]);
    expect(changed).not.toHaveBeenCalled();

    host.memoizedProps = { visible: false };
    frame();

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a props-only node is measured from when another subscriber wants its geometry', () => {
    const content = node();
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    loop.watchNode(content, jest.fn(), false);
    const moved = jest.fn();
    loop.watchNode(content, moved);
    loop.watchNode(content, jest.fn(), false);
    expect(measured).toEqual([content]);

    where.set(content, { x: 0, y: 5, width: 10, height: 10 });
    frame();

    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('measures a node as soon as it is watched: a move before the next frame wakes', () => {
    const content = node();
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    const moved = jest.fn();
    loop.watchNode(content, moved);
    expect(measured).toEqual([content]);

    where.set(content, { x: 0, y: 5, width: 10, height: 10 });
    frame();

    expect(moved).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['its own props', (fiber: { memoizedProps: unknown }) => (fiber.memoizedProps = {})],
    [
      'its alternate’s props',
      (fiber: { alternate: { memoizedProps: unknown } }) => (fiber.alternate.memoizedProps = {}),
    ],
  ])('wakes when %s change, though it has not moved', (_, change) => {
    const content = { memoizedProps: {}, alternate: { memoizedProps: {} } } as never;
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    const moved = jest.fn();
    loop.watchNode(content, moved);
    frame();
    expect(moved).not.toHaveBeenCalled();

    change(content);
    frame();
    expect(moved).toHaveBeenCalledTimes(1);
    frame();
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('a node that throws reads as one that does not answer', () => {
    const content = node();
    const moved = jest.fn();
    loop.watchNode(content, moved);
    frame();

    where.set(content, new Error('detached'));
    frame();

    expect(moved).not.toHaveBeenCalled();
  });

  it('tells a node that stopped answering from one answering 0/0/0/0', () => {
    const content = node();
    const moved = jest.fn();
    loop.watchNode(content, moved);
    frame();

    where.set(content, null);
    frame();

    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('stops measuring a node, and frames, once nothing watches it', () => {
    const content = node();
    const stopFirst = loop.watchNode(content, jest.fn());
    const stopSecond = loop.watchNode(content, jest.fn());
    frame();

    stopFirst();
    frame();
    expect(measured).toHaveLength(3);
    stopSecond();
    stopSecond();
    frame();
    expect(measured).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels the pending frame the moment the last watched node is unwatched', () => {
    const stop = loop.watchNode(node(), jest.fn());
    expect(jest.getTimerCount()).toBe(1);

    stop();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('a stale unwatch leaves a node watched again under the same fiber alone', () => {
    const content = node();
    const stop = loop.watchNode(content, jest.fn());
    stop();
    loop.watchNode(content, jest.fn());

    stop();
    frame();

    // Once each time it was first watched, then once a frame.
    expect(measured).toEqual([content, content, content]);
  });

  it('keeps frames running while a node is watched with no frame measurer', () => {
    const content = node();
    loop.watchNode(content, jest.fn());
    const removeMeasurer = loop.addFrameMeasurer(jest.fn());
    removeMeasurer();

    frame();
    frame();

    expect(measured).toHaveLength(3);
  });

  it('keeps frames running while a frame measurer is left and no node is watched', () => {
    const measure = jest.fn();
    loop.addFrameMeasurer(measure);
    loop.watchNode(node(), jest.fn())();

    frame();
    frame();

    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('wakes measurers in the same frame, before running the frame measurers', () => {
    const content = node();
    where.set(content, { x: 0, y: 0, width: 10, height: 10 });
    const measure = jest.fn();
    loop.watchNode(content, () => {
      loop.addFrameMeasurer(measure);
    });
    frame();
    where.set(content, { x: 0, y: 1, width: 10, height: 10 });

    frame();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('keeps the frames going when a measurer throws and so does the warning', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console gone');
    });
    const later = jest.fn();
    loop.addFrameMeasurer(() => {
      throw new Error('detached');
    });
    loop.addFrameMeasurer(later);

    expect(() => frame()).toThrow('console gone');
    // The next frame was still requested, and runs (and throws) again.
    expect(jest.getTimerCount()).toBe(1);
    expect(() => frame()).toThrow('console gone');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('reads a watched value every frame, unmeasured, and wakes on an animation starting, ending or a jump', () => {
    const value: { _animation: unknown; _value: number } = { _animation: null, _value: 0 };
    const first = jest.fn();
    const second = jest.fn();
    loop.watchValue(value, first);
    loop.watchValue(value, second);
    frame();
    expect(first).not.toHaveBeenCalled();

    value._animation = {};
    frame();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    frame();
    expect(first).toHaveBeenCalledTimes(1);

    value._animation = null;
    value._value = 40;
    frame();
    expect(first).toHaveBeenCalledTimes(2);
    expect(measured).toEqual([]);
  });

  it('keeps frames running while a value is watched, and stops them, at once, when none is', () => {
    const value = { _animation: null, _value: 0 };
    const stopFirst = loop.watchValue(value, jest.fn());
    const stopSecond = loop.watchValue(value, jest.fn());
    frame();
    frame();
    expect(jest.getTimerCount()).toBe(1);

    stopFirst();
    expect(jest.getTimerCount()).toBe(1);
    stopSecond();
    stopSecond();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('a stale unwatch leaves a value watched again alone', () => {
    const value: { _animation: unknown; _value: number } = { _animation: null, _value: 0 };
    const stop = loop.watchValue(value, jest.fn());
    stop();
    const changed = jest.fn();
    loop.watchValue(value, changed);
    stop();

    value._value = 1;
    frame();

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a value watched again keeps its first baseline: a change in between wakes', () => {
    const value: { _animation: unknown; _value: number } = { _animation: null, _value: 0 };
    loop.watchValue(value, jest.fn());
    value._value = 5;
    const changed = jest.fn();
    loop.watchValue(value, changed);

    frame();

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('frames stop with a value unwatched while a node is still watched only once that goes too', () => {
    const stopNode = loop.watchNode(node(), jest.fn());
    const stopValue = loop.watchValue({ _animation: null, _value: 0 }, jest.fn());
    stopNode();
    expect(jest.getTimerCount()).toBe(1);

    stopValue();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('re-checks every parked view every tick, however many', () => {
    loop.addMeasurer(jest.fn());
    const checks = Array.from({ length: 200 }, () => jest.fn());
    checks.forEach((check) => loop.addParked(check));

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    expect(checks.every((check) => check.mock.calls.length === 1)).toBe(true);
  });

  it('checks every parked view every tick when there are few, and none once removed', () => {
    loop.addMeasurer(jest.fn());
    const first = jest.fn();
    const second = jest.fn();
    const removeFirst = loop.addParked(first);
    loop.addParked(second);

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS * 2);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 2]);

    removeFirst();
    removeFirst();
    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 3]);
  });

  it('a parked check that throws does not stop the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    loop.addMeasurer(jest.fn());
    const failure = new Error('detached');
    loop.addParked(() => {
      throw failure;
    });
    const later = jest.fn();
    loop.addParked(later);

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] a secure-region measurer threw', failure.name);
  });

  it('a parked view removed during a tick leaves the others checked', () => {
    loop.addMeasurer(jest.fn());
    let removeFirst: () => void = () => undefined;
    const first = jest.fn(() => removeFirst());
    const second = jest.fn();
    removeFirst = loop.addParked(first);
    loop.addParked(second);

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS * 2);

    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
  });

});

describe('publishing together', () => {
  beforeEach(() => {
    mockTogether.length = 0;
    mockRetries.length = 0;
  });

  it('retries failed publishes on the tick, not on frames', () => {
    loop.addMeasurer(jest.fn());
    loop.addFrameMeasurer(jest.fn());

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    // Six frames, then the tick.
    expect(mockRetries).toEqual([false, false, false, false, false, false, true]);
  });

  it('runs a tick, and a frame, as one publish', () => {
    const seen: string[] = [];
    loop.addMeasurer(() => seen.push(`tick inside ${mockTogether.length % 2 === 1}`));
    loop.addFrameMeasurer(() => seen.push(`frame inside ${mockTogether.length % 2 === 1}`));

    jest.advanceTimersByTime(loop.SECURE_REMEASURE_MS);

    expect(seen).toContain('tick inside true');
    expect(seen).toContain('frame inside true');
    expect(seen.some((entry) => entry.endsWith('false'))).toBe(false);
  });
});
