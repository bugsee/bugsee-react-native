/**
 * What the beta-coverage suites read off a device beyond a report bundle:
 * the screen itself (a capture, its colors and its text), how sharp an
 * image is, and which capture files the SDK keeps on disk.
 *
 * Every spawn passes an argument array, never a shell string, and output
 * this module cannot parse throws rather than passing for an answer (as
 * media.ts does).
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { airplane, newPulledRoot, removePulledBundles } from './bundles';
import { ADB, ANDROID_PACKAGE, ANDROID_SERIAL, IOS_BUNDLE_ID, IOS_SIMULATOR_ID, iosTarget } from './device';
import { ON_IOS, clearBundles, report, startDeviceLog, stopApp, stopDeviceLog } from './harness';
import { imageSize } from './media';
import { type DeviceLog, adbStatus, devicectl, resetScenario } from './scenario';

const execFileAsync = promisify(execFile);

/**
 * A PNG of the device's screen as it is now, in a temp root that
 * `removePulledBundles` deletes. Android: `screencap`; the simulator:
 * `simctl io screenshot`; the iPhone: `devicectl device capture screenshot`
 * (the allowlisted, identity-checked device only).
 */
export async function captureScreen(label: string): Promise<string> {
  const file = join(newPulledRoot(), `${label}.png`);
  if (!ON_IOS) {
    const { stdout } = await execFileAsync(ADB, ['-s', ANDROID_SERIAL, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(file, stdout);
  } else if (iosTarget() === 'simulator') {
    await execFileAsync('xcrun', ['simctl', 'io', IOS_SIMULATOR_ID, 'screenshot', '--type=png', file]);
  } else {
    await devicectl('capture', 'screenshot', '--destination', file);
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new Error(`captureScreen: no screenshot was written to ${file}`);
  }
  return file;
}

/** `file`'s frames (all of a video, the one of a still) as 8-bit gray planes. */
async function grayFrames(file: string): Promise<{ width: number; height: number; frames: Buffer[] }> {
  const { width, height } = await imageSize(file);
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  const size = width * height;
  if (stdout.length === 0 || stdout.length % size !== 0) {
    throw new Error(`grayFrames: ${file}: ${stdout.length} byte(s) is not a whole number of ${width}x${height} frames`);
  }
  const frames: Buffer[] = [];
  for (let at = 0; at < stdout.length; at += size) {
    frames.push(stdout.subarray(at, at + size));
  }
  return { width, height, frames };
}

/**
 * How sharp `file` is: the mean absolute difference between horizontally
 * adjacent pixels (0-255), of its sharpest frame. The SDKs' privacy scale
 * (`capture.screenshot.scale` / `capture.video.scale` below 1) downscales and
 * scales back up, at the same pixel size, so its effect is exactly this
 * number dropping: text and edges smear. The sharpest frame, because a
 * video opens on black frames that have no edges at all.
 */
export async function sharpness(file: string): Promise<number> {
  const { width, height, frames } = await grayFrames(file);
  let best = 0;
  for (const frame of frames) {
    let sum = 0;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width - 1; x += 1) {
        sum += Math.abs(frame[row + x + 1]! - frame[row + x]!);
      }
    }
    best = Math.max(best, sum / (height * (width - 1)));
  }
  return best;
}

/** How many frames a video decodes to. */
export async function frameCount(file: string): Promise<number> {
  return (await grayFrames(file)).frames.length;
}

/**
 * The lines of text macOS's Vision framework reads off `image`
 * (e2e/ocr.swift, run with the system `swift`): the iOS stand-in for
 * uiautomator, which has no counterpart on an iPhone or the simulator.
 */
export async function ocrLines(image: string): Promise<string[]> {
  const { stdout } = await execFileAsync('swift', [join(__dirname, 'ocr.swift'), image], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  return stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
}

/** The activity Android reports as top-resumed (`<package>/<class>`), or undefined. */
export async function androidTopActivity(): Promise<string | undefined> {
  const { output } = await adbStatus('shell', 'dumpsys', 'activity', 'activities');
  const line = /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(output) ?? /mResumedActivity: ActivityRecord\{\S+ \S+ (\S+)/.exec(output);
  return line?.[1];
}

/** The capture parts the SDK keeps between reports, relative to its data root. */
const ANDROID_GENERATIONS = 'files/bugsee_data/capture/generations';
const IOS_GENERATIONS = 'Library/Caches/com.bugsee.data/capture/generations';

/**
 * Every file under the SDK's capture generations directory -- the rolling
 * capture a report is cut from, which `deleteCollectedDataOnDevice` exists
 * to remove -- relative to it. Empty when the directory does not exist.
 */
export async function captureGenerationFiles(): Promise<string[]> {
  if (!ON_IOS) {
    const { output } = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'find', ANDROID_GENERATIONS, '-type', 'f');
    if (/No such file or directory/.test(output)) {
      return [];
    }
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith(ANDROID_GENERATIONS))
      .map(line => line.slice(ANDROID_GENERATIONS.length + 1));
  }
  if (iosTarget() === 'simulator') {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'get_app_container', IOS_SIMULATOR_ID, IOS_BUNDLE_ID, 'data'],
      { encoding: 'utf8' },
    );
    const root = join(stdout.trim(), IOS_GENERATIONS);
    return existsSync(root) ? walk(root, '') : [];
  }
  let result: Record<string, unknown>;
  try {
    result = await devicectl(
      'info',
      'files',
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      IOS_BUNDLE_ID,
      '--subdirectory',
      IOS_GENERATIONS,
    );
  } catch (error) {
    if (/failed to get a list of files/.test(String(error))) {
      return [];
    }
    throw error;
  }
  const files = (result.files ?? []) as Array<{ relativePath?: string; name?: string; isDirectory?: boolean }>;
  return files
    .filter(file => file.isDirectory !== true && !(file.relativePath ?? file.name ?? '').endsWith('/'))
    .map(file => file.relativePath ?? file.name ?? '')
    .filter(path => path !== '');
}

function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walk(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The start every retaining suite here shares: the device log, the
 * network cut (airplane mode on Android; iOS launches against the dead
 * endpoint, harness.ts) and no report left from an earlier run.
 */
export async function beginRetainingSuite(tag: string): Promise<DeviceLog> {
  const log = await startDeviceLog(tag, tag);
  if (!ON_IOS) {
    await airplane(true);
  }
  await clearBundles();
  return log;
}

/**
 * The end every retaining suite shares, each step attempted whatever the
 * one before did: stop the app, drop what it retained, bring the network
 * back (the handset is shared), delete pulled copies, stop the log.
 */
export async function endRetainingSuite(log: DeviceLog | undefined): Promise<void> {
  const steps: Array<() => Promise<unknown> | unknown> = [
    () => stopApp(),
    () => clearBundles(),
    () => (ON_IOS ? undefined : airplane(false)),
    () => report('pulled bundle roots', removePulledBundles()),
    () => stopDeviceLog(log),
    () => resetScenario(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      report('cleanup step failed', String(error));
    }
  }
}
