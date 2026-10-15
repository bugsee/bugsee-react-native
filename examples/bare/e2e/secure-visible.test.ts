/**
 * bugsee/bugsee-react-native#86: `<BugseeSecure>` publishes only the part of
 * itself that is on screen, and nothing while an ancestor hides it.
 *
 * Scenario `secure-visible` (scenarios/secure-visible.tsx): one
 * `<BugseeSecure>` in a ScrollView, scrolled fully in, partly out (the top
 * cut off by the viewport), fully out and back; then two sibling "tabs" with a
 * `<BugseeSecure>` each, the inactive one styled `display: 'none'`. After each
 * change it holds still and logs the window rectangles, in points, of the
 * viewport and of a transparent twin of each secure view on screen.
 *
 * The ground truth for what was published is native's own log of each
 * publish, `BugseeRN secure published display=0 surface=0 raw=[...]`, which
 * React Native's side sends only on a change (the registry skips an unchanged
 * union). The last one before a phase's marker is therefore what native held
 * during the hold. It is logged only while `log.tag.BugseeRN` is DEBUG, which
 * this test sets and then clears, so it is Android-only; iOS logs no such
 * line.
 *
 * Expected rectangles are computed here from the scenario's measurements: the
 * twin intersected with the viewport, in pixels at the logged ratio, rounded
 * outwards as the registry rounds. A one-pixel tolerance absorbs float noise.
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

jest.setTimeout(4 * 60_000);

const describeAndroid = ON_ANDROID ? describeDevice : describe.skip;

const PUBLISHED = /BugseeRN\s*:\s*secure published display=0 surface=0 raw=\[([^\]]*)\]/;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Phase {
  viewport: Box;
  self: Box;
  tab: { name: string; rect: Box };
  ratio: number;
  /** The rectangles native held, as [left, top, right, bottom] pixels. */
  published: number[][];
  line: LogLine;
}

function box(text: string): Box {
  const [x, y, w, h] = text.split(',').map(Number) as [number, number, number, number];
  return { x, y, w, h };
}

/** `a` cut to `b`, or `null` when nothing of it is left. */
function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

/** As the registry flattens a rectangle: scaled, then rounded outwards. */
function pixels({ x, y, w, h }: Box, ratio: number): number[] {
  return [Math.floor(x * ratio), Math.floor(y * ratio), Math.ceil((x + w) * ratio), Math.ceil((y + h) * ratio)];
}

function rects(flat: string): number[][] {
  const values = flat.trim() === '' ? [] : flat.split(',').map(value => Number(value.trim()));
  if (values.length % 4 !== 0) {
    throw new Error(`malformed raw buffer: [${flat}]`);
  }
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += 4) {
    out.push(values.slice(i, i + 4));
  }
  return out;
}

/** Every expected rectangle matched by one published within a pixel, and nothing else published. */
function expectPublished(phase: string, published: number[][], expected: number[][]): void {
  const left = [...published];
  const unmatched: number[][] = [];
  for (const want of expected) {
    const index = left.findIndex(got => got.every((value, i) => Math.abs(value - want[i]!) <= 1));
    if (index < 0) {
      unmatched.push(want);
    } else {
      left.splice(index, 1);
    }
  }
  expect({ phase, unmatched, unexpected: left }).toEqual({ phase, unmatched: [], unexpected: [] });
}

describeAndroid(`<BugseeSecure> publishes only what is on screen, on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  const phases = new Map<string, Phase>();

  beforeAll(async () => {
    log = await startDeviceLog('#86', '#86');
    await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
    run = await startRun('secure-visible');
    const nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    const marker = new RegExp(
      'BUGSEE_E2E secure-visible phase=(\\S+) viewport=(\\S+) self=(\\S+) tab=(A|B):(\\S+) ratio=(\\S+) ' +
        `nonce=${escape(nonce)}`,
    );
    const finished = new RegExp(`BUGSEE_E2E secure-visible (done|threw).* nonce=${escape(nonce)}`);
    must(
      await log.waitFor(finished, 60_000, run.start),
      'the secure-visible scenario finishing',
      run.start,
    );
    for (const line of log.all(marker, run.start)) {
      const [, name, viewport, self, tab, tabRect, ratio] = marker.exec(line.text)!;
      const publishes = log.all(PUBLISHED, run.start, line.index);
      const last = must(publishes.pop(), `a publish before phase ${name}`, run.start);
      phases.set(name!, {
        viewport: box(viewport!),
        self: box(self!),
        tab: { name: tab!, rect: box(tabRect!) },
        ratio: Number(ratio),
        published: rects(PUBLISHED.exec(last.text)![1]!),
        line,
      });
      report(`phase ${name}`, { marker: line.text.trim(), published: last.text.trim() });
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

  const phase = (name: string): Phase => {
    const found = phases.get(name);
    if (found === undefined) {
      throw new Error(`the scenario logged no phase ${name} (saw ${[...phases.keys()].join(', ')})`);
    }
    return found;
  };

  /** What should be published in `name`: the scrolled view cut to its viewport, and the active tab's view. */
  function expected(name: string): number[][] {
    const p = phase(name);
    const visible = intersect(p.self, p.viewport);
    return [...(visible === null ? [] : [pixels(visible, p.ratio)]), pixels(p.tab.rect, p.ratio)];
  }

  it('publishes the whole view while it is fully inside the viewport', () => {
    const p = phase('visible');
    expect(intersect(p.self, p.viewport)).toEqual(p.self);
    expectPublished('visible', p.published, expected('visible'));
  });

  it('publishes only the visible part while partly scrolled out', () => {
    const p = phase('partial');
    // Precondition: the viewport really cuts the view.
    const visible = intersect(p.self, p.viewport);
    expect(visible).not.toBeNull();
    expect(visible!.h).toBeLessThan(p.self.h);
    expectPublished('partial', p.published, expected('partial'));
  });

  it('publishes nothing for it while fully scrolled out', () => {
    const p = phase('out');
    expect(intersect(p.self, p.viewport)).toBeNull();
    expect(p.published).toHaveLength(1);
    expectPublished('out', p.published, expected('out'));
  });

  it('publishes it again once scrolled back', () => {
    expectPublished('back', phase('back').published, expected('back'));
  });

  it("withdraws the hidden tab's view and publishes the shown one's", () => {
    expect(phase('tab-b').tab.name).toBe('B');
    expectPublished('tab-b', phase('tab-b').published, expected('tab-b'));
    // The view on tab A, still mounted under display: 'none', is not there.
    const tabA = phase('tab-a').tab.rect;
    const ratio = phase('tab-b').ratio;
    expect(phase('tab-b').published).not.toContainEqual(pixels(tabA, ratio));
  });

  it('brings the tab back when it is shown again', () => {
    expect(phase('tab-a').tab.name).toBe('A');
    expectPublished('tab-a', phase('tab-a').published, expected('tab-a'));
  });
});
