import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * The native surface of the example-only `bugsee-e2e-native` module (Task
 * 7.6a, planner ruling R12). It is linked into examples/bare and nothing
 * else: a test hook that crashes the process has no business in a consumer's
 * app. Call it through `./index.ts`, which validates before crossing.
 */
export interface Spec extends TurboModule {
  /**
   * Android: `'segv'` stores through a null pointer in JNI (SIGSEGV),
   * `'abort'` calls `abort()` (SIGABRT). Any other kind is logged and ignored.
   * iOS: `'segv'` stores through a bad pointer (EXC_BAD_ACCESS, SIGSEGV),
   * `'abort'` calls `abort()` (SIGABRT); any other kind is logged and ignored.
   */
  crashNative(kind: string): void;
  /**
   * Writes `contents` as UTF-8 to `name` in the app's cache directory
   * (Android `getCacheDir()`, iOS `NSTemporaryDirectory()`), replacing any
   * file there, and resolves its absolute path.
   */
  writeTempFile(name: string, contents: string): Promise<string>;
  /** Whether a file exists at `path`. */
  fileExists(path: string): Promise<boolean>;
  /**
   * Blocks the main (UI) thread for `ms` milliseconds, from a task posted to
   * it, and resolves once it has run (campaign N-12: hang detection).
   */
  blockMain(ms: number): Promise<void>;
  /**
   * One line through the platform's native log: Android `android.util.Log`
   * (tag `BugseeE2ENative`), iOS `os_log` (subsystem `com.bugsee.e2e`,
   * category `native`, `%{public}s`). Level: debug, info, warn or error.
   */
  nativeLog(level: string, message: string): void;
  /**
   * One line through React Native's own native log, with no JS echo: iOS
   * `RCTLog` (`_RCTLogNativeInternal`), Android `FLog` with RN's tag
   * `ReactNative`. Level: trace, info, warn or error.
   */
  rctLog(level: string, message: string): void;
  /**
   * Android: adds (`on`) or clears `WindowManager.LayoutParams.FLAG_SECURE`
   * on the current activity's window, on the UI thread, and resolves true
   * once applied. iOS has no such flag: resolves false.
   */
  setFlagSecure(on: boolean): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('BugseeE2E');
