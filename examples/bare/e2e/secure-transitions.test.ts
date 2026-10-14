/**
 * Follow-up to #87: `<BugseeSecure>` stays covered while native still draws
 * it after or beside React.
 *
 * Scenario `secure-transitions` (scenarios/secure-transitions.tsx): a view
 * unmounted in place; a view in a `<Modal animationType="slide">` opening and
 * closing; a view under a native-driven `Animated` translateX. Markers after
 * each change are lined up with native's own log of each publish, `BugseeRN
 * secure published display=0 surface=<surface> raw=[...]`, sent only on a
 * change, so the last one on a surface before a marker is what native held
 * then. Android-only, like secure-visible.test.ts: iOS logs no such line.
 */
import {
  ON_ANDROID,
  type Run,
  TARGET_NAME,
  describeDevice,
  escape,
  must,
  report,
  startDeviceLog,
  startRun,
  stopApp,
  stopDeviceLog,
} from './harness';
import { type DeviceLog, type LogLine, adb, resetScenario } from './scenario';
import { NATIVE_SHIFT } from '../scenarios/secure-transitions';

jest.setTimeout(4 * 60_000);

const describeAndroid = ON_ANDROID ? describeDevice : describe.skip;

const PUBLISHED = /BugseeRN\s*:\s*secure published display=0 surface=(\d+) raw=\[([^\]]*)\]/;

/** The bottom edge of a slide band, as the registry flattens it: past any display. */
const BAND_BOTTOM_POINTS = 100_000;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Marker {
  self: Box | null;
  ratio: number;
  line: LogLine;
}

function rects(flat: string): number[][] {
  const values = flat.trim() === '' ? [] : flat.split(',').map(value => Number(value.trim()));
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += 4) {
    out.push(values.slice(i, i + 4));
  }
  return out;
}

/** As the registry flattens a rectangle: scaled, then rounded outwards. */
function pixels({ x, y, w, h }: Box, ratio: number): number[] {
  return [Math.floor(x * ratio), Math.floor(y * ratio), Math.ceil((x + w) * ratio), Math.ceil((y + h) * ratio)];
}

const near = (a: number[], b: number[]): boolean => a.every((value, i) => Math.abs(value - b[i]!) <= 1);

describeAndroid(`<BugseeSecure> stays covered through native transitions, on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  const markers = new Map<string, Marker>();

  beforeAll(async () => {
    log = await startDeviceLog('#87', 'secure transitions');
    await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
    run = await startRun('secure-transitions');
    const nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    const marker = new RegExp(
      `BUGSEE_E2E secure-transitions phase=(\\S+) self=(\\S+) ratio=(\\S+) nonce=${escape(nonce)}`,
    );
    const finished = new RegExp(`BUGSEE_E2E secure-transitions (done|threw).* nonce=${escape(nonce)}`);
    const end = must(await log.waitFor(finished, 90_000, run.start), 'the scenario finishing', run.start);
    expect(end.text).toContain('secure-transitions done');
    for (const line of log.all(marker, run.start)) {
      const [, name, self, ratio] = marker.exec(line.text)!;
      const [x, y, w, h] = self!.split(',').map(Number) as [number, number, number, number];
      markers.set(name!, { self: self === 'none' ? null : { x, y, w, h }, ratio: Number(ratio), line });
    }
  });

  afterAll(async () => {
    try {
      await stopApp();
    } finally {
      await adb('shell', 'setprop', 'log.tag.BugseeRN', "''").catch(() => {});
      stopDeviceLog(log);
      resetScenario();
    }
  });

  const marker = (name: string): Marker => {
    const found = markers.get(name);
    if (found === undefined) {
      throw new Error(`the scenario logged no phase ${name} (saw ${[...markers.keys()].join(', ')})`);
    }
    return found;
  };

  /** What native held on `surface` (any but the main one when `undefined`) at marker `name`. */
  function heldAt(name: string, surface?: number): number[][] {
    const before = log
      .all(PUBLISHED, run.start, marker(name).line.index)
      .map(line => PUBLISHED.exec(line.text)!)
      .filter(([, on]) => (surface === undefined ? Number(on) !== 0 : Number(on) === surface));
    const last = before[before.length - 1];
    report(`held at ${name}`, last?.[0] ?? 'nothing');
    return last === undefined ? [] : rects(last[2]!);
  }

  it('an unmounted view stays covered while native may still draw it, then is removed', () => {
    const mounted = marker('mounted');
    const box = pixels(mounted.self!, mounted.ratio);

    expect(heldAt('mounted', 0).some(rect => near(rect, box))).toBe(true);
    expect(heldAt('held', 0).some(rect => near(rect, box))).toBe(true);
    expect(heldAt('gone', 0).some(rect => near(rect, box))).toBe(false);
  });

  it('a Modal sliding in and out covers the band the view slides along, then only the view, then nothing', () => {
    const settled = marker('modal-settled');
    const box = pixels(settled.self!, settled.ratio);
    const isBand = (rect: number[]): boolean =>
      rect[0]! <= box[0]! + 1 && rect[2]! >= box[2]! - 1 && rect[3]! >= BAND_BOTTOM_POINTS * settled.ratio - 1;

    expect(heldAt('modal-opened').some(isBand)).toBe(true);
    const atRest = heldAt('modal-settled');
    expect(atRest.some(isBand)).toBe(false);
    expect(atRest.some(rect => near(rect, box))).toBe(true);
    expect(heldAt('modal-closed').some(isBand)).toBe(true);
    expect(heldAt('modal-gone')).toEqual([]);
  });

  it('a view a native-driven animation moved is covered where it is drawn, not where it was measured', () => {
    const moved = marker('native-moved');
    // React Native still measures it where it rendered it.
    expect(moved.self!.x).toBeCloseTo(marker('native-rest').self!.x, 0);
    const drawn = pixels({ ...moved.self!, x: moved.self!.x + NATIVE_SHIFT }, moved.ratio);

    expect(heldAt('native-moved', 0).some(rect => near(rect, drawn))).toBe(true);
  });
});
