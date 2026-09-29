/**
 * `bugsee-e2e-native`: test helpers the device tests need and JS alone cannot
 * provide -- a real native crash (Task 7.6b) and files on disk to attach
 * (Phase 8). Example-only (planner ruling R12); never a dependency of
 * @bugsee/react-native.
 *
 * Every argument is checked here, before it crosses, and a bad one throws a
 * TypeError that names the rule, never the value.
 */
import NativeBugseeE2E from './NativeBugseeE2E';

export type NativeCrashKind = 'segv' | 'abort';

const CRASH_KINDS: readonly string[] = ['segv', 'abort'];

/** A plain file name: no separator, so it cannot leave the cache directory. */
const FILE_NAME = /^[\w.-]{1,64}$/;

/**
 * Crashes the process natively: SIGSEGV (`'segv'`) or SIGABRT (`'abort'`),
 * from JNI code on Android. On iOS the native side only logs that it is
 * Android-only. Any other kind throws a TypeError here and never reaches
 * native code.
 */
export function crashNative(kind: NativeCrashKind): void {
  if (typeof kind !== 'string' || !CRASH_KINDS.includes(kind)) {
    throw new TypeError("crashNative: kind must be 'segv' or 'abort'");
  }
  NativeBugseeE2E.crashNative(kind);
}

/**
 * Writes `contents` (UTF-8) to `name` in the app's cache directory and
 * resolves the file's absolute path. `name` must match `/^[\w.-]{1,64}$/`
 * and must not be `.` or `..`; anything else throws a TypeError before
 * crossing.
 */
export function writeTempFile(name: string, contents: string): Promise<string> {
  if (typeof name !== 'string' || !FILE_NAME.test(name) || /^\.+$/.test(name)) {
    throw new TypeError(
      'writeTempFile: name must be 1-64 letters, digits, "_", "." or "-", and not only dots',
    );
  }
  if (typeof contents !== 'string') {
    throw new TypeError('writeTempFile: contents must be a string');
  }
  return NativeBugseeE2E.writeTempFile(name, contents);
}

/** Whether a file exists at `path`. A non-string path throws a TypeError. */
export function fileExists(path: string): Promise<boolean> {
  if (typeof path !== 'string') {
    throw new TypeError('fileExists: path must be a string');
  }
  return NativeBugseeE2E.fileExists(path);
}
