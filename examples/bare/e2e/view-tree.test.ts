/**
 * Task 6.8: the `vh` data request on an Android handset -- the SDK asks, JS
 * answers inside the budget, and the report carries a managed tree of the
 * documented shape that holds nothing private.
 *
 * Scenario `view-tree` (scenarios/privacy.tsx) mounts
 * `BugseeE2EViewTreeProbe` on the white stage: an open view (`testID
 * vh-open-<n>`, label `vh-open-probe`) holding the text `secret-text-<n>`; a
 * `<BugseeSecure testID="vh-secure-<n>">` around a view with `testID
 * vh-inner-<n>` and `nativeID vh-native-<n>`; and a TextInput holding
 * `typed-<n>`. After 1 s it calls `captureViewHierarchy()`, and 1 s later
 * uploads `vh-<n>`.
 *
 * The bridge's log lines are the plan's Phase 6 table:
 *   data request <id> type=<type> origin=<x>,<y>
 *   data request <id> completed by=<js|deadline|no-js|no-origin|unknown-type|detach|sink-threw|failed> bytes=<n|null> ms=<elapsed>
 *
 * `E2E_EDGE_TO_EDGE=true|false` must name the setting the installed build was
 * made with: `false` also asserts the request carried a non-zero origin, so
 * case 5 exercises the origin conversion (B1).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type PulledBundle, airplane, captureEvents, removePulledBundles } from './bundles';
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, type Run, awaitBundles, clearBundles, must, report, startRun, useLog } from './harness';
import { type LogLine, Logcat, adb, resetScenario } from './scenario';
import { type Rect, assertMedia, boundsIn, bundleBySummary, numberIn, uiDump } from './screen';

const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(5 * 60_000);

const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;

interface Node {
  id: string;
  class_name: string;
  bounds: [number, number, number, number];
  options: { kind: string; secure?: boolean; tag?: string; native_id?: string };
  subitems?: Node[];
  truncated?: boolean;
}

function nodesOf(root: Node): Node[] {
  const all: Node[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    all.push(node);
    stack.push(...(node.subitems ?? []));
  }
  return all;
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describeAndroid('the vh data request on an Android handset', () => {
  let log: Logcat;
  let run: Run;
  let nonce: string;
  let openBounds: Rect;
  let captured: LogLine;
  let capturedT: number;
  let uploadedT: number;
  let vh: PulledBundle;
  let trees: Array<Record<string, unknown>>;
  /** The log up to here: everything the bundle's requests produced. */
  let upTo: number;

  beforeAll(async () => {
    if (EDGE_TO_EDGE !== 'true' && EDGE_TO_EDGE !== 'false') {
      throw new Error(
        `E2E_EDGE_TO_EDGE must state how the installed build was made, "true" or "false"; got ${JSON.stringify(EDGE_TO_EDGE)}`,
      );
    }
    log = await Logcat.start();
    useLog(log, '6.8');
    await airplane(true);

    await clearBundles();
    run = await startRun('view-tree');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    const rect = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E view-tree rect .*nonce=${nonce}`), 20_000, run.launched.index),
      "the view-tree probe's rect marker",
      run.start,
    );
    const uploaded = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E view-tree uploaded .*nonce=${nonce}`), 20_000, rect.index),
      'the vh upload marker',
      run.start,
    );
    // The square stops for the dump: uiautomator needs an idle UI.
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E view-tree still .*nonce=${nonce}`), 20_000, uploaded.index),
      'the stage holding still',
      run.start,
    );
    report('rect marker', rect.text.trim());
    captured = must(
      log.all(new RegExp(`BUGSEE_E2E view-tree captured t=\\d+ nonce=${nonce}`), rect.index)[0],
      'the captureViewHierarchy marker',
      run.start,
    );
    capturedT = numberIn(captured, 't');
    uploadedT = numberIn(uploaded, 't');
    openBounds = boundsIn((await uiDump()).xml, 'vh-open-probe');
    report('vh-open-probe on screen (uiautomator)', openBounds);

    const bundles = await awaitBundles(1);
    vh = bundleBySummary(bundles, `vh-${nonce}`);
    const media = await assertMedia(vh);
    report('media', { screenshots: media.screenshots.length, codecs: media.screenshotCodecs, video: media.videoCodec });
    upTo = log.mark();
    trees = captureEvents(vh, 'viewtree');
    report('viewtree entries', trees.map(t => ({ timestamp: t.timestamp, displayId: t.displayId, native: typeof t.native, managedBytes: typeof t.managed === 'string' ? t.managed.length : t.managed })));
  });

  afterAll(async () => {
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
      } finally {
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        log?.stop();
        resetScenario();
      }
    }
  });

  function managedTrees(): Array<{ raw: string; root: Node }> {
    return trees.map(tree => {
      const raw = tree.managed;
      if (typeof raw !== 'string') {
        throw new Error(`a viewtree entry has no managed string: ${JSON.stringify(tree).slice(0, 300)}`);
      }
      return { raw, root: JSON.parse(raw) as Node };
    });
  }

  it('the SDK asks and JS answers within budget', () => {
    const requests = log.all(/BugseeRN\s*:\s*data request dr-\d+ type=vh /, run.launched.index, upTo);
    const completions = log.all(/BugseeRN\s*:\s*data request dr-\d+ completed /, run.launched.index, upTo);
    report('requests', requests.map(line => line.text.replace(/^.*BugseeRN\s*:\s*/, '')));
    report('completions', completions.map(line => line.text.replace(/^.*BugseeRN\s*:\s*/, '')));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      const id = /data request (dr-\d+) /.exec(request.text)![1]!;
      const done = completions.filter(line => line.text.includes(`data request ${id} completed `));
      expect({ id, count: done.length }).toEqual({ id, count: 1 });
      expect(done[0]!.index).toBeGreaterThan(request.index);
      const outcome = / by=(\S+) bytes=(\S+) ms=(\d+)/.exec(done[0]!.text);
      expect({ id, by: outcome?.[1] }).toEqual({ id, by: 'js' });
      expect(Number(outcome![3])).toBeLessThan(450);
    }
    expect(completions.filter(line => / by=deadline /.test(line.text))).toEqual([]);
    // Every request after Launched was answered by JS: none fell through to
    // no-js, no-origin or any other null.
    expect(completions.filter(line => !/ by=js /.test(line.text)).map(line => line.text)).toEqual([]);

    const origins = requests.map(line => /origin=(-?\d+),(-?\d+)/.exec(line.text)!.slice(1, 3).map(Number));
    report('request origins', { edgeToEdge: EDGE_TO_EDGE, origins });
    for (const [x, y] of origins) {
      if (EDGE_TO_EDGE === 'false') {
        expect(y).toBeGreaterThan(0);
      } else {
        expect([x, y]).toEqual([0, 0]);
      }
    }
  });

  it('the managed tree is in the report it was asked for', () => {
    expect(trees.length).toBeGreaterThanOrEqual(2);
    // Which two: the explicit capture, and the snapshot taken at the upload.
    const stamps = trees.map(tree => tree.timestamp as number);
    report('viewtree timestamps vs markers', { stamps, capturedT, uploadedT });
    expect(stamps.filter(t => Math.abs(t - capturedT) <= 1000)).toHaveLength(1);
    expect(stamps.filter(t => t >= uploadedT).length).toBeGreaterThanOrEqual(1);
    for (const tree of trees) {
      expect(typeof tree.native).toBe('string');
      expect((tree.native as string).length).toBeGreaterThan(0);
      expect(typeof tree.managed).toBe('string');
      expect((tree.managed as string).length).toBeGreaterThan(0);
    }
  });

  it('the managed tree has the documented shape', () => {
    const managed = managedTrees();
    expect(managed.length).toBeGreaterThanOrEqual(2);
    for (const { root } of managed) {
      expect({ id: root.id, class_name: root.class_name, kind: root.options.kind }).toEqual({
        id: '0',
        class_name: 'ReactNative',
        kind: 'root',
      });
      expect((root.subitems ?? []).some(child => child.class_name === 'ReactSurface' && child.options.kind === 'surface')).toBe(true);

      const all = nodesOf(root);
      expect(all.filter(node => node.class_name === 'BugseeE2EViewTreeProbe' && node.options.kind === 'composite')).toHaveLength(1);
      const open = all.filter(node => node.options.kind === 'host' && node.options.tag === `vh-open-${nonce}`);
      expect(open).toHaveLength(1);
      // The positive controls for what the secure subtree must lack: outside
      // it, nativeID does reach the tree...
      expect(open[0]!.options.native_id).toBe(`vh-open-native-${nonce}`);
      // ...and the walk does descend into the text's host, emitting the
      // RCTText view while leaving its raw text out.
      const openHosts = nodesOf(open[0]!).slice(1).filter(node => node.options.kind === 'host');
      report('the vh-open subtree', open[0]);
      expect(openHosts.map(node => node.class_name)).toContain('RCTText');

      const secure = all.filter(node => node.class_name === 'BugseeSecure' && node.options.kind === 'composite');
      // The probe's, and no other on this stage.
      expect(secure).toHaveLength(1);
      const inside = nodesOf(secure[0]!);
      report('the BugseeSecure subtree', secure[0]);
      expect(inside.length).toBeGreaterThanOrEqual(2);
      for (const node of inside) {
        expect({ id: node.id, secure: node.options.secure }).toEqual({ id: node.id, secure: true });
        expect({ id: node.id, tag: node.options.tag, native_id: node.options.native_id }).toEqual({
          id: node.id,
          tag: undefined,
          native_id: undefined,
        });
      }

      const ids = all.map(node => node.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('nothing private is in the payload', () => {
    const forbidden = [
      `secret-text-${nonce}`,
      `typed-${nonce}`,
      `vh-secure-${nonce}`,
      `vh-inner-${nonce}`,
      `vh-native-${nonce}`,
      'vh-open-probe',
    ];
    for (const { raw, root } of managedTrees()) {
      // Scanner self-check: what is allowed through is found.
      expect(raw).toContain(`vh-open-${nonce}`);
      expect(raw).toContain(`vh-open-native-${nonce}`);
      for (const text of forbidden) {
        expect({ text, found: raw.includes(text) }).toEqual({ text, found: false });
      }
      expect(nodesOf(root).filter(node => node.class_name === 'RCTRawText')).toEqual([]);
    }

    // The text itself, anywhere in the report: every file, as UTF-8, UTF-16LE
    // and UTF-16BE (Java's writeChars) bytes.
    const needles = (text: string) => [
      Buffer.from(text, 'utf8'),
      Buffer.from(text, 'utf16le'),
      Buffer.from(text, 'utf16le').swap16(),
    ];
    const files = filesUnder(vh.dir);
    const filesWith = (text: string) =>
      files.filter(file => {
        const bytes = readFileSync(file);
        return needles(text).some(needle => bytes.includes(needle));
      });
    const hits = filesWith(`secret-text-${nonce}`);
    // Scanner self-check: the same scan finds the open view's testID (in the
    // viewtree capture), so an empty result is the scan's answer.
    const control = filesWith(`vh-open-${nonce}`);
    report('files scanned for the secret text', { count: files.length, hits, control });
    expect(files.length).toBeGreaterThan(3);
    expect(control.length).toBeGreaterThanOrEqual(1);
    expect(hits).toEqual([]);
    const typed = files.filter(file => readFileSync(file).includes(Buffer.from(`typed-${nonce}`, 'utf8')));
    report('files carrying the TextInput value (informational)', typed);
  });

  it('bounds are display pixels on screen', () => {
    for (const { root } of managedTrees()) {
      const open = nodesOf(root).filter(node => node.options.tag === `vh-open-${nonce}`);
      expect(open).toHaveLength(1);
      const [x, y, w, h] = open[0]!.bounds;
      const node = { left: x, top: y, right: x + w, bottom: y + h };
      report('vh-open node vs on screen', { edgeToEdge: EDGE_TO_EDGE, node, onScreen: openBounds });
      expect(Math.abs(node.left - openBounds.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.top - openBounds.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.right - openBounds.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.bottom - openBounds.bottom)).toBeLessThanOrEqual(1);
    }
  });
});
