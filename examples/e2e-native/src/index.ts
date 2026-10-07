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
 * from JNI code on Android and from the module's Objective-C++ on iOS. Any
 * other kind throws a TypeError here and never reaches native code.
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

/** The longest main-thread block `blockMain` accepts: one minute. */
export const BLOCK_MAIN_MAX_MS = 60_000;

/**
 * Blocks the main (UI) thread for `ms` (an integer from 0 to 60000) from a
 * task posted to it, and resolves once that task has run. JS timers stall
 * meanwhile (they are driven from the main thread). Anything else throws a
 * TypeError before crossing.
 */
export function blockMain(ms: number): Promise<void> {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > BLOCK_MAIN_MAX_MS) {
    throw new TypeError(`blockMain: ms must be an integer from 0 to ${BLOCK_MAIN_MAX_MS}`);
  }
  return NativeBugseeE2E.blockMain(ms);
}

export type NativeLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RctLogLevel = 'trace' | 'info' | 'warn' | 'error';

const NATIVE_LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const RCT_LOG_LEVELS: readonly string[] = ['trace', 'info', 'warn', 'error'];

/** The longest line the log helpers accept (logcat truncates near 4 KB). */
export const LOG_MESSAGE_MAX = 2000;

function checkMessage(helper: string, message: string): void {
  if (typeof message !== 'string' || message.length === 0 || message.length > LOG_MESSAGE_MAX) {
    throw new TypeError(`${helper}: message must be a string of 1 to ${LOG_MESSAGE_MAX} characters`);
  }
}

/**
 * One line through the platform's native log (Android `Log`, tag
 * `BugseeE2ENative`; iOS `os_log`, subsystem `com.bugsee.e2e`). A level
 * other than debug/info/warn/error, or a message that is not a 1-2000
 * character string, throws a TypeError before crossing.
 */
export function nativeLog(level: NativeLogLevel, message: string): void {
  if (typeof level !== 'string' || !NATIVE_LOG_LEVELS.includes(level)) {
    throw new TypeError("nativeLog: level must be 'debug', 'info', 'warn' or 'error'");
  }
  checkMessage('nativeLog', message);
  NativeBugseeE2E.nativeLog(level, message);
}

/**
 * One line through React Native's native log with no JS echo (iOS `RCTLog`,
 * Android `FLog` tag `ReactNative`). Level trace/info/warn/error; `error`
 * shows a red box in a Debug build. Checked as `nativeLog`.
 */
export function rctLog(level: RctLogLevel, message: string): void {
  if (typeof level !== 'string' || !RCT_LOG_LEVELS.includes(level)) {
    throw new TypeError("rctLog: level must be 'trace', 'info', 'warn' or 'error'");
  }
  checkMessage('rctLog', message);
  NativeBugseeE2E.rctLog(level, message);
}

/**
 * Android: sets or clears FLAG_SECURE on the current activity's window and
 * resolves true once applied. iOS resolves false. A non-boolean throws a
 * TypeError before crossing.
 */
export function setFlagSecure(on: boolean): Promise<boolean> {
  if (typeof on !== 'boolean') {
    throw new TypeError('setFlagSecure: on must be a boolean');
  }
  return NativeBugseeE2E.setFlagSecure(on);
}
