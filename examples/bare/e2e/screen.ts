/**
 * What the Phase 6 privacy suites (Task 6.8: blackout.test.ts,
 * secure-component.test.ts, view-tree.test.ts) share on Android: the
 * on-screen ground truth, and the mapping from it onto a bundle's pixels.
 *
 * Ground truth is the accessibility tree (`uiautomator dump`): its bounds are
 * a view's on-screen rectangle in display pixels, computed by the platform
 * with nothing this wrapper does in between (as in B1,
 * secure-rectangles.test.ts). `adb shell wm size` gives the physical display
 * size. A report screenshot is the display scaled down to fit, so a
 * rectangle in display pixels lands on it at `screenshot.width /
 * displayWidth`.
 *
 * The media precondition every privacy report must meet before a pixel of it
 * is trusted -- at least one screenshot that ffprobe can decode, and an h264
 * video -- is `assertMedia`. A report that fails it fails its test.
 */
import type { PulledBundle } from './bundles';
import { imageSize, probeCodec, regionLuma, shadeOf } from './media';
import { adb, type LogLine } from './scenario';

/** Edges, in display pixels. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A crop, in image pixels, as `regionLuma` takes it. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DUMP = '/data/local/tmp/bugsee-e2e-privacy-ui.xml';

/**
 * The UI dump, once, and the device clock when it finished (epoch ms, the
 * clock logcat stamps lines with). `uiautomator dump` waits for the UI to go
 * idle, which the stage's moving square never allows, so the scenarios stop
 * the square for the dump. No retry: a failed attempt takes about 12 s on
 * the WOD_LX1, longer than the scenario holds still, so a second attempt
 * could only read a screen that has moved on.
 */
export async function uiDump(): Promise<{ xml: string; endMs: number }> {
  const out = await adb('shell', 'uiautomator', 'dump', DUMP).catch((error: unknown) => String(error));
  const endMs = await deviceNow();
  if (!/UI hier[a-z]* dumped to/.test(out)) {
    throw new Error(`uiautomator dump failed: ${out.trim()}`);
  }
  const xml = await adb('exec-out', 'cat', DUMP);
  await adb('shell', 'rm', '-f', DUMP);
  return { xml, endMs };
}

/** The device's clock, epoch ms. */
export async function deviceNow(): Promise<number> {
  const out = (await adb('shell', 'date', '+%s%3N')).trim();
  if (!/^\d{13}$/.test(out)) {
    throw new Error(`could not read the device clock: ${JSON.stringify(out)}`);
  }
  return Number(out);
}

/** The bounds of the node whose content-desc is `label`, from a UI dump. */
export function boundsIn(xml: string, label: string): Rect {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map(match => match[0]).filter(node =>
    node.includes(`content-desc="${label}"`),
  );
  if (nodes.length !== 1) {
    throw new Error(`expected one node with content-desc="${label}" in the UI dump, found ${nodes.length}:\n${xml.slice(0, 4000)}`);
  }
  const bounds = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(nodes[0]!);
  if (bounds === null) {
    throw new Error(`no bounds on the node: ${nodes[0]}`);
  }
  const [left, top, right, bottom] = bounds.slice(1, 5).map(Number) as [number, number, number, number];
  return { left, top, right, bottom };
}

/** Whether any node in a UI dump has content-desc `label`. */
export function hasNode(xml: string, label: string): boolean {
  return xml.includes(`content-desc="${label}"`);
}

/** The physical display size (`wm size`), in pixels. */
export async function displaySize(): Promise<{ width: number; height: number }> {
  const out = await adb('shell', 'wm', 'size');
  const physical = /Physical size: (\d+)x(\d+)/.exec(out);
  if (physical === null) {
    throw new Error(`could not read the display size: ${out}`);
  }
  return { width: Number(physical[1]), height: Number(physical[2]) };
}

/**
 * `rect` (display pixels) on an image `imageWidth` wide, shrunk to its
 * centred `fraction` (1 = the whole rectangle), rounded inwards.
 */
export function regionOnImage(rect: Rect, displayWidth: number, imageWidth: number, fraction = 1): Region {
  const scale = imageWidth / displayWidth;
  const w = (rect.right - rect.left) * fraction;
  const h = (rect.bottom - rect.top) * fraction;
  const left = (rect.left + (rect.right - rect.left - w) / 2) * scale;
  const top = (rect.top + (rect.bottom - rect.top - h) / 2) * scale;
  const x = Math.ceil(left);
  const y = Math.ceil(top);
  return { x, y, w: Math.floor(left + w * scale) - x, h: Math.floor(top + h * scale) - y };
}

/** The centred half of an image, in both dimensions (as `frameLumas` crops video). */
export function centreRegion(size: { width: number; height: number }): Region {
  const w = Math.floor(size.width / 2);
  const h = Math.floor(size.height / 2);
  return { x: Math.floor((size.width - w) / 2), y: Math.floor((size.height - h) / 2), w, h };
}

export function moved(rect: Rect, dy: number): Rect {
  return { left: rect.left, top: rect.top + dy, right: rect.right, bottom: rect.bottom + dy };
}

/** The report bundle whose summary is `summary`; exactly one must exist. */
export function bundleBySummary(bundles: readonly PulledBundle[], summary: string): PulledBundle {
  const found = bundles.filter(bundle => bundle.request.summary === summary);
  if (found.length !== 1) {
    throw new Error(
      `expected one bundle with summary ${summary}, found ${found.length} among ${JSON.stringify(
        bundles.map(bundle => bundle.request.summary),
      )}`,
    );
  }
  return found[0]!;
}

export interface Media {
  readonly screenshots: string[];
  readonly video: string;
  readonly videoCodec: string;
  readonly screenshotCodecs: string[];
}

/**
 * The precondition for trusting any pixel of `bundle`: at least one
 * screenshot, each of which ffprobe decodes, and a video that is h264.
 * Throws otherwise -- a report without them fails the test, never skips it.
 */
export async function assertMedia(bundle: PulledBundle): Promise<Media> {
  const screenshots = bundle.binaries.get('screenshot') ?? [];
  if (screenshots.length === 0) {
    throw new Error(`bundle ${bundle.file} (${String(bundle.request.summary)}) has no screenshot: ${JSON.stringify(bundle.manifest.files)}`);
  }
  const screenshotCodecs: string[] = [];
  for (const file of screenshots) {
    const codec = await probeCodec(file);
    if (codec === undefined) {
      throw new Error(`ffprobe finds no image stream in screenshot ${file}`);
    }
    screenshotCodecs.push(codec);
  }
  const videos = bundle.binaries.get('video') ?? [];
  if (videos.length !== 1) {
    throw new Error(`bundle ${bundle.file} (${String(bundle.request.summary)}) has ${videos.length} video file(s): ${JSON.stringify(bundle.manifest.files)}`);
  }
  const videoCodec = await probeCodec(videos[0]!);
  if (videoCodec !== 'h264') {
    throw new Error(`bundle ${bundle.file} video codec is ${String(videoCodec)}, not h264`);
  }
  return { screenshots, video: videos[0]!, videoCodec, screenshotCodecs };
}

/** Mean luma of `rect` (display pixels, shrunk to `fraction`) on each screenshot. */
export async function screenshotLumas(
  screenshots: readonly string[],
  rect: Rect,
  displayWidth: number,
  fraction = 1,
): Promise<number[]> {
  const lumas: number[] = [];
  for (const file of screenshots) {
    const size = await imageSize(file);
    lumas.push(await regionLuma(file, regionOnImage(rect, displayWidth, size.width, fraction)));
  }
  return lumas;
}

/**
 * The rectangles in a logged `served=[version, count, l, t, r, b, ...]`
 * (`BugseeRN secure ... served=`), with the count the store reported.
 */
export function servedOf(line: LogLine): { count: number; rects: Rect[] } {
  const found = /served=\[([^\]]*)\]/.exec(line.text);
  if (found === null) {
    throw new Error(`no served buffer in: ${line.text}`);
  }
  const values = found[1]!.split(',').map(value => Number(value.trim()));
  const count = values[1];
  if (count === undefined || values.length !== 2 + 4 * count) {
    throw new Error(`malformed served buffer: ${found[0]}`);
  }
  const rects: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    const [left, top, right, bottom] = values.slice(2 + 4 * i, 6 + 4 * i) as [number, number, number, number];
    rects.push({ left, top, right, bottom });
  }
  return { count, rects };
}

/**
 * The indices of `frames` (as `frameLumas` returns them, centre quarter)
 * between the SDK's edge frames: every Android bundle video opens with one
 * all-black frame and closes with one or two, blacked out or not. Those are
 * the leading and trailing dark runs; everything between is recording.
 */
export function interiorFrames(frames: ReadonlyArray<{ t: number; luma: number }>): { from: number; to: number } {
  let from = 0;
  while (from < frames.length && shadeOf(frames[from]!.luma) === 'dark') from += 1;
  let to = frames.length;
  while (to > from && shadeOf(frames[to - 1]!.luma) === 'dark') to -= 1;
  if (to <= from) {
    throw new Error('no interior frames: the whole video is dark');
  }
  return { from, to };
}

/** `key=<number>` from a marker line. */
export function numberIn(line: LogLine, key: string): number {
  const found = new RegExp(`\\b${key}=(-?[\\d.]+)`).exec(line.text);
  if (found === null) {
    throw new Error(`no ${key}= in: ${line.text}`);
  }
  return Number(found[1]);
}
