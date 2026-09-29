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
 * `jsc sample2.js` (same JSC as above), where `sample2.js` is:
 *
 * ```js
 * function TypeErrorFactory() {
 *   throw new TypeError("boom");
 * }
 * try {
 *   TypeErrorFactory();
 * } catch (e) {
 *   print(e.stack);
 * }
 * ```
 *
 * Real captured output (review N2): the thrown error's `name` is
 * `"TypeError"`, and the top frame's own function name, `TypeErrorFactory`,
 * starts with it as plain text. `stripKnownHeader` must not strip `name` as
 * a bare prefix here -- there is no header to strip at all (JSC never
 * writes one) -- or this frame's member becomes the wrong `"Factory"`.
 */
export const JSC_NAME_PREFIX_COLLISION_SAMPLE = `TypeErrorFactory@sample2.js:2:22
global code@sample2.js:5:19`;

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
 * Not hand-written, and not "captured" by running anything -- built by hand
 * from reading the actual algorithm in this machine's bundled React 19.2
 * renderer, `node_modules/react-native/Libraries/Renderer/implementations/
 * ReactFabric-dev.js`, `describeBuiltInComponentFrame` (lines 252-267) and
 * `getStackByFiberInDevAndProd` (line 451, which walks the fiber tree
 * calling it for a built-in host component -- `View`, `Text`, ... -- or
 * `describeNativeComponentFrame` for a user one, concatenating the
 * results). Round 1's `COMPONENT_STACK_SAMPLE` invented `"in View
 * (<anonymous>)"`, a shape this renderer does not produce (review M2/N4).
 *
 * `describeBuiltInComponentFrame` picks its own format at runtime from a
 * real `Error().stack` sample of the *current* engine: `"\n" + prefix +
 * name + suffix`, where (its own source, verbatim) `prefix` is `"    at "`
 * when the engine's own stacks contain `"\n    at"` (Hermes, V8) or `""`
 * otherwise, and `suffix` is `" (<anonymous>)"` for the first case or
 * `"@unknown:0:0"` for one whose stacks contain `"@"` (JSC) instead. A
 * user component instead goes through `describeNativeComponentFrame`,
 * which really throws from inside the component function and reads back
 * its engine-native frame -- the same "at NAME (file:line:col)"/
 * "NAME@file:line:col" shape as everywhere else here, with a real
 * location. `user` is false for the two built-in sentinels
 * (`"<anonymous>"` has no line/column at all; `"unknown:0:0"` is line 0,
 * column 0 by construction, review N4) and true for `MyScreen`.
 */
export const COMPONENT_STACK_SAMPLE_HERMES = `    at MyScreen (App.js:42:10)
    at View (<anonymous>)
    at App (index.js:7:5)`;

/** The same tree, on JSC's own stack shape -- see `COMPONENT_STACK_SAMPLE_HERMES`. */
export const COMPONENT_STACK_SAMPLE_JSC = `MyScreen@App.js:42:10
View@unknown:0:0
App@index.js:7:5`;
