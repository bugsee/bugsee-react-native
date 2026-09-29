/**
 * `packages/react-native/android` is built by two separate Gradle builds:
 * the standalone unit-test build at the repo root (this settings.gradle,
 * `:bugsee-android-bridge`) and the example app (`examples/bare/android`),
 * via autolinking as `:bugsee_react-native`. Both defaulted to writing into
 * the SAME directory under that module (`.../android/` + `build/`), so
 * running one after the other without a clean in between left each build
 * looking at the other's stale classes, generated codegen and test results
 * -- twice misread by implementers as a real `ReactRootOriginTrackerTest`
 * failure, when a clean build passed.
 *
 * The fix redirects ONLY the standalone project's build directory, in the
 * root settings.gradle, via `gradle.beforeProject` and the lazy
 * `layout.buildDirectory` API (not the deprecated `buildDir` setter, which a
 * `gradle.beforeProject` hook cannot reliably override post-AGP-8's
 * Provider-based layout). The example build's own default is untouched.
 *
 * This module checks that the redirect is really in settings.gradle, and
 * that no tracked script or CI file still hardcodes the old shared output
 * path -- checked as text, not by running Gradle, for the same reason
 * `maven-local.ts` does: these files are evaluated in contexts (a standalone
 * unit-test build, an autolinked example app) a plain Jest test cannot stand
 * up cheaply.
 */

/** The project path settings.gradle must redirect. */
export const REDIRECTED_PROJECT_PATH = ':bugsee-android-bridge';

// Split so this file's own source never spells out the offending path as one
// contiguous literal in a comment -- only the exported constant below does,
// deliberately, as the one place meant to.
const OLD_SHARED_BUILD_OUTPUT_PARTS = ['packages/react-native/android/', 'build/'];

/**
 * The old, shared build-output directory both Gradle builds used to write
 * into. A tracked script or CI file naming this (rather than the example's
 * own default, or the standalone build's new `build/android-bridge`) is
 * still pointed at a path that is stale the moment the two builds run in
 * either order without a clean between them.
 */
export const OLD_SHARED_BUILD_OUTPUT = OLD_SHARED_BUILD_OUTPUT_PARTS.join('');

/**
 * Whether `settingsGradle` redirects the standalone project's build
 * directory: a `gradle.beforeProject` hook, scoped to
 * `:bugsee-android-bridge`, that sets `layout.buildDirectory` (the lazy,
 * Provider-based API) rather than assigning the deprecated `buildDir`
 * property.
 */
export function redirectsStandaloneBuildDir(settingsGradle: string): boolean {
  const hookMatch = /gradle\.beforeProject\s*\{[\s\S]*?\n\}/.exec(settingsGradle);
  if (!hookMatch) return false;
  const hook = hookMatch[0];
  if (!hook.includes(REDIRECTED_PROJECT_PATH)) return false;
  if (!/\blayout\.buildDirectory\.set\(/.test(hook)) return false;
  // Guards against a hook that name-checks the right project but reassigns
  // the deprecated, eager `buildDir` property instead of the one this task
  // requires. `\s*=` after the word boundary keeps this from also matching
  // `buildDirectory` above, whose next character is never `=`.
  if (/\bbuildDir\s*=/.test(hook)) return false;
  return true;
}

/**
 * Every path in `files` (repo-relative, as `git ls-files` prints it) whose
 * content still hardcodes the old shared build-output directory. `files`
 * maps path -> content; callers decide which tracked paths to check (a
 * checker cannot include itself, since it must spell the offending literal
 * out once to search for it).
 */
export function findOldBuildPathReferences(
  files: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(files)
    .filter(([, content]) => content.includes(OLD_SHARED_BUILD_OUTPUT))
    .map(([file]) => file);
}
