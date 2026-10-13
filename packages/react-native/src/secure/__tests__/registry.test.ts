/**
 * The shared secure-rectangle registry: `Bugsee.setSecureRectangles` and every
 * `<BugseeSecure>` publish through it, so one owner can never clear another's
 * regions. A dropped region is recorded in the clear, so every test here is
 * about a region that must still be published after something else changed.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type * as RegistryModule from '../registry';
import type { native as nativeInstance } from '../../__mocks__/native';

type Registry = typeof RegistryModule;
type Native = typeof nativeInstance;

let registry: Registry;
let native: Native;

// The registry is module state by design (one per JS runtime). Each test gets
// a fresh copy, so "the first publish always crosses" is really the first.
beforeEach(() => {
  jest.resetModules();
  native = require('../../__mocks__/native').native;
  native.reset();
  registry = require('../registry');
});

const A = { x: 10, y: 20, width: 30, height: 40 };
const A_FLAT = [10, 20, 40, 60];
const B = { x: 100, y: 200, width: 10, height: 10 };
const B_FLAT = [100, 200, 110, 210];

describe('the secure-rectangle registry', () => {
  it('a manual set and a component region coexist on display 0', () => {
    const component = {};

    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles(component, 0, [B]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [...A_FLAT, ...B_FLAT]);

    // Replacing the manual set keeps the component's region, and the union
    // stays in owner-insertion order.
    registry.setOwnerRectangles('manual:0', 0, [B, A]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(
      0, [...B_FLAT, ...A_FLAT, ...B_FLAT],
    );
  });

  it('keeps two component instances apart', () => {
    const first = {};
    const second = {};

    registry.setOwnerRectangles(first, 0, [A]);
    registry.setOwnerRectangles(second, 0, [B]);
    registry.clearOwner(first);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, B_FLAT);
  });

  it('clearing an owner republishes the rest', () => {
    const component = {};
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles(component, 0, [B]);

    registry.clearOwner(component);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, A_FLAT);

    registry.clearOwner('manual:0');
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, []);
    expect(native.setSecureRectangles).toHaveBeenCalledTimes(4);
  });

  it('clearing an owner it never saw publishes nothing', () => {
    registry.clearOwner({});
    registry.clearOwner('manual:0');

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  it('clearing an owner twice publishes once', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A]);

    registry.clearOwner(component);
    registry.clearOwner(component);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);
  });

  it('an unchanged union does not cross the bridge again', () => {
    const component = {};
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles('manual:0', 0, [{ ...A }]);

    // A component re-measuring the same place, and an owner whose region is
    // empty, leave the union as it was.
    registry.setOwnerRectangles(component, 0, []);
    registry.setOwnerRectangles(component, 0, [{ x: 0, y: 0, width: 0, height: 0 }]);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(1);
    expect(native.setSecureRectangles).toHaveBeenCalledWith(0, A_FLAT);
  });

  it('a union of the same length but different coordinates crosses', () => {
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles('manual:0', 0, [{ ...A, height: 41 }]);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [10, 20, 40, 61]);
  });

  it('the first publish always crosses, even when empty', () => {
    registry.setOwnerRectangles('manual:0', 0, []);
    registry.setOwnerRectangles({}, 3, []);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);
    expect(native.setSecureRectangles).toHaveBeenNthCalledWith(1, 0, []);
    expect(native.setSecureRectangles).toHaveBeenNthCalledWith(2, 3, []);
  });

  it('a manual set on display 2 leaves display 0 alone', () => {
    registry.setOwnerRectangles({}, 0, [B]);
    native.setSecureRectangles.mockClear();

    registry.setOwnerRectangles('manual:2', 2, [A]);
    registry.clearOwner('manual:2');

    expect(native.setSecureRectangles.mock.calls).toEqual([[2, A_FLAT], [2, []]]);
  });

  it('an owner that moves display leaves the old one', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A]);
    registry.setOwnerRectangles(component, 1, [A]);

    // The new display is covered before the old one is uncovered.
    expect(native.setSecureRectangles.mock.calls).toEqual([[0, A_FLAT], [1, A_FLAT], [0, []]]);
  });

  it('an invalid rectangle changes nothing and publishes nothing', () => {
    registry.setOwnerRectangles('manual:0', 0, [A]);
    native.setSecureRectangles.mockClear();

    expect(() => registry.setOwnerRectangles('manual:0', 0, [
      B,
      { x: 0, y: 0, width: -1, height: 10 },
    ])).toThrow(/negative/i);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();

    // The manual set is still A, not B and not empty.
    registry.setOwnerRectangles({}, 0, [B]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [...A_FLAT, ...B_FLAT]);
  });

  it('an invalid rectangle from a new owner does not register it', () => {
    const component = {};
    expect(() => registry.setOwnerRectangles(component, 0, [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
    ])).toThrow(/non-finite/i);

    registry.clearOwner(component);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  // The caller keeps its array. A later edit through it must not change what
  // the registry republishes when some other owner moves.
  it('holds its own copy of the rectangles it was given', () => {
    const rectangle = { ...A };
    const list = [rectangle];
    registry.setOwnerRectangles('manual:0', 0, list);

    rectangle.x = 500;
    list.push(B);
    registry.setOwnerRectangles({}, 0, []);
    registry.setOwnerRectangles({}, 0, [B]);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [...A_FLAT, ...B_FLAT]);
  });

  // Only a publish that reached the bridge counts as published. Otherwise
  // the same list, retried, would be skipped as "unchanged" and never land.
  it('retries a publish the bridge threw on', () => {
    native.setSecureRectangles.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    expect(() => registry.setOwnerRectangles('manual:0', 0, [A])).toThrow('bridge down');

    registry.setOwnerRectangles('manual:0', 0, [A]);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, A_FLAT);
  });

  // The union is re-flattened on every publish, so a pixel ratio change is
  // picked up the next time any owner on the display moves.
  it('flattens in the platform unit at publish time', () => {
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' }, PixelRatio: { get: () => 2 } }));
    native = require('../../__mocks__/native').native;
    native.reset();
    registry = require('../registry');

    registry.setOwnerRectangles('manual:0', 0, [A]);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 40, 80, 120]);
  });
});

// Fabric measureInWindow is relative to the measured node's own React root,
// and a <Modal> is its own root (an Android Dialog). Each surface's union is
// published on its own, so native can translate it by that surface's origin.
describe('the secure-rectangle registry, per surface', () => {
  const MODAL = 42;

  // The Android `doMock` above outlives its own test; these are in points.
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    native = require('../../__mocks__/native').native;
    native.reset();
    registry = require('../registry');
  });

  /** Every publish on display 0, in order, across both bridge methods. */
  function publishes(): unknown[][] {
    const calls: { order: number; call: unknown[] }[] = [];
    native.setSecureRectangles.mock.calls.forEach((call, i) => {
      calls.push({ order: native.setSecureRectangles.mock.invocationCallOrder[i] as number, call: ['main', ...call] });
    });
    native.setSecureRectanglesOnSurface.mock.calls.forEach((call, i) => {
      calls.push({
        order: native.setSecureRectanglesOnSurface.mock.invocationCallOrder[i] as number,
        call: ['surface', ...call],
      });
    });
    return calls.sort((a, b) => a.order - b.order).map(({ call }) => call);
  }

  it('names the main surface 0, as native does', () => {
    expect(registry.MAIN_SURFACE).toBe(0);
  });

  it('publishes another surface through setSecureRectanglesOnSurface, apart from the main one', () => {
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles({}, 0, [B], MODAL);

    expect(publishes()).toEqual([
      ['main', 0, A_FLAT],
      ['surface', 0, MODAL, B_FLAT],
    ]);
  });

  it('an explicit main surface is the same lane as the default', () => {
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles({}, 0, [B], registry.MAIN_SURFACE);

    expect(publishes()).toEqual([
      ['main', 0, A_FLAT],
      ['main', 0, [...A_FLAT, ...B_FLAT]],
    ]);
  });

  it('keeps each surface its own union', () => {
    const first = {};
    const second = {};
    registry.setOwnerRectangles(first, 0, [A], MODAL);
    registry.setOwnerRectangles(second, 0, [B], MODAL);
    registry.setOwnerRectangles({}, 0, [A], 7);

    expect(publishes()).toEqual([
      ['surface', 0, MODAL, A_FLAT],
      ['surface', 0, MODAL, [...A_FLAT, ...B_FLAT]],
      ['surface', 0, 7, A_FLAT],
    ]);
  });

  it('an unchanged surface union does not cross the bridge again', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A], MODAL);
    registry.setOwnerRectangles(component, 0, [{ ...A }], MODAL);

    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(1);
  });

  it('the first publish on a surface always crosses, even when empty', () => {
    registry.setOwnerRectangles('manual:0', 0, []);
    registry.setOwnerRectangles({}, 0, [], MODAL);

    expect(publishes()).toEqual([
      ['main', 0, []],
      ['surface', 0, MODAL, []],
    ]);
  });

  it('an owner that moves surface covers the new one before it uncovers the old', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A]);
    registry.setOwnerRectangles(component, 0, [A], MODAL);

    expect(publishes()).toEqual([
      ['main', 0, A_FLAT],
      ['surface', 0, MODAL, A_FLAT],
      ['main', 0, []],
    ]);
  });

  it('an owner that moves display and surface leaves the old display\'s surface', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A], MODAL);
    registry.setOwnerRectangles(component, 1, [A]);

    expect(publishes()).toEqual([
      ['surface', 0, MODAL, A_FLAT],
      ['main', 1, A_FLAT],
      // Display 1 never had this surface: its first publish crosses, empty.
      ['surface', 1, MODAL, []],
      ['surface', 0, MODAL, []],
    ]);
  });

  it('clearing an owner republishes only its own surface', () => {
    const component = {};
    registry.setOwnerRectangles('manual:0', 0, [A]);
    registry.setOwnerRectangles(component, 0, [B], MODAL);

    registry.clearOwner(component);

    expect(publishes()).toEqual([
      ['main', 0, A_FLAT],
      ['surface', 0, MODAL, B_FLAT],
      ['surface', 0, MODAL, []],
    ]);
  });

  it('retries a surface publish the bridge threw on', () => {
    native.setSecureRectanglesOnSurface.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    const component = {};
    expect(() => registry.setOwnerRectangles(component, 0, [A], MODAL)).toThrow('bridge down');

    registry.setOwnerRectangles(component, 0, [A], MODAL);

    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(2);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, MODAL, A_FLAT);
  });
});

// Every mounted <BugseeSecure> republishes what it holds on every re-measure
// it has not moved. That must cost a comparison, not a re-flatten of the
// whole union, yet never skip a publish native still needs.
describe('the secure-rectangle registry, an owner that has not moved', () => {
  let ratio: number;
  let flatten: jest.SpyInstance;

  beforeEach(() => {
    ratio = 2;
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' }, PixelRatio: { get: () => ratio } }));
    native = require('../../__mocks__/native').native;
    native.reset();
    registry = require('../registry');
    const rectangles = require('../rectangles') as { flattenSecureRectangles: () => number[] };
    flatten = jest.spyOn(rectangles, 'flattenSecureRectangles');
  });

  // Back to the file's own mock, for whatever runs next.
  afterEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
  });

  it('costs no flattening and no publish', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A, B]);
    flatten.mockClear();
    native.setSecureRectangles.mockClear();

    registry.setOwnerRectangles(component, 0, [{ ...A }, { ...B }]);

    expect(flatten).not.toHaveBeenCalled();
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  it.each([
    ['x', { ...B, x: 101 }],
    ['y', { ...B, y: 201 }],
    ['width', { ...B, width: 11 }],
    ['height', { ...B, height: 11 }],
  ])('publishes a change of %s', (_, moved) => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A, B]);

    registry.setOwnerRectangles(component, 0, [A, moved]);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [
      20, 40, 80, 120,
      2 * moved.x, 2 * moved.y, 2 * (moved.x + moved.width), 2 * (moved.y + moved.height),
    ]);
  });

  it('publishes one rectangle more or fewer', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A]);

    registry.setOwnerRectangles(component, 0, [A, B]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 40, 80, 120, 200, 400, 220, 420]);

    registry.setOwnerRectangles(component, 0, [A]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 40, 80, 120]);
  });

  // The lanes it moves to are settled already, by other owners.
  it('moves with an unchanged rectangle to another display or surface', () => {
    const component = {};
    registry.setOwnerRectangles('manual:2', 2, []);
    registry.setOwnerRectangles({}, 2, [], 42);
    registry.setOwnerRectangles(component, 0, [A]);

    registry.setOwnerRectangles(component, 2, [A]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, []);
    expect(native.setSecureRectangles).toHaveBeenCalledWith(2, [20, 40, 80, 120]);

    registry.setOwnerRectangles(component, 2, [A], 42);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(2, 42, [20, 40, 80, 120]);
  });

  it('republishes at a new pixel ratio', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A]);

    ratio = 3;
    registry.setOwnerRectangles(component, 0, [A]);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [30, 60, 120, 180]);
  });

  it('skips again once the lane is flattened at the new ratio, even when nothing crossed', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, []);
    ratio = 3;
    registry.setOwnerRectangles(component, 0, []);
    flatten.mockClear();

    registry.setOwnerRectangles(component, 0, []);

    expect(flatten).not.toHaveBeenCalled();
  });

  // Another owner's failed publish left native without its region. An
  // owner that has not moved must not skip the retry, nor the other owner
  // its own.
  it('does not skip on a lane whose last publish failed', () => {
    const first = {};
    const second = {};
    registry.setOwnerRectangles(first, 0, [A]);
    native.setSecureRectangles.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    expect(() => registry.setOwnerRectangles(second, 0, [B])).toThrow('bridge down');

    registry.setOwnerRectangles(second, 0, [B]);

    // The failed call, then the retry: not skipped.
    expect(native.setSecureRectangles).toHaveBeenCalledTimes(3);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 40, 80, 120, 200, 400, 220, 420]);
  });

  it('skips nothing on another lane because one lane is settled', () => {
    const component = {};
    registry.setOwnerRectangles(component, 0, [A], 42);
    registry.setOwnerRectangles('manual:0', 0, [B]);
    native.setSecureRectanglesOnSurface.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    expect(() => registry.setOwnerRectangles(component, 0, [B], 42)).toThrow('bridge down');

    registry.setOwnerRectangles(component, 0, [B], 42);

    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(3);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, 42, [200, 400, 220, 420]);
  });
});

// Every instance re-measured in one tick or frame changes its lane: they are
// published together at the end, once per lane, not once per change.
describe('the secure-rectangle registry, publishing together', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    native = require('../../__mocks__/native').native;
    native.reset();
    registry = require('../registry');
  });

  it('publishes each changed lane once, at the end', () => {
    const [first, second] = [{}, {}];
    registry.publishTogether(() => {
      registry.setOwnerRectangles(first, 0, [A]);
      registry.setOwnerRectangles(second, 0, [B]);
      registry.setOwnerRectangles('manual:2', 2, [A]);
      registry.setOwnerRectangles({}, 0, [B], 42);
      expect(native.setSecureRectangles).not.toHaveBeenCalled();
    });

    expect(native.setSecureRectangles.mock.calls).toEqual([
      [0, [...A_FLAT, ...B_FLAT]],
      [2, A_FLAT],
    ]);
    expect(native.setSecureRectanglesOnSurface.mock.calls).toEqual([[0, 42, B_FLAT]]);
  });

  it('publishes the lane an owner left as well as the one it moved to', () => {
    const owner = {};
    registry.setOwnerRectangles(owner, 0, [A]);

    registry.publishTogether(() => registry.setOwnerRectangles(owner, 2, [A]));

    expect(native.setSecureRectangles.mock.calls.slice(1)).toEqual([
      [2, A_FLAT],
      [0, []],
    ]);
  });

  it('inside another, simply runs the changes', () => {
    registry.publishTogether(() => {
      registry.publishTogether(() => registry.setOwnerRectangles({}, 0, [A]));
      expect(native.setSecureRectangles).not.toHaveBeenCalled();
    });

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(1);
  });

  it('publishes even when the changes throw, and publishes at once after', () => {
    expect(() =>
      registry.publishTogether(() => {
        registry.setOwnerRectangles({}, 0, [A]);
        throw new Error('measurer broke');
      }),
    ).toThrow('measurer broke');
    expect(native.setSecureRectangles).toHaveBeenCalledWith(0, A_FLAT);

    registry.setOwnerRectangles({}, 0, [B]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [...A_FLAT, ...B_FLAT]);
  });

  it('logs a lane whose publish threw, publishes the rest, and retries it on its next change', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectangles.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    const owner = {};
    registry.publishTogether(() => {
      registry.setOwnerRectangles(owner, 0, [A]);
      registry.setOwnerRectangles({}, 2, [B]);
    });

    expect(warn).toHaveBeenCalledWith('[Bugsee] could not publish secure rectangles', 'Error');
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(2, B_FLAT);

    // Unchanged, but its lane never reached the bridge: not skipped.
    registry.setOwnerRectangles(owner, 0, [A]);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, A_FLAT);
    warn.mockRestore();
  });

  it('publishes a lane that failed again on the next call that retries, though nothing on it changed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectanglesOnSurface.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    registry.publishTogether(() => registry.setOwnerRectangles({}, 0, [A], 42));
    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(1);

    // A frame does not retry it; a tick does.
    registry.publishTogether(() => undefined);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(1);
    registry.publishTogether(() => undefined, true);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(2);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, 42, A_FLAT);

    // Once it went through, it is not published again.
    registry.publishTogether(() => undefined, true);
    expect(native.setSecureRectanglesOnSurface).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keeps a lane that keeps failing for each retry, and warns once until it publishes', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectangles.mockImplementation(() => {
      throw new Error('bridge down');
    });
    registry.publishTogether(() => registry.setOwnerRectangles({}, 0, [A]));
    registry.publishTogether(() => undefined, true);
    registry.publishTogether(() => undefined, true);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);

    // It goes through, then fails again: a new outage, a new warning.
    native.setSecureRectangles.mockImplementation(() => undefined);
    registry.publishTogether(() => undefined, true);
    native.setSecureRectangles.mockImplementation(() => {
      throw new Error('bridge down');
    });
    registry.publishTogether(() => registry.setOwnerRectangles({}, 0, [B]));

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('warns about a lane newly failing even while another is still failing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectangles.mockImplementation(() => {
      throw new Error('bridge down');
    });
    registry.publishTogether(() => registry.setOwnerRectangles({}, 0, [A]));
    registry.publishTogether(() => registry.setOwnerRectangles({}, 2, [A]));

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('warns about a surface newly failing on a display with one already failing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectangles.mockImplementation(() => {
      throw new Error('bridge down');
    });
    const owner = {};
    registry.publishTogether(() => registry.setOwnerRectangles(owner, 0, [A]));
    expect(warn).toHaveBeenCalledTimes(1);

    // It moves to a Modal's surface: that lane fails too, with the main one.
    native.setSecureRectanglesOnSurface.mockImplementation(() => {
      throw new Error('bridge down');
    });
    registry.publishTogether(() => registry.setOwnerRectangles(owner, 0, [A], 42));

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a lane that failed and was published by a later change is not published again by a retry', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.setSecureRectangles.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    const owner = {};
    registry.publishTogether(() => registry.setOwnerRectangles(owner, 0, [A]));
    registry.publishTogether(() => registry.setOwnerRectangles(owner, 0, [B]));
    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);

    registry.publishTogether(() => undefined, true);

    expect(native.setSecureRectangles).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
