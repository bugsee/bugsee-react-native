/**
 * Real, engine-captured `error.stack` strings (review M2 -- the original
 * `stack.test.ts` inputs were all hand-written single lines).
 *
 * How each was captured, verbatim reproducible on this machine:
 *
 * ```js
 * // sample.js
 * function level3() {
 *   throw new Error("captured stack sample");
 * }
 * function level2() {
 *   level3();
 * }
 * function level1() {
 *   [1].forEach(function () {
 *     level2();
 *   });
 * }
 * try {
 *   level1();
 * } catch (e) {
 *   if (typeof print === 'function') { print(e.stack); } else { console.log(e.stack); }
 * }
 * ```
 *
 * - V8: `node sample.js` (Node v24.15.0).
 * - JSC: `jsc sample.js`, where `jsc` is
 *   `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`
 *   (macOS 26.6.2's system JavaScriptCore; there is no separate "jsc CLI
 *   version" -- it is whatever ships with the OS).
 *
 * Both were captured with `sample.js` as the current directory's only file,
 * so the engine's own absolute path is exactly `.../<tmpdir>/sample.js`;
 * that directory has been replaced below with `/tmp/capture` for a stable,
 * readable fixture. Nothing else about either engine's output was edited --
 * same frames, same order, same punctuation.
 *
 * Hermes: no runtime was available to capture from. This machine's
 * `hermes-compiler` package (`node_modules/hermes-compiler/hermesc/osx-bin/hermesc`,
 * the only Hermes binary found under `node_modules/**`, `react-native/sdks/**`
 * or via `hermesc --help`'s own `-exec` flag) refuses to run a script
 * (`hermesc does not support -exec`; it only emits bytecode with
 * `-emit-binary`), and no separate `hermes` interpreter binary exists
 * anywhere in this tree. Per the task's own instruction not to download
 * anything new, `HERMES_RELEASE`/`HERMES_DEBUG` below stay hand-written,
 * built from the documented shapes (Phase 7's verified facts, the payload
 * table's worked example, and this repo's own e2e fixtures) rather than a
 * captured run. Task 7.5a's device run is the actual Hermes capture point.
 */

/** `node sample.js` (V8, Node v24.15.0). Real anonymous, `<anonymous>`, `node:` and named frames. */
export const V8_NODE_SAMPLE = `Error: captured stack sample
    at level3 (/tmp/capture/sample.js:2:9)
    at level2 (/tmp/capture/sample.js:5:3)
    at /tmp/capture/sample.js:9:5
    at Array.forEach (<anonymous>)
    at level1 (/tmp/capture/sample.js:8:7)
    at Object.<anonymous> (/tmp/capture/sample.js:13:3)
    at Module._compile (node:internal/modules/cjs/loader:1830:14)
    at Object..js (node:internal/modules/cjs/loader:1961:10)
    at Module.load (node:internal/modules/cjs/loader:1553:32)
    at Module._load (node:internal/modules/cjs/loader:1355:12)`;

/**
 * `jsc sample.js` (JSC, macOS 26.6.2's system JavaScriptCore). Real
 * anonymous (`@file:line:col` with no name), `forEach@[native code]` and
 * `global code@...` frames -- JSC never prepends a "Name: message" header.
 */
export const JSC_SAMPLE = `level3@sample.js:2:18
level2@sample.js:5:9
@sample.js:9:11
forEach@[native code]
level1@sample.js:8:14
global code@sample.js:13:9`;

/**
 * Hand-written (see the file header): a Hermes **release** shape --
 * `Name: message` header, `address at index.android.bundle` frames, an
 * `InternalBytecode.js` frame and a `(native)` frame -- matching the
 * payload table's own worked example and Phase 7's verified facts.
 */
export const HERMES_RELEASE_SAMPLE = `TypeError: captured stack sample
    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)
    at anonymous (address at index.android.bundle:1:20200)
    at global (address at InternalBytecode.js:1:1)
    at forEach (native)`;

/**
 * Hand-written (see the file header): a Hermes **debug** shape -- frames
 * served from a Metro dev-server URL, matching Phase 7's verified facts
 * (`index.bundle//&platform=...` query string) and the existing Metro-URL
 * unit test's format.
 */
export const HERMES_DEBUG_SAMPLE = `TypeError: captured stack sample
    at bugseeE2EThrowSite (http://localhost:8081/index.bundle//&platform=android&dev=true&minify=false:1234:20)
    at anonymous (http://localhost:8081/index.bundle//&platform=android&dev=true&minify=false:1200:9)`;

/**
 * Hand-written: a React componentStack shape (built-in host components plus
 * an owner-stack-style engine frame), matching the payload table's
 * `"in ComponentName (at File.js:10)"` form. Not engine-specific -- React
 * produces this string itself, on any of the three engines above -- so
 * there is nothing to "capture" per engine here.
 */
export const COMPONENT_STACK_SAMPLE = `    in View (<anonymous>)
    in RCTView (<anonymous>)
    in MyScreen (at App.js:42)
    in App (at index.js:7)`;
