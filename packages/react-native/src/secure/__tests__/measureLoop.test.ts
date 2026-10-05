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

