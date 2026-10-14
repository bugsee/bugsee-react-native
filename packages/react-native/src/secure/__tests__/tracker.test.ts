/**
 * One `<BugseeSecure>`'s state machine, driven directly: which loop it is
 * on, when it is measured and what it publishes. Everything it talks to is
 * a recording stand-in, so each transition is checked on its own.
 */
import type { WindowRect } from '../../viewtree/fiber';

interface Loop {
  tick: Array<() => void>;
  frame: Array<() => void>;
  parked: Array<() => void>;
  watched: Array<{ node: unknown; moved: () => void }>;
  removed: string[];
}

const mockLoop: Loop = { tick: [], frame: [], parked: [], watched: [], removed: [] };
const mockState = {
  hidden: false,
  screensHide: true,
  clipTo: null as ((rect: WindowRect) => WindowRect | null) | null,
  nodes: [] as unknown[],
  published: [] as unknown[][],
  cleared: 0,
  ancestry: null as object | null,
};

/** Registers `fn` in `list`, and records its removal under `name`. */
function mockRegister(list: Array<() => void>, name: string, fn: () => void): () => void {
  list.push(fn);
  return () => {
    const index = list.indexOf(fn);
    if (index >= 0) {
      list.splice(index, 1);
    }
    mockLoop.removed.push(name);
  };
}

jest.mock('../measureLoop', () => ({
  addMeasurer: (fn: () => void) => mockRegister(mockLoop.tick, 'tick', fn),
  addFrameMeasurer: (fn: () => void) => mockRegister(mockLoop.frame, 'frame', fn),
  addParked: (fn: () => void) => mockRegister(mockLoop.parked, 'parked', fn),
  watchNode: (node: unknown, moved: () => void) => {
    const entry = { node, moved };
    mockLoop.watched.push(entry);
    return () => {
      mockLoop.watched.splice(mockLoop.watched.indexOf(entry), 1);
      mockLoop.removed.push('watch');
    };
  },
}));
jest.mock('../ancestry', () => ({
  ancestryOfInstance: () =>
    mockState.ancestry ?? { self: null, path: [], hosts: [], screens: [], animated: [], readable: true },
  isHidden: () => mockState.hidden,
  screensHide: () => mockState.screensHide,
  clipToAncestors: (rect: WindowRect) => (mockState.clipTo === null ? rect : mockState.clipTo(rect)),
  clipWatchNodes: () => mockState.nodes,
}));
jest.mock('../surface', () => ({ surfaceOfInstance: () => 0 }));
jest.mock('../registry', () => ({
  setOwnerRectangles: (_owner: unknown, _display: number, rectangles: unknown[]) => {
    if (rectangles.some((rectangle) => !Number.isFinite((rectangle as WindowRect).x))) {
      throw new RangeError('not finite');
    }
    mockState.published.push(rectangles);
  },
  clearOwner: () => {
    mockState.cleared += 1;
  },
}));

import { SECURE_SHRINK_HOLD_MS } from '../hold';
import { SECURE_TRANSITION_HOLD_MS } from '../transition';
import { STEADY_FRAMES, SecureTracker, monotonicNow } from '../tracker';

const rect = (x: number, y: number, width: number, height: number): WindowRect => ({ x, y, width, height });

let self: WindowRect;
let measures: number;
let pending: Array<() => void> | null;
let tracker: SecureTracker;
let warn: jest.SpyInstance;

const view = {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
    measures += 1;
    const answer = () => callback(self.x, self.y, self.width, self.height);
    if (pending === null) {
      answer();
    } else {
      pending.push(answer);
    }
  },
};

beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(mockLoop, { tick: [], frame: [], parked: [], watched: [], removed: [] });
  Object.assign(mockState, {
    hidden: false,
    screensHide: false,
    clipTo: null,
    nodes: [],
    published: [],
    cleared: 0,
    ancestry: null,
  });
  self = rect(0, 100, 100, 50);
  measures = 0;
  pending = null;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  tracker = new SecureTracker(() => view, {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const last = (): unknown[] | undefined => mockState.published[mockState.published.length - 1];
const runFrames = (count = 1): void => {
  for (let index = 0; index < count; index += 1) {
    [...mockLoop.frame].forEach((fn) => fn());
  }
};
const runTick = (): void => [...mockLoop.tick].forEach((fn) => fn());
const runParked = (): void => [...mockLoop.parked].forEach((fn) => fn());

/** Cuts every rectangle to y < 120. */
const cutAt120 = (r: WindowRect): WindowRect | null =>
  r.y >= 120 ? null : { ...r, height: Math.min(r.height, 120 - r.y) };

describe('SecureTracker', () => {
  it('starts on the tick, measured, wholly visible', () => {
    tracker.start();

    expect(mockLoop.tick).toHaveLength(1);
    expect(mockLoop.frame).toHaveLength(0);
    expect(last()).toEqual([self]);
    runTick();
    expect(measures).toBe(2);
  });

  it('stops clean: off every loop, unwatched, cleared, and its old coverage forgotten', () => {
    mockState.clipTo = cutAt120;
    mockState.nodes = ['content'];
    tracker.start();
    self = rect(0, 90, 100, 50);
    runFrames();

    tracker.stop();

    expect([mockLoop.tick, mockLoop.frame, mockLoop.watched]).toEqual([[], [], []]);
    expect(mockState.cleared).toBe(1);

    // Started again, what it covered before is not held.
    mockState.clipTo = null;
    tracker.start();
    expect(last()).toEqual([self]);
  });

  it('stops from parked off the parked turns too', () => {
    mockState.clipTo = cutAt120;
    tracker.start();
    runFrames(STEADY_FRAMES + 1);
    expect(mockLoop.parked).toHaveLength(1);

    tracker.stop();

    expect(mockLoop.parked).toEqual([]);
  });

  it('stops without having started', () => {
    expect(() => tracker.stop()).not.toThrow();
  });

  it('measures nothing once stopped, even an answer already on its way', () => {
    tracker.start();
    pending = [];
    runTick();
    tracker.stop();
    const published = mockState.published.length;

    pending.forEach((answer) => answer());
    tracker.measure();

    expect(mockState.published).toHaveLength(published);
  });

  it('measures nothing without a view', () => {
    const empty = new SecureTracker(() => null, {});
    empty.start();

    expect(measures).toBe(0);
    expect(mockState.published).toEqual([]);
    empty.stop();
  });

  it.each([
    ['x', rect(Number.NaN, 100, 100, 50)],
    ['y', rect(0, Number.NaN, 100, 50)],
    ['width', rect(0, 100, Number.NaN, 50)],
    ['height', rect(0, 100, 100, Number.POSITIVE_INFINITY)],
  ])('keeps the last rectangle, and warns once, on a non-finite %s', (_, bad) => {
    tracker.start();
    self = bad;
    runTick();
    runTick();

    expect(mockState.published).toEqual([[rect(0, 100, 100, 50)]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] BugseeSecure could not measure', 'RangeError');
  });

  describe('clipped', () => {
    beforeEach(() => {
      mockState.clipTo = cutAt120;
      mockState.nodes = ['content'];
    });

    it('goes on the per-frame re-measure and watches its clipping nodes', () => {
      tracker.start();

      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.watched.map((entry) => entry.node)).toEqual(['content']);
      runTick();
      expect(measures).toBe(1);
    });

    it('stays per-frame while it moves, however long', () => {
      tracker.start();
      for (let frame = 0; frame < STEADY_FRAMES * 2; frame += 1) {
        self = rect(0, 100 - frame, 100, 50);
        runFrames();
      }

      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.parked).toHaveLength(0);
    });

    it('parks after STEADY_FRAMES frames still, and measures nothing per frame then', () => {
      tracker.start();
      runFrames(STEADY_FRAMES - 1);
      expect(mockLoop.parked).toHaveLength(0);
      runFrames();

      // Still on frames, for its screens alone.
      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.parked).toHaveLength(1);
      expect(mockLoop.watched).toHaveLength(1);
      const before = measures;
      runFrames(3);
      expect(measures).toBe(before);
    });

    it('a parked turn measures the view alone, and nothing more while it has not moved', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);
      const published = mockState.published.length;
      const before = measures;

      runParked();

      expect(measures - before).toBe(1);
      expect(mockState.published).toHaveLength(published);
      expect(mockLoop.parked).toHaveLength(1);
    });

    it('a parked turn that finds it moved measures it, and puts it back per-frame', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);
      self = rect(0, 90, 100, 50);

      runParked();

      expect(last()![0]).toEqual(rect(0, 90, 100, 30));
      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.parked).toHaveLength(0);
    });

    it('parked, the frame its screens hide it, it is measured and goes hidden', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);
      expect(mockLoop.parked).toHaveLength(1);
      mockState.hidden = true;
      mockState.screensHide = true;

      runFrames();

      expect(mockLoop.parked).toHaveLength(0);
      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.watched).toEqual([]);
      const before = measures;
      runFrames(3);
      expect(measures).toBe(before);
    });

    it('a layout that finds it where it was leaves it parked', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);

      tracker.measure();

      expect(mockLoop.parked).toHaveLength(1);
      const before = measures;
      runFrames(3);
      expect(measures).toBe(before);
    });

    it('a watched node that moves puts it back per-frame, with a fresh count', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);

      mockLoop.watched[0]!.moved();
      expect(mockLoop.frame).toHaveLength(1);
      runFrames(STEADY_FRAMES - 1);

      expect(mockLoop.frame).toHaveLength(1);
    });

    it('a tick publishes nothing for it while per-frame, even with coverage held', () => {
      tracker.start();
      self = rect(0, 90, 100, 50);
      runFrames();
      const published = mockState.published.length;

      runTick();

      expect(mockState.published).toHaveLength(published);
    });

    it('woken after layouts that found it still, it still needs STEADY_FRAMES still frames', () => {
      tracker.start();
      runFrames(STEADY_FRAMES);
      for (let layout = 0; layout < STEADY_FRAMES; layout += 1) {
        tracker.measure();
      }

      mockLoop.watched[0]!.moved();
      runFrames(STEADY_FRAMES - 1);

      expect(mockLoop.frame).toHaveLength(1);
    });

    it('renews its watch when one of two nodes changes', () => {
      mockState.nodes = ['a', 'b'];
      tracker.start();
      mockState.nodes = ['a', 'c'];

      runFrames();

      expect(mockLoop.watched.map((entry) => entry.node)).toEqual(['a', 'c']);
    });

    it('stays registered for frames when it goes from per-frame to hidden', () => {
      tracker.start();
      mockState.hidden = true;

      runFrames();

      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.removed).not.toContain('frame');
    });

    it('a tick does nothing for it while per-frame, or parked with nothing held', () => {
      tracker.start();
      let published = mockState.published.length;
      runTick();
      expect(mockState.published).toHaveLength(published);
      runFrames(STEADY_FRAMES);
      published = mockState.published.length;
      const before = measures;
      runTick();

      expect(measures).toBe(before);
      expect(mockState.published).toHaveLength(published);
    });

    it('a tick drops what a parked view held, once the hold is over', () => {
      tracker.start();
      self = rect(0, 90, 100, 50);
      runFrames(STEADY_FRAMES + 1);
      expect(last()).toHaveLength(2);

      jest.advanceTimersByTime(700);
      runTick();

      expect(last()).toEqual([rect(0, 90, 100, 30)]);
    });

    it('watches only what clips now: unwatched once wholly visible', () => {
      tracker.start();
      mockState.clipTo = null;
      runFrames();

      expect(mockLoop.watched).toEqual([]);
    });

    it('keeps its watch when the nodes are the same, and renews it when they change', () => {
      tracker.start();
      runFrames(2);
      expect(mockLoop.removed.filter((name) => name === 'watch')).toHaveLength(0);

      mockState.nodes = ['other'];
      runFrames();
      expect(mockLoop.watched.map((entry) => entry.node)).toEqual(['other']);

      mockState.nodes = ['other', 'more'];
      runFrames();
      expect(mockLoop.watched.map((entry) => entry.node)).toEqual(['other', 'more']);
    });

    it('a view clipped where it was wholly visible goes per-frame, not parked', () => {
      mockState.clipTo = null;
      tracker.start();
      runTick();
      // It grows, and what is visible of it stays exactly what was.
      self = rect(0, 100, 100, 80);
      mockState.clipTo = (r) => ({ ...r, height: 50 });

      runTick();

      expect(mockLoop.frame).toHaveLength(1);
      expect(mockLoop.parked).toHaveLength(0);
    });
  });

  describe('hidden', () => {
    beforeEach(() => {
      mockState.screensHide = true;
    });

    it('holds what it covered, then withdraws, measuring nothing meanwhile', () => {
      tracker.start();
      mockState.hidden = true;
      runTick();
      expect(last()).toEqual([self]);
      expect(mockLoop.frame).toHaveLength(1);
      const before = measures;

      jest.advanceTimersByTime(700);
      runFrames();

      expect(last()).toEqual([]);
      expect(measures).toBe(before);
    });

    it('publishes nothing per frame once nothing is held', () => {
      tracker.start();
      mockState.hidden = true;
      runTick();
      jest.advanceTimersByTime(700);
      runFrames();
      const published = mockState.published.length;

      runFrames(3);

      expect(mockState.published).toHaveLength(published);
    });

    it('is measured the frame its screens stop hiding it, then stays per-frame until still', () => {
      tracker.start();
      mockState.hidden = true;
      runTick();
      mockState.hidden = false;
      mockState.screensHide = false;
      const before = measures;

      runFrames();

      expect(measures - before).toBe(1);
      expect(mockLoop.frame).toHaveLength(1);
      runFrames(STEADY_FRAMES);
      expect(mockLoop.frame).toHaveLength(0);
    });

    it('drops its watch while hidden', () => {
      mockState.clipTo = cutAt120;
      mockState.nodes = ['content'];
      tracker.start();
      mockState.hidden = true;

      runFrames();

      expect(mockLoop.watched).toEqual([]);
    });
  });

  describe('unmounted', () => {
    const later = (ms: number): void => {
      jest.advanceTimersByTime(ms);
    };

    it('holds what it covered on the tick, then removes it all and leaves the tick', () => {
      tracker.start();
      mockState.published = [];

      tracker.depart();
      expect(last()).toEqual([self]);
      expect(mockLoop.tick).toHaveLength(1);
      expect(mockState.cleared).toBe(0);

      later(SECURE_SHRINK_HOLD_MS - 100);
      runTick();
      expect(last()).toEqual([self]);

      later(300);
      runTick();
      expect(mockState.cleared).toBe(1);
      expect(mockLoop.tick).toHaveLength(0);
    });

    it('with nothing published, removes it at once', () => {
      mockState.clipTo = () => null;
      tracker.start();

      tracker.depart();

      expect(mockState.cleared).toBe(1);
      expect(mockLoop.tick).toHaveLength(0);
    });

    it('not started, does nothing', () => {
      tracker.depart();

      expect(mockState.published).toEqual([]);
      expect(mockState.cleared).toBe(0);
    });

    it('a remount ends what the unmount left, and starts afresh', () => {
      tracker.start();
      tracker.depart();

      tracker.start();

      expect(mockLoop.tick).toHaveLength(1);
      later(SECURE_SHRINK_HOLD_MS + 200);
      runTick();
      expect(last()).toEqual([self]);
      expect(mockState.cleared).toBe(0);
    });

    /** An ancestry whose `path` throws while `throwing()` says so. */
    function tornAncestry(throwing: () => boolean): object {
      const ancestry = { self: null, hosts: [], screens: [], animated: [], readable: true };
      Object.defineProperty(ancestry, 'path', {
        get(): unknown[] {
          if (throwing()) {
            throw new Error('torn');
          }
          return [];
        },
      });
      return ancestry;
    }

    it('a tree that throws as it mounts still publishes the view, and warns once', () => {
      let torn = true;
      mockState.ancestry = tornAncestry(() => torn);
      tracker.start();
      torn = false;

      expect(last()).toEqual([self]);
      expect(warn).toHaveBeenCalledTimes(1);
      tracker.depart();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a tree that throws as it unmounts still holds the view, and warns once', () => {
      let torn = false;
      mockState.ancestry = tornAncestry(() => torn);
      tracker.start();
      torn = true;

      tracker.depart();

      expect(last()).toEqual([self]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('nothing carrying it, or never measured: nothing to warn about', () => {
      tracker.start();
      tracker.depart();
      const unmeasured = new SecureTracker(() => null, {});
      unmeasured.start();
      unmeasured.depart();

      expect(warn).not.toHaveBeenCalled();
    });

    it('a tree that throws while a transition carries it still publishes the view, and warns once', () => {
      let torn = false;
      const stack = { type: 'RNSScreenStack' };
      const path = [{ type: 'RNSScreen', alternate: null }, { ...stack, alternate: stack }];
      const ancestry = { self: null, hosts: [{ index: 0, above: 1, screen: true }], screens: [], animated: [] };
      Object.defineProperty(ancestry, 'path', {
        get(): unknown[] {
          if (torn) {
            throw new Error('torn');
          }
          return path;
        },
      });
      mockState.ancestry = { ...ancestry, readable: true };
      Object.defineProperty(mockState.ancestry, 'path', Object.getOwnPropertyDescriptor(ancestry, 'path')!);
      tracker.start();
      torn = true;
      self = rect(0, 50, 100, 50);

      runFrames();

      expect((last() as WindowRect[]).slice(1, 2)).toEqual([self]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a parked view drops a transition cover on the tick once it runs out', () => {
      const stack = { type: 'RNSScreenStack' };
      // A screen with no alternate: pushed by the commit that mounts the view.
      mockState.ancestry = {
        self: null,
        path: [{ type: 'RNSScreen', alternate: null }, { ...stack, alternate: stack }],
        hosts: [{ index: 0, above: 1, screen: true }],
        screens: [],
        animated: [],
        readable: true,
      };
      mockState.clipTo = cutAt120;
      tracker.start();
      runFrames(STEADY_FRAMES + 2);
      expect(mockLoop.parked).toHaveLength(1);
      expect((last() as WindowRect[]).length).toBe(2);

      later(SECURE_TRANSITION_HOLD_MS + 100);
      runTick();

      expect(last()).toEqual([cutAt120(self)]);
    });
  });

  it('wholly visible and still, a tick measures it; moving, it stays on the tick', () => {
    tracker.start();
    self = rect(0, 50, 100, 50);
    runTick();

    expect(mockLoop.frame).toHaveLength(0);
    expect(measures).toBe(2);
  });
});

describe('monotonicNow', () => {
  const g = globalThis as { performance?: unknown };
  const real = g.performance;

  afterEach(() => {
    g.performance = real;
  });

  it('reads performance.now, not the wall clock', () => {
    g.performance = { now: () => 42 };

    expect(monotonicNow()).toBe(42);
  });

  it.each([
    ['no performance', undefined],
    ['a performance without now', {}],
  ])('falls back to Date.now with %s', (_, performance) => {
    g.performance = performance;

    expect(monotonicNow()).toBe(Date.now());
  });
});
