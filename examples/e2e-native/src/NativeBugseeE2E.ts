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
}

export default TurboModuleRegistry.getEnforcing<Spec>('BugseeE2E');
