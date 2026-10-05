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
