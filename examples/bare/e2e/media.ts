/**
 * Decodes the video and screenshots a pulled report bundle carries, so a
 * device e2e can assert on pixels -- that a blackout region or a secure view
 * really went dark, say -- instead of trusting that the SDK drew one.
 *
 * ffmpeg and ffprobe do the decoding; this file only shells out to them and
 * parses what they print. Every spawn passes an argument array (never a
 * shell string built from a file path), and a non-zero exit or output this
 * module cannot parse throws rather than returning a value that looks like
 * an answer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A frame at or below this mean luma (0-255, `format=gray`) is `dark`. */
export const LUMA_DARK_MAX = 24;
/** A frame at or above this mean luma is `bright`. */
export const LUMA_BRIGHT_MIN = 150;
/** The shortest dark run `blackoutPattern` accepts as a real blackout. */
export const BLACKOUT_MIN_DARK_S = 1.5;

/** Runs `cmd`, decoding stdout/stderr as text; throws with both on a non-zero exit. */
async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${describeSpawnError(error)}`, { cause: error });
  }
}

/** As `run`, but stdout is raw bytes (rawvideo) rather than text. */
async function runBinary(cmd: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    });
    return { stdout: stdout as unknown as Buffer, stderr: (stderr as unknown as Buffer).toString('utf8') };
  } catch (error) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${describeSpawnError(error)}`, { cause: error });
  }
}

function describeSpawnError(error: unknown): string {
  const err = error as { stderr?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : err.stderr;
  return stderr !== undefined && stderr.trim() !== '' ? stderr.trim() : String(err.message ?? error);
}

/**
 * The video codec of `file`'s first video stream (`h264`, `hevc`, ...), or
 * undefined if it has none. A malformed file or missing ffprobe throws; the
 * absence of a video stream in an otherwise-valid file does not.
 */
export async function probeCodec(file: string): Promise<string | undefined> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    file,
  ]);
  const codec = stdout.trim();
  return codec === '' ? undefined : codec;
}

/** One decoded frame's raw byte count: a 32x32 `format=gray` plane. */
const FRAME_LUMA_BYTES = 32 * 32;

/**
 * Every frame of `file`'s centre quarter, downscaled to 32x32 grayscale and
 * decoded to its mean luma (0-255), paired with its presentation timestamp
 * (seconds). ffmpeg prints the frames themselves on stdout and one
 * `showinfo` line per frame -- carrying `pts_time` -- on stderr; the two are
 * zipped in order, and a mismatched count (a partial frame, an unparsable or
 * missing `pts_time`) throws rather than guessing which times go with which
 * frames.
 *
 * `-fps_mode passthrough` is not decoration: without it, muxing to a
 * fixed-rate format like rawvideo makes ffmpeg duplicate and drop frames to
 * conform the output to the input's nominal frame rate (seen by hand against
 * a real bundle video -- 14 raw frames on stdout for the 6 the filter graph
 * and showinfo actually produced, `dup=9 drop=2` in ffmpeg's own summary).
 * That is exactly the mismatch the count check below exists to catch, and
 * without passthrough it would fire on almost every real video; passthrough
 * keeps exactly the frames the filter graph produced, so stdout and the
 * showinfo lines agree in the normal case.
 */
export async function frameLumas(file: string): Promise<Array<{ t: number; luma: number }>> {
  return croppedFrameLumas(file, 'crop=iw/2:ih/2');
}

/**
 * As `frameLumas`, but for `region` (video pixels, e.g. from `videoRegion`)
 * rather than the centre quarter: every frame's mean luma inside it, with
 * its presentation timestamp. Throws if the region does not fit the frame
 * (ffmpeg refuses the crop).
 */
export async function regionFrameLumas(
  file: string,
  region: { x: number; y: number; w: number; h: number },
): Promise<Array<{ t: number; luma: number }>> {
  if (!(region.w > 0 && region.h > 0 && region.x >= 0 && region.y >= 0)) {
    throw new Error(`regionFrameLumas: ${file}: empty or negative region ${JSON.stringify(region)}`);
  }
  return croppedFrameLumas(file, `crop=${region.w}:${region.h}:${region.x}:${region.y}`);
}

async function croppedFrameLumas(file: string, crop: string): Promise<Array<{ t: number; luma: number }>> {
  const { stdout, stderr } = await runBinary('ffmpeg', [
    '-v', 'info',
    '-i', file,
    '-vf', `${crop},scale=32:32,format=gray,showinfo`,
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo',
    '-',
  ]);
  if (stdout.length % FRAME_LUMA_BYTES !== 0) {
    throw new Error(
      `frameLumas: ${file}: ffmpeg wrote ${stdout.length} raw byte(s), not a multiple of the ` +
        `${FRAME_LUMA_BYTES}-byte frame size`,
    );
  }
  const frameCount = stdout.length / FRAME_LUMA_BYTES;
  // Anchored to a `showinfo` line specifically (`[Parsed_showinfo_N @ ...]`),
  // not a bare search for `pts_time:` anywhere in stderr: `-v info` prints
  // other lines too, and a `pts_time` occurrence there that was not really a
  // decoded frame's timestamp must not silently join this pairing.
  const ptsTimes = [...stderr.matchAll(/^\[Parsed_showinfo[^\]]*\][^\n]*\bpts_time:(-?\d+(?:\.\d+)?)/gm)].map(
    match => Number(match[1]),
  );
  if (ptsTimes.length !== frameCount) {
    throw new Error(
      `frameLumas: ${file}: ${frameCount} raw frame(s) on stdout but ${ptsTimes.length} ` +
        `showinfo pts_time line(s) on stderr -- refusing to guess a pairing`,
    );
  }
  const frames: Array<{ t: number; luma: number }> = [];
  for (let i = 0; i < frameCount; i += 1) {
    const frame = stdout.subarray(i * FRAME_LUMA_BYTES, (i + 1) * FRAME_LUMA_BYTES);
    let sum = 0;
    for (const byte of frame) sum += byte;
    const t = ptsTimes[i];
    if (t === undefined) {
      throw new Error(`frameLumas: ${file}: no pts_time parsed for frame ${i}`);
    }
    frames.push({ t, luma: sum / FRAME_LUMA_BYTES });
  }
  return frames;
}

/** Where the display lands inside a letterboxed video frame. */
export interface Letterbox {
  /** Video pixels per display pixel. */
  readonly scale: number;
  /** The bars left and right (each), in video pixels. */
  readonly padH: number;
  /** The bars above and below (each), in video pixels. */
  readonly padV: number;
}

/**
 * How a `screen`-sized display is fitted into a `video`-sized frame: scaled
 * uniformly to fit, and centred, with black bars on the two sides that are
 * left over. Derived from the two sizes rather than assumed: the Android SDK
 * encodes a 720x1612 display into 640x640 frames with 177 px bars left and
 * right, which is this function's answer for those sizes (the bundle's
 * `video.aux` records the same bars, and the device tests cross-check it).
 */
export function letterbox(
  screen: { width: number; height: number },
  video: { width: number; height: number },
): Letterbox {
  if (!(screen.width > 0 && screen.height > 0 && video.width > 0 && video.height > 0)) {
    throw new Error(`letterbox: sizes must be positive, got screen ${JSON.stringify(screen)} video ${JSON.stringify(video)}`);
  }
  const scale = Math.min(video.width / screen.width, video.height / screen.height);
  return {
    scale,
    padH: Math.round((video.width - screen.width * scale) / 2),
    padV: Math.round((video.height - screen.height * scale) / 2),
  };
}

/**
 * A display-pixel rectangle (edges, e.g. uiautomator bounds) as a crop of a
 * letterboxed video frame, shrunk by `inset` video pixels on every edge and
 * rounded inwards, so the crop never reaches past the rectangle. The inset
 * keeps the crop off the rectangle's edge, where h264's block transform and
 * 4:2:0 chroma blend the two sides and the scaling rounds by up to a pixel.
 * Throws when nothing is left after the inset.
 */
export function videoRegion(
  rect: { left: number; top: number; right: number; bottom: number },
  screen: { width: number; height: number },
  video: { width: number; height: number },
  inset: number,
): { x: number; y: number; w: number; h: number } {
  const { scale, padH, padV } = letterbox(screen, video);
  const x = Math.ceil(padH + rect.left * scale + inset);
  const y = Math.ceil(padV + rect.top * scale + inset);
  const right = Math.floor(padH + rect.right * scale - inset);
  const bottom = Math.floor(padV + rect.bottom * scale - inset);
  if (right <= x || bottom <= y) {
    throw new Error(`videoRegion: ${JSON.stringify(rect)} leaves nothing after a ${inset} px inset`);
  }
  return { x, y, w: right - x, h: bottom - y };
}

/** One decoded region sample's raw byte count: a 16x16 `format=gray` plane. */
const REGION_LUMA_BYTES = 16 * 16;

/**
 * The mean luma (0-255) of `file`'s first frame, cropped to `region` (pixels)
 * and downscaled to 16x16 grayscale -- for asserting that a specific area
 * (a secure view's rectangle, say) is dark or bright without decoding the
 * whole frame at full resolution.
 */
export async function regionLuma(
  file: string,
  region: { x: number; y: number; w: number; h: number },
): Promise<number> {
  const { stdout } = await runBinary('ffmpeg', [
    '-v', 'error',
    '-i', file,
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=16:16,format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-',
  ]);
  if (stdout.length !== REGION_LUMA_BYTES) {
    throw new Error(
      `regionLuma: ${file}: expected ${REGION_LUMA_BYTES} raw byte(s) for one frame, got ${stdout.length}`,
    );
  }
  let sum = 0;
  for (const byte of stdout) sum += byte;
  return sum / REGION_LUMA_BYTES;
}

/** The pixel dimensions of `file`'s first video stream (a video or a still image). */
export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    file,
  ]);
  const match = /^(\d+),(\d+)$/.exec(stdout.trim());
  if (match === null) {
    throw new Error(`imageSize: ${file}: could not parse ffprobe's width,height output: ${JSON.stringify(stdout)}`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

export type Shade = 'bright' | 'dark' | 'other';

/** Classifies a mean luma against the dark/bright thresholds above. */
export function shadeOf(luma: number): Shade {
  if (luma <= LUMA_DARK_MAX) return 'dark';
  if (luma >= LUMA_BRIGHT_MIN) return 'bright';
  return 'other';
}

/** A maximal run of consecutive frames sharing one shade. */
interface Run {
  shade: Shade;
  start: number;
  end: number;
}

/** Groups `frames` (assumed ordered by `t`) into maximal same-shade runs. */
function runsOf(frames: Array<{ t: number; luma: number }>): Run[] {
  const runs: Run[] = [];
  for (const frame of frames) {
    const shade = shadeOf(frame.luma);
    const current = runs[runs.length - 1];
    if (current !== undefined && current.shade === shade) {
      current.end = frame.t;
    } else {
      runs.push({ shade, start: frame.t, end: frame.t });
    }
  }
  return runs;
}

/**
 * Recognises a blackout (or a secure region briefly shown, then hidden) in a
 * sequence of decoded frames: a bright frame, immediately followed by an
 * unbroken dark run lasting at least `BLACKOUT_MIN_DARK_S` seconds (by `t`),
 * immediately followed by a bright frame. An `other` frame -- neither dark
 * nor bright -- breaks a dark run into two, so a run only long enough when
 * counted across an `other` frame does not qualify; and a dark run with no
 * bright run before it, or no bright run after it, does not either.
 *
 * `darkSeconds` is the first dark sample's `t` to the last dark sample's
 * `t` -- not the gap between the two bounding bright frames. That makes it a
 * conservative lower bound on how long the screen was actually dark (the
 * true transition happened somewhere between the preceding bright sample and
 * the first dark one, and again between the last dark one and the following
 * bright sample), so it never over-reports and never false-accepts a
 * too-short blackout, but it can under-report the true duration by up to one
 * inter-frame interval on each edge. At a low sampling rate this is not
 * negligible: a nominal 1.6 s blackout sampled at 10 fps can measure exactly
 * `1.5`, right at `BLACKOUT_MIN_DARK_S`'s boundary.
 */
export function blackoutPattern(
  frames: Array<{ t: number; luma: number }>,
): { ok: true; darkSeconds: number } | { ok: false; reason: string } {
  const runs = runsOf(frames);
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined || run.shade !== 'dark') continue;
    const before = runs[i - 1];
    const after = runs[i + 1];
    if (before === undefined || before.shade !== 'bright') continue;
    if (after === undefined || after.shade !== 'bright') continue;
    const darkSeconds = run.end - run.start;
    if (darkSeconds >= BLACKOUT_MIN_DARK_S) {
      return { ok: true, darkSeconds };
    }
  }
  return {
    ok: false,
    reason:
      'no bright frame, followed by an unbroken dark run of at least ' +
      `${BLACKOUT_MIN_DARK_S}s, followed by a bright frame`,
  };
}
