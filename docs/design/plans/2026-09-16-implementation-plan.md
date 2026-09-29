# Bugsee React Native SDK 7.x — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@bugsee/react-native` at parity with the 7.x native SDKs — every method, object, event and bridging layer — built incrementally, each phase leaving the SDK working and releasable.

**Architecture:** A yarn-4 workspace with two publishable packages. A TypeScript facade over a TurboModule spec; one Android source set; an iOS bridge delivered two ways (hand-written `ios/Package.swift` for RN's SPM autolinking, podspec vendoring the same xcframework for CocoaPods apps). A single `BugseeWrapper` implementation per platform is the integration seam for identity, lifecycle, secure rectangles and report handling.

**Tech Stack:** TypeScript 5, React Native ≥0.81 (New Architecture required), yarn 4 (`nodeLinker: node-modules`), Turbo, `react-native-builder-bob`, Jest, Stryker, Java 17 / AGP 8, ObjC++.

**Spec:** `docs/design/2026-09-15-sdk-design.md`

---

## Global Constraints

Every phase's requirements implicitly include this section.

- React Native floor **0.81.0**, New Architecture required. No `oldarch` source set, no legacy bridge fallback. 0.81 still allows opting out of the New Architecture; that is a documented requirement on the consumer, not a second code path. Hard technical floor is 0.80 (`codegenConfig.ios.modulesProvider`).
- Android SDK **7.3.0** (pinned transitionally as `7.3.0-SNAPSHOT` while the release is pending — see Phase 3's rulings), Gradle plugin **4.0.7**, pinned exactly. Neither older pin carries what this wrapper needs: 7.2.0 has no wrapper channel, report-contract methods, `BugseeReportHandlerThread` or `com.bugsee.option.$$WRAPPER` consumer, and 4.0.6 strips every extension's provider (workbook 1.4). The plugin marker resolves from **Maven Central**, not the Gradle Plugin Portal.
- iOS SDK **7.0.0-beta3** from `https://github.com/bugsee/spm`, requirement `exact`. SwiftPM will not admit a prerelease into a range. iOS deployment target **15.0**.
- Package `@bugsee/react-native`. `toSwiftName` maps it to `ReactNative`, which is **reserved**, so `react-native.config.js` pins `spm: { name: 'BugseeReactNative' }` and the SPM product name must match exactly.
- All native versions live in **one** file, `native-versions.json`, consumed by the podspec, `Package.swift` and the Gradle module. The SPM pin and podspec URL must never disagree.
- Every SDK entry point is called on the **main thread** on iOS. `launchWithToken:` off-main logs *"Incorrect bugsee launch…"* and misbehaves.
- Option keys are the 7.x `com.bugsee.option.*` strings. Enum options cross the bridge as **numbers**, converted on Android via each enum's `fromIntValue`/`fromRawValue` — **never `values()[n]`**; four of the five enums have internal values that differ from their ordinals.
- `endpoint` is the one option whose key differs per platform: Android `com.bugsee.option.$$ENDPOINT`; iOS the plain `endpoint`, whose value **must** carry a `/v2` suffix. Normalise in each bridge, not in the caller.
- Exception payloads keep the `ReactNativeWebException` name contract. The backend routes on that exact string.
- `IssueSeverity.Critical` exists on both platforms. It was never removed, despite older docs.
- No app token, endpoint or credential is ever committed.

## Working agreement

Each task: **red → green → mutate → commit.** The mutation step deliberately breaks the guard just implemented and confirms a test fails; if none does, the test is wrong and gets fixed before moving on. Observed mutation results go in the commit message.

Commits are small and single-purpose. A phase ends with a reviewer subagent; its findings are addressed and it re-reviews until satisfied.

**Test layers.** Unit tests (Jest, mocked bridge) for JS logic. Native unit tests (JUnit / XCTest) for marshalling and coercion. **Integration tests on real hardware** for anything crossing the bridge — an iPhone XS and a WOD_LX1 Android device are attached, plus six AVDs and iOS simulators. Anything with a filter callback, an event, or a native→JS round trip needs a device test; unit tests mock precisely the seam where the spike found every real failure.

**CI gate:** lint, typecheck, unit, mutation threshold, both platforms building the example app, **and an assertion that `Bugsee.framework` is embedded in the built `.app`**. A build that succeeds without it crashes at launch — the false pass the spike caught.

---

## Phase order and rationale

Ordered so each phase is independently shippable and so the riskiest work lands first. Phase 1 exists because the spike proved the distribution mechanism is where this project can actually fail.

| # | Phase | Ships |
|---|---|---|
| 1 | Foundation & distribution | An app that links, loads and launches the SDK on both platforms, both iOS delivery paths; `attach`, `testNativeCrash`, `testJsCrash` |
| 2 | Options model | Typed launch options provably consistent with both SDKs |
| 3 | Wrapper contract | Reports carry wrapper identity; lifecycle events; secure rectangles; report handler |
| 4 | Logging, events, traces | `log`, `event`, `trace` |
| 5 | Attributes & identity | `setAttribute` family, `setUserIdentifier` family |
| 6 | Privacy | Blackout, `<BugseeSecure>`, secure rects, `captureViewHierarchy` |
| 7 | Exceptions | `logException`, `logUnhandledException`, `ErrorBoundary`, debug IDs |
| 8 | Reporting | `showReportDialog`, `upload`, `createReport`, attachments |
| 9 | Capture & filters | console, network, breadcrumbs, and their filter callbacks |
| 10 | Notify & APM | `notify`, `startTransaction`, `startSpan`, `getActiveSpan` |
| 11 | Appearance & data | `appearance`, `deleteCollectedDataOnDevice` |
| 12 | Feedback package | `@bugsee/react-native-feedback` |
| 13 | Build tooling | Source maps, dSYM upload, Expo config plugin |

Phases 4–6 are deliberately small and mechanical — they establish the bridging pattern that 7–11 reuse, so the hard parts arrive after the pattern is proven.

---

## Phase 1 — Foundation & distribution

**Ships:** `launch`, `relaunch`, `stop`, `getStatus` working on both platforms, over both iOS delivery paths.

**Why first:** the spike proved `spm_dependency` fails to link, and that a build can succeed while the framework is never embedded. Until a real app in this repo launches the SDK on real hardware, every other phase is built on an assumption.

### Task 1.1 — Workspace scaffold and the single version source

**Files:** `package.json`, `.yarnrc.yml`, `.gitignore`, `turbo.json`, `tsconfig.base.json`, `native-versions.json`, `scripts/native-versions.ts`
**Test:** `scripts/__tests__/native-versions.test.ts`

**Produces:** `readNativeVersions(): NativeVersions` where `NativeVersions = { android: { sdk, gradlePlugin }, ios: { sdk, spmUrl } }`. Tasks 1.3, 1.4 and 13.x read it.

- [ ] **Red** — test that every version is an exact pin and that a range throws:

```ts
import { readNativeVersions } from '../native-versions';

it('pins exact versions, never ranges', () => {
  const v = readNativeVersions();
  expect(v.android.sdk).toMatch(/^\d+\.\d+\.\d+$/);
  expect(v.ios.sdk).toBe('7.0.0-beta1');
});

it('rejects a range, which SwiftPM cannot resolve for a prerelease', () => {
  expect(() => readNativeVersions({ ios: { sdk: '^7.0.0', spmUrl: 'x' }, android: { sdk: '7.2.0', gradlePlugin: '4.0.6' } }))
    .toThrow(/exact/i);
});
```

Run `yarn jest scripts` → FAIL, module not found.

- [ ] **Green** — `native-versions.json` with the pinned values, and `readNativeVersions` validating each against `/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/`, skipping `spmUrl`, throwing with the offending key named.

- [ ] **Mutate** — change the guard to `if (false)`. The range test must fail. Revert; record in the commit.

- [ ] **Commit** — `build: yarn workspace scaffold with a single pinned native-version source`

### Task 1.2 — TurboModule spec and lifecycle facade

**Files:** `packages/react-native/package.json`, `src/NativeBugsee.ts`, `src/index.ts`, `react-native.config.js`
**Test:** `src/__tests__/lifecycle.test.ts`

**Produces:** spec methods `launch(token, options) → Promise<boolean>`, `relaunch(options) → Promise<boolean>`, `stop() → Promise<boolean>`, `getStatus() → Promise<number>`, `testCrash() → void`; default export with the same names plus `attach()` and `testJsCrash()`; `Status = { Stopped: 0, Launching: 1, Launched: 2, Stopping: 3 }`. Every later phase adds to this spec.

`attach()` is JS-only — it wires the JS layer when the native side launched itself from Android manifest metadata, so no native call is made. `testJsCrash()` throws in JS; `testNativeCrash()` calls the SDK's `testCrash`. Both exist to make the device tests in 1.5 and every later phase runnable by hand.

- [ ] **Red** — four tests: token forwarded; `false` propagated without throwing; empty token rejected *before* the bridge is touched; native status number mapped onto `Status`.
- [ ] **Green** — the facade as specified; `TurboModuleRegistry.getEnforcing<Spec>('Bugsee')`.
- [ ] **Mutate** — remove the empty-token guard; the third test must fail.
- [ ] **Pin the reserved name** — `react-native.config.js` with `spm: { name: 'BugseeReactNative' }` and a comment explaining that `toSwiftName('@bugsee/react-native') === 'ReactNative'` is reserved and would otherwise be silently renamed.
- [ ] **Commit** — `feat(js): TurboModule spec and lifecycle facade`

### Task 1.3 — Android module

**Files:** `android/build.gradle`, `src/main/AndroidManifest.xml`, `src/main/java/com/bugsee/reactnative/BugseeModule.java`, `BugseePackage.java`
**Test:** `src/test/java/com/bugsee/reactnative/BugseeModuleTest.java`

Namespace `com.bugsee.reactnative` — not `com.bugsee`, which is the SDK's own package.

- [ ] **Red** — blank token rejects with `E_TOKEN` and never reaches the SDK; `statusToInt` maps `Launched → 2`, `Stopped → 0`.
- [ ] **Green** — the four methods delegating to `com.bugsee.library.Bugsee`; `statusToInt` package-visible so it is testable without a device; `api "com.bugsee:bugsee-android:${nativeVersions.android.sdk}"` read from `native-versions.json`.
- [ ] **Mutate** — map `Launched → 1`; the mapping test must fail.
- [ ] **Commit** — `feat(android): TurboModule bridging lifecycle`

### Task 1.4 — iOS, both delivery paths

**Files:** `ios/Package.swift`, `ios/react-native-spm-prefix.h`, `ios/BugseeModule.{h,mm}`, `BugseeReactNative.podspec`
**Test:** `ios/Tests/BugseeModuleTests.mm`

The manifest shape the spike proved. Four things are load-bearing and non-obvious:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "BugseeReactNative",
  platforms: [.iOS(.v15)],
  products: [.library(name: "BugseeReactNative", targets: ["BugseeReactNative"])],
  dependencies: [
    .package(name: "ReactNative", path: "../../../../xcframeworks"),
    .package(name: "React-GeneratedCode", path: "../../../ios"),
    .package(url: "https://github.com/bugsee/spm", exact: "7.0.0-beta1"),
  ],
  targets: [
    .target(
      name: "BugseeReactNative",
      dependencies: [
        .product(name: "ReactHeaders", package: "ReactNative"),
        .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
        .product(name: "Bugsee", package: "spm"),
      ],
      path: ".",
      publicHeadersPath: ".",
      cSettings: [.unsafeFlags(["-include", "react-native-spm-prefix.h"])],
      cxxSettings: [
        .define("DEBUG", .when(configuration: .debug)),
        .define("NDEBUG", .when(configuration: .release)),
        .unsafeFlags(["-include", "react-native-spm-prefix.h"]),
      ]),
  ])
```

1. The product name **must** equal the pinned `spm.name`.
2. The relative `path:` values resolve through the autolinker's symlink, not the realpath. They are identical for the root and `ios/` layouts.
3. `DEBUG`/`NDEBUG` are mandatory — `NDEBUG` shifts `ShadowNode` layout against the prebuilt `React.framework`, so omitting them fails **Release** while Debug passes.
4. There is no prefix header under SPM; `react-native-spm-prefix.h` replaces CocoaPods' `.pch` and must sit beside `Package.swift`.

- [ ] **Red** — `bgs_runOnMain` runs its block on the main thread; `bgs_isUsableToken` rejects whitespace.
- [ ] **Green** — the manifest above, the prefix header, and `BugseeModule.mm` wrapping every SDK call in a main-thread hop. The podspec vendors the same xcframework with its URL derived from `native-versions.json`.
- [ ] **Mutate** — call the block directly instead of hopping; run from a background queue; the main-thread test must fail.
- [ ] **Commit** — `feat(ios): TurboModule over SPM and CocoaPods delivery`

### Task 1.5 — Example apps and device integration tests

**Files:** `examples/bare/`, `examples/bare/e2e/launch.test.ts`

The task that proves the parts fit. Unit tests cannot: they mock the bridge, and every failure the spike found lives in the seam between JS, native and the build system.

- [ ] **Red** — e2e asserting `getStatus()` reaches `Status.Launched` within 10s.
- [ ] **Green** — wire the app: workspace dependency; Metro `watchFolders` + `nodeModulesPaths` + `extraNodeModules` (a `file:`-linked library fails to bundle without all three); apply the Gradle plugin; add `mavenCentral()` to `pluginManagement`; write `android/bugsee.properties` with the token.
- [ ] **Verify the iOS embed** — `find "$APP" -name Bugsee.framework` must be non-empty and `otool -L` must show `@rpath/Bugsee.framework/Bugsee`. Without this a build passes and the app crashes at launch.
- [ ] **Run on real hardware** — iPhone XS and the WOD_LX1. Record the observed `Launching → Launched` transition from each device's log.
- [ ] **Commit** — `test(e2e): example app reaching Launched on both platforms`

### Task 1.6 — CI

**Files:** `.github/workflows/ci.yml`

- [x] Lint, typecheck, unit, Stryker with a failing threshold (break 90; currently 97.69, shipped source 100).
- [x] Android: assemble the example app.
- [x] iOS: build the example, **then assert the framework is embedded**. The assertion is the point.
- [x] Matrix across RN 0.81.x, 0.83.x, 0.86.x, 0.87.x — as a **codegen + typecheck** matrix, not an app-build matrix.

  The original plan assumed the example could be re-pinned per leg. It cannot:
  `examples/bare/android` and `ios` are generated from **one** React Native
  template, and swapping the npm dependency does not swap the project. Pinning
  the example to 0.81 and building it fails compiling React Native's *own*
  `@react-native/gradle-plugin` sources, because the 0.87 template's Kotlin
  toolchain rejects them — nothing to do with this wrapper. Proven locally
  before the workflow was written a second time.

  So `scripts/check-rn-compat.sh <version>` runs per leg and asserts, against
  each real React Native: the `modulesProvider` collision fix is emitted, the
  `NativeBugseeSpec` protocol generates, `javaPackageName` is honoured, the
  generated Java signatures still match what `BugseeModule.java` implements,
  and our TypeScript typechecks. The app builds run on the example's own
  version, both iOS delivery paths.

  Two version-specific traps the script encodes: 0.83 moved the iOS artefacts
  under `ReactCodegen/`, so paths are located rather than hardcoded; and from
  0.83 the generator refuses to run without an `.xcodeproj`, so the probe
  makes a stub. Only the 0.87 leg exercises SPM — SPM support for apps does not exist before 0.87, so 0.81-0.86 are CocoaPods-only.

  **Already established against RN 0.81.6** (probe, not a build — the matrix
  still has to compile and run):
  - iOS codegen accepts our `codegenConfig` and emits the collision fix,
    `@"Bugsee": @"BugseeModule"`, into `RCTModuleProviders.mm`.
  - `NativeBugseeSpec` ObjC protocol generates with the expected methods.
  - Android codegen honours `javaPackageName`, emitting into
    `com/bugsee/reactnative/`. The app-level JS executor hardcodes
    `com.facebook.fbreact.specs` in **both** 0.81 and 0.87 — only the Gradle
    task honours the setting, so probe through `generate-specs-cli.js`, not
    `generate-codegen-artifacts.js`, or the result is misleading.
  - The generated Java abstract signatures are identical to 0.87's; 0.81
    additionally annotates them `@ReactMethod` / `@DoNotStrip`, which is
    additive and does not affect the subclass.
  - `BaseReactPackage` with abstract `getModule` exists in 0.81.
  - `yarn typecheck` passes against 0.81's types; the
    `react-native-legacy-deep-imports` condition is inert there (0.81 exposes
    `./Libraries/*.d.ts` with a working `default`) rather than harmful.

  Still unproven on 0.81: the Android Gradle build, the iOS app build, and
  anything that runs on a device.
- [x] **Commit** — `ci: build both platforms and assert the iOS framework is embedded`

**Human step, blocking the SDK-runs check:** add `BUGSEE_TOKEN_IOS` (and
optionally `BUGSEE_ENDPOINT`) to the repository's Actions secrets. The iOS e2e
is the only job that proves the SDK *runs* rather than merely ships, and it
needs a real app token — with the placeholder the SDK accepts `launch()`, fails
to bring capture up and settles into Stopped. Until the secret exists the job
emits a warning annotation and skips that step rather than passing silently.

**Still to prove in CI:** the `spm add --deintegrate` leg has no local
equivalent and has never run. Everything else has now been executed locally at
least once.

**Follow-up worth its own task:** a genuine per-version *app* build needs a
per-version generated app (`npx @react-native-community/cli init --version
0.81` and link the workspace package), which is how RN libraries usually do it.
The compat matrix covers the wrapper's own surface; it does not cover, say, our
podspec breaking under an older CocoaPods template.

### Phase 1 review gate

Spawn a reviewer subagent. It must independently verify the embed assertion, the reserved-name pin, the main-thread hop and the version single-sourcing, and must run the device tests rather than trust reported output. Address findings; re-review until satisfied.

---

## Phase 2 — Options model

**Ships:** `BugseeLaunchOptions` + `AndroidLaunchOptions` + `IOSLaunchOptions`, keyed by `com.bugsee.option.*`, with `setCustomOption`.

- [ ] **2.1** Base class holding `Map<string, unknown>` keyed by real 7.x option keys, plus `$localOptions` never sent native. Tests: setting and reading back; `undefined` deletes; `setCustomOption` reaches the same map as a first-class accessor.
- [ ] **2.2** The two platform subclasses and `createDefaultLaunchOptions()` selecting on `Platform.OS`. Tests: an iOS-only key is absent from an Android serialisation and vice versa.
- [ ] **2.3** Enum coercion on the Android bridge — a per-key number→enum table using `fromIntValue`/`fromRawValue`. Tests pin `LogLevel.Error → 1` (ordinal 0) and `VideoMode.Fullscreen → 20` (ordinal 3). **Mutate:** switch the table to `values()[n]`; both must fail.
- [ ] **2.4** `endpoint` normalisation — Android to `$$ENDPOINT` passthrough, iOS to `endpoint` with `/v2` appended when absent. Tests both directions, including an input that already carries `/v2`.
- [ ] **2.5** Defaults read back from `getLaunchOptions()` after launch, so hardcoded values only answer pre-launch.
**Resolved in 7.0.0-beta2; removed in Task 3.7.** This phase originally
carried two temporary workarounds for `bugsee/bugsee-cocoa#99` (the iOS
bridge settling `relaunch()` itself after 30s with `E_RELAUNCH_NO_REPORT`,
because `relaunchWithOptions:started:` could never invoke `started:`) and
`bugsee/bugsee-cocoa#100` (an iOS `getLaunchOptions` getter that could not
answer for an option the app never set, and the platform caveats in
`NativeBugsee.ts`, `index.ts` and `BugseeLaunchOptions.refreshFrom` that
documented it). Both issues are closed as completed and both fixes are
ancestors of beta2 and beta3; Task 3.7 proved this on-device before deleting
the workarounds, and `git grep bugsee-cocoa#` now finds nothing.

- [ ] **2.6** Device integration: launch with a non-default option on both devices and assert via `getLaunchOptions()` that it took effect.
- [x] **2.7** Manifest parity gate against `bugsee/specs` `sdk/options/`.

  The spec now EXISTS (`sdk/options/manifest.md`, format version 1) and
  independently confirms the enum trap: `enum.values` carries "the SDK's
  internal value — never its ordinal". Its status is still **Proposed — no SDK
  publishes a manifest yet**, so the gate reads a committed manifest generated
  from the Android SDK sources *in exactly that shape* (77 options, with
  declared types, defaults and enum constants).

  Swapping to a published manifest at
  `https://download.bugsee.com/sdk/options/android/<version>.json` is then a
  change of SOURCE, not of format, and the assertions stand unchanged.

  Proved to bite: bumping `native-versions.json` without regenerating,
  removing an enum key from the bridge's coercion table, and drifting a TS
  enum value each fail it.

  **Still blocked for iOS.** A spec-shaped manifest cannot be generated from
  the Apple sources: the spec's own Producer requirements note that
  `valueClass` collapses bool, int, float and enum into `NSNumber`, so an
  explicit value-type tag must be added to the SDK first. Until then the iOS
  side is checked by the key fixture only, not by type or default. **Blocked:** neither SDK publishes a manifest yet, and both need a complete descriptor enumerator first (plus a value-type tag on Apple). Ship a committed fixture and a test that reads it; swap to the published manifest when it exists.
- [ ] Review gate.

---

## Phase 3 — Wrapper contract

**Ships:** a `BugseeWrapper` implementation per platform — the seam for identity, context, lifecycle events, secure rectangles, report handling and the wrapper channel. Replaces four scattered mechanisms in the 6.x wrapper.

- [x] **3.1** Identity and context: `getWrapperType() → "react_native"`, version, build, and a context map carrying RN version, JS engine and build configuration. Device test: a report's environment shows the wrapper block.
- [x] **3.2** `onLifecycleEvent(name, data)` → a typed JS event, plus `onStatusChange(cb)` derived from it. Expose only events that fire on at least one platform; document per-event availability. Device test on both.
- [x] **3.2b** Guard the iOS lifecycle emitter (added by controller ruling after the Task 3.4e review): a lifecycle event that arrives before the codegen emitter exists no longer terminates the app; it is dropped, logged once, through the same guard the report-handler emit uses. Also corrects the false "SDK holds main" comments — see the design doc's report-handler dispatch note.
- [x] **3.3** `getSecureRectangles(display)` — the pull-based buffer `[version, count, l,t,r,b, …]`. Tests pin the encoding and that the version increments on every change.

### Rulings for the rest of Phase 3

Decided by the controller on 2026-09-28. Not open for re-litigation inside a task; a task that finds one wrong stops and reports.

- **Ruling:** Android develops against `bugsee-android` `origin/main`, built from a **separate clone** (never the shared `~/Projects/Bugsee/android/sdk` working tree) and published to mavenLocal as `7.3.0-SNAPSHOT`; `native-versions.json` pins `"7.3.0-SNAPSHOT"`, and `mavenLocal()` appears only where a `-SNAPSHOT` pin needs it.
- **Ruling:** the device harness asserts the Android SDK banner's commit SHA against the commit the SNAPSHOT was built from (workbook 9.1.1).
- **Ruling:** the flip to `7.3.0` is its own later task — the pin line plus removing mavenLocal, nothing else.
- **Ruling:** the package is never released while any pin is a SNAPSHOT; `BUGSEE_RELEASE=1 yarn test` fails if one is.
- **Ruling:** iOS pins `7.0.0-beta3`. Android and JS land first; the iOS halves are separate, later tasks whose first step checks that beta3 is published.
- **Ruling:** if beta3 is not published when the iOS tasks start, build a local xcframework from `bugsee-cocoa` commit `74af69ee8` (the beta3 release commit) in a separate clone, and pin it by committing the `ios.sdk` version with `Package.resolved`'s `spm` revision set to a zero placeholder. A local-zip env-var override was tried as a fallback and removed in `b873020` once beta3 published; see Task 3.P2 for what it was and why it was removed.
- **Ruling:** Task 3.4 (report handler) splits into JS API; Android bridge; iOS bridge; device verification (done per platform, Android first).
- **Ruling:** `isTerminating = true` never round-trips to JS; the bridge completes natively at once.
- **Ruling:** the SDK completion is always called — on success, on JS throw, on timeout, and when no handler is set.
- **Ruling:** the bridge's deadline is below the SDK's cap on the path it runs on: live 30 s; recovery 3 s (iOS recovery and Android early-crash recovery, where the completion is not awaited).
- **Ruling:** a handle is dead after completion; ops on it reject with a stable error code.
- **Ruling:** `onAfterReportCreated` may be delivered more than once; it is documented and the proxy tolerates it.
- **Ruling:** severity crosses by value, 1–5; iOS `0` reads as `undefined`; out-of-range values are rejected in JS before they cross. No bitmap ever crosses (workbook 7.3).
- **Ruling:** Task 3.5 implements `onWrapperChannelAvailable` on both platforms, stores the channel first thing in a volatile/atomic field outside the wrapper object, and proves the seam with one internal route: a JS log line through `channel.log` with source `Custom`. Phase 4 builds `log()` on it; Phase 9 routes `console.*`.
- **Ruling:** network events go through the channel with `requiresFiltering = true`, always.
- **Ruling:** Task 3.6 catches the docs up; the `bugsee-cocoa#99`/`#100` workaround notes are removed only because both issues are verified fixed (below), and deleting the code is its own task (3.7).

### Planner decisions (reviewable; change them here, not inside a task)

- **Handler shape: two optional callbacks, not one callback with a `phase`.** `Bugsee.setReportHandler({ onBeforeReportCreated?, onAfterReportCreated? } | null)`, each `(report: BugseeReport) => void | Promise<void>`. Grounded in the contract: both SDKs name the two callbacks exactly so, and they have different delivery guarantees (before at-most-once, after at-least-once), which a single callback hides behind a string. It also lets native skip the JS round trip for a phase the app never registered — which matters for `onAfter`, which can fire more than once. **`isTerminating` is not passed to JS:** the bridge never reaches JS when it is `true`, so JS would only ever see `false`, and a field that is constant by construction invites branching on it.
- **`upload(summary, description)` is pulled forward from Phase 8 (Task 3.4c).** The report-handler device tests need a *live* report that JS can trigger, and nothing else in the facade creates one before Phase 7/8. It is one method, the two-argument form only; Phase 8 adds severity and labels.
- **Deadline path detection.** The bridge cannot learn the path from `isTerminating` (false on both live and recovery). It uses the thread each SDK documents: iOS live = main thread, recovery = off main (`BGSContracts.h`, `BGSReportHandler`); Android live = the thread the public `ReportHandler` javadoc names, `BugseeReportHandlerThread`. Anything else gets the **shorter** recovery deadline, so an SDK change that renames a thread fails safe (enrichment cut short), never unsafe (deadline past the cap).
- **Execution order is the order written below**, not numeric: 3.P1, 3.4a, 3.4b, 3.4c, 3.5a, 3.4d, 3.5b, 3.P2, 3.7, 3.4e, 3.2b, 3.5c, 3.4f, 3.5d, 3.6, 3.P3, 3.P4, review gate. (3.2b was inserted after 3.4e by controller ruling, once the 3.4e review found the defect it fixes; it is not in the order the rest of this list was written in.)

### Verified facts these tasks rely on (2026-09-28)

- Android `origin/main` @ `234dcddfc`: `version.txt` still reads `7.2.0`; a non-`RELEASE` build appends `-SNAPSHOT`, so the separate clone must write `7.3.0` into `version.txt` locally. The banner is `Log.d("Bugsee", "Bugsee Android SDK " + VERSION_NAME + " [" + BUILD_CHECKSUM + "]")` (`BugseeInternal.java:202`), where `BUILD_CHECKSUM` is `git rev-parse --short HEAD` of the clone.
- `~/.m2/repository/com/bugsee/bugsee-android/` already holds stale local builds, including a non-SNAPSHOT `7.3.0` from 2026-09-20. Every mavenLocal declaration below is therefore content-filtered to `com.bugsee` **`-SNAPSHOT` versions only**.
- `bugsee/bugsee-android` and `bugsee/bugsee-cocoa` are **private**; CI cannot build a SNAPSHOT itself.
- iOS beta3 is **not published** today: `bugsee/spm` has tags up to `7.0.0-beta2`, and `https://download.bugsee.com/sdk/ios/spm/Bugsee-7.0.0-beta3.zip` answers `403`. `bugsee-cocoa` `74af69ee8` is `release: 7.0.0-beta3`, `version.txt` = `7.0.0-beta3`; its `scripts/build.sh` produces `build/bugsee-spm-xcframework.zip` in the published zip's layout.
- `bugsee/bugsee-cocoa#99` and `#100` are **closed as completed** (2026-09-17). Their fixes (`8ed4ab31e`, `0eb3ec195`) are ancestors of both the beta2 (`376e3a5d2`) and beta3 (`74af69ee8`) release commits.
- `bugsee/bugsee-android#178` (screenshot display ids ascending) is **open**, so the 7.3.0-SNAPSHOT does not sort them. The bridge sorts.
- Android handler caps: live 30 s per handler (option `com.bugsee.option.config.report-handler-callback-timeout`, default 30, `0` disables the per-handler timer), 60 s per chain; uncaught Java exception `isTerminating = true`, 3 s, `onBefore` only; early-crash recovery 3 s, completion not awaited. iOS: live on main, 30 s per handler (constant, no option), 60 s chain; recovery off main, `boundedReportHandlerCap` 3 s, completion not awaited, `isTerminating = NO`.

### Constants every task below uses

| Name | Value | Why |
|---|---|---|
| `LIVE_DEADLINE_MS` | `25000` | SDK live cap is 30 s per handler. 5 s headroom covers the bridge hops and JS-thread queueing, and leaves the app's own native handler (which runs after ours) room inside the 60 s chain cap. |
| `RECOVERY_DEADLINE_MS` | `2500` | Recovery cap is 3 s (iOS `boundedReportHandlerCap`, Android early-crash). 500 ms headroom. |
| `MIN_USEFUL_DEADLINE_MS` | `1000` | Below this a JS round trip cannot complete; complete natively without emitting. |
| Android live deadline | `min(25000, optionSeconds*1000 − 1000)` when `optionSeconds > 0`; `25000` when `0` or unreadable | Tracks an app that lowered `report-handler-callback-timeout`. |
| iOS live deadline | `25000` | No option exists on iOS. |
| `ANDROID_LIVE_HANDLER_THREAD` | `"BugseeReportHandlerThread"` | Named in the public `ReportHandler` javadoc. |

| Error code | Meaning |
|---|---|
| `E_REPORT_HANDLE_DEAD` | The handle completed, timed out, was released by a JS reload, or never existed. Same code whichever side notices. |
| `E_REPORT_ATTACHMENT_REJECTED` | The SDK returned null/nil from an attachment add: report no longer live, 1000-attachment cap, unreadable/missing file, or write failure. |
| `E_REPORT_BAD_ARGUMENT` | A value failed validation — in JS before crossing, or defensively in native. |

---

### Task 3.P1 — Android pin: `7.3.0-SNAPSHOT` from a separate clone, and the release guard

**Files:**
- Modify: `native-versions.json`, `scripts/native-versions.ts`, `scripts/__tests__/native-versions.test.ts`
- Modify: `settings.gradle` (root, standalone unit-test build), `examples/bare/android/build.gradle`
- Modify: `.github/workflows/ci.yml` (android job), `packages/react-native/package.json` (`prepack`), root `package.json` (`test:release`)
- Create: `scripts/releasable-pins.ts`, `scripts/cli-check-releasable-pins.ts`, `scripts/__tests__/releasable-pins.test.ts`
- Create: `scripts/__tests__/maven-local.test.ts`
- Create: `scripts/sdk-banner.ts`, `scripts/__tests__/sdk-banner.test.ts`
- Modify: `examples/bare/e2e/device.ts`, `examples/bare/e2e/launch.test.ts`

**Interfaces:**
- `native-versions.json` → `"android": { "sdk": "7.3.0-SNAPSHOT", "gradlePlugin": "4.0.7", "snapshotCommit": "<40-hex SHA of the clone's HEAD>" }`. `snapshotCommit` is present **iff** `sdk` ends in `-SNAPSHOT`; `readNativeVersions` adds it to `NOT_A_VERSION`, requires `/^[0-9a-f]{40}$/`, and throws naming the key when the pairing is violated in either direction.
- `releaseBlockers(versions: NativeVersions, supportPackageResolved: string): string[]` — one human-readable line per blocker: any pin ending `-SNAPSHOT`; `android.snapshotCommit` present; the `spm` pin in `ios/Support/Package.resolved` carrying the placeholder revision `0000000000000000000000000000000000000000` (see 3.P2).
- `checkAndroidBanner(line: string, versions: NativeVersions): { ok: true } | { ok: false; reason: string }` — parses `Bugsee Android SDK (\S+) \[([0-9a-f]{7,40})\]`; `ok` iff the version equals `versions.android.sdk` exactly and, when `snapshotCommit` is set, `snapshotCommit.startsWith(sha)`.

**Build the SNAPSHOT (human-run, recorded, never in CI):**

```sh
CLONE="$HOME/Projects/Bugsee/_clones/bugsee-android-rn-snapshot"   # NOT ~/Projects/Bugsee/android/sdk
[ -d "$CLONE" ] || git clone https://github.com/bugsee/bugsee-android.git "$CLONE"
cd "$CLONE"
git fetch origin && git checkout --detach origin/main
git submodule update --init --recursive
git status --porcelain                       # must be empty before the next line
printf '7.3.0\n' > version.txt               # local only; RELEASE unset makes it 7.3.0-SNAPSHOT
./gradlew :library:publishToMavenLocal :ndk:publishToMavenLocal
git rev-parse HEAD                           # -> native-versions.json android.snapshotCommit
ls ~/.m2/repository/com/bugsee/bugsee-android/7.3.0-SNAPSHOT/ ~/.m2/repository/com/bugsee/bugsee-android-ndk/7.3.0-SNAPSHOT/
```

Both artifacts are required: `packages/react-native/android/build.gradle` pins `bugsee-android` **and** `bugsee-android-ndk` to the same version.

**mavenLocal, only where a SNAPSHOT needs it.** In both Gradle files, read `native-versions.json` (root: `new File(settingsDir, 'native-versions.json')`; example: the `../../../native-versions.json` it already parses) and only when `android.sdk` ends with `-SNAPSHOT` add:

```groovy
mavenLocal {
    content { includeVersionByRegex('com\\.bugsee', '.*', '.*-SNAPSHOT') }
}
```

Root: inside `dependencyResolutionManagement.repositories`. Example: `allprojects { repositories { … } }`. The filter is load-bearing: the stale non-SNAPSHOT `7.3.0` in `~/.m2` must never be able to satisfy a request.

**CI.** First step of the `android` job: fail fast with `::error title=Local SNAPSHOT pin::native-versions.json pins Android ${sdk}, built from a private clone; CI cannot resolve it. Expected red until Task 3.P3 flips to 7.3.0.` when `android.sdk` ends `-SNAPSHOT`. An opaque dependency-resolution failure is the alternative. The step stays after the flip, where it passes.

**Release switch.** `BUGSEE_RELEASE=1` is the release mode. Root `package.json`: `"test:release": "BUGSEE_RELEASE=1 yarn test"`. `packages/react-native/package.json`: `"prepack": "node ../../scripts/cli-check-releasable-pins.ts"` (exits 1 printing every blocker). `prepack` is the hook `npm pack`, `npm publish`, `yarn pack` and `yarn npm publish` all run; yarn 4 never runs `prepublishOnly` (final-review fix A1).

- [x] **Red** — `scripts/__tests__/native-versions.test.ts`: `pins Android 7.3.0-SNAPSHOT with the commit it was built from`; `rejects a SNAPSHOT pin without snapshotCommit`; `rejects snapshotCommit on a release pin`; `rejects a short or non-hex snapshotCommit`. `scripts/__tests__/releasable-pins.test.ts`: `a SNAPSHOT android pin is a release blocker`; `snapshotCommit alone is a release blocker`; `the zero-revision Package.resolved placeholder is a release blocker`; `7.3.0 with a real revision has no blockers`; and the gate `(process.env.BUGSEE_RELEASE === '1' ? it : it.skip)('the committed pins are releasable', …)`. `scripts/__tests__/sdk-banner.test.ts`: `accepts the SNAPSHOT banner whose SHA prefixes snapshotCommit`; `rejects a banner from a different commit, naming both SHAs`; `rejects 7.3.0 when 7.3.0-SNAPSHOT is pinned` (a published build outranked the local one); `rejects 7.3.0-SNAPSHOT when 7.3.0 is pinned` (stale mavenLocal leaked in); `rejects a line that is not the banner`. `scripts/__tests__/maven-local.test.ts`: `when no pin is a SNAPSHOT, no tracked Gradle file mentions mavenLocal`; `when a pin is a SNAPSHOT, every mavenLocal is guarded by the pin and filtered to com.bugsee -SNAPSHOT versions` (reads root `settings.gradle`, `examples/bare/android/build.gradle`, `examples/bare/android/settings.gradle`, `packages/react-native/android/build.gradle`). Run `yarn test` → the new cases FAIL.
- [x] **Green** — the pin, the validation, the guarded repositories, `releaseBlockers` + CLI, `checkAndroidBanner`, the CI step, the scripts. `yarn test` green; `BUGSEE_RELEASE=1 yarn test` **fails**, listing the SNAPSHOT pin (expected — that is the guard working). `./gradlew :bugsee-android-bridge:testDebugUnitTest` and `examples/bare/android ./gradlew assembleDebug` green against the SNAPSHOT; fix any compile break from 7.2.0 → main in this commit only if it is mechanical, otherwise stop and report.
- [x] **Harness** — `device.ts` adds `Bugsee:V` (already present) and `BugseeRN:V` to the logcat filter. `launch.test.ts` on Android inserts a step `SDK build` (`/Bugsee Android SDK \S+ \[[0-9a-f]+\]/`, 15 s) between `JS running` and `Status.Launched`, then asserts `checkAndroidBanner(matched, readNativeVersions())` is `ok`, failing with its `reason`.
- [x] **Mutate** — (1) make `releaseBlockers` ignore `-SNAPSHOT`: `a SNAPSHOT android pin is a release blocker` must fail. (2) compare only the version in `checkAndroidBanner`: `rejects a banner from a different commit` must fail. (3) drop the `content { … }` filter from the example's mavenLocal: the maven-local test must fail. Revert each; record results.
- [x] **Device** — WOD_LX1: `yarn workspace bugsee-example-bare device:android`, then `E2E_PLATFORM=android yarn workspace bugsee-example-bare e2e`. The `SDK build` step must print the clone's short SHA. Then the NDK check from workbook 1.4.2: `adb logcat` for ≥ 30 s after a cold start, `grep -oE "libbugsee[a-z-]*\.so" | sort -u | wc -l` → **4**.
- [x] **Commit** — `build(android): pin 7.3.0-SNAPSHOT from a separate clone, and refuse to release it`. Body: the clone SHA, the banner line observed, the `.so` count.

**Acceptance:** SNAPSHOT resolves only from mavenLocal and only for `com.bugsee` `-SNAPSHOT`; the banner SHA is asserted by the harness, not read by eye; `BUGSEE_RELEASE=1 yarn test` and `npm publish` both refuse; CI's android job fails with the named reason and nothing else.

---

### Task 3.4a — Report handler: JS API, types, proxy (bridge mocked), native stubs

**Files:**
- Modify: `packages/react-native/src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`
- Create: `src/report/types.ts`, `src/report/errors.ts`, `src/report/validate.ts`, `src/report/BugseeReport.ts`, `src/report/dispatcher.ts`
- Create: `src/report/__tests__/dispatcher.test.ts`, `src/report/__tests__/proxy.test.ts`, `src/report/__tests__/validate.test.ts`
- Modify (stubs only): `android/.../BugseeModule.java`, `ios/BugseeModule.mm`
- Create: `scripts/__tests__/ios-spec-coverage.test.ts`

**TurboModule additions (exact):**

```ts
readonly onReportHandlerRequest: EventEmitter<{
  handleId: string;   // opaque, native-minted, never reused in a process
  phase: string;      // 'before' | 'after'
  reportId: string;
  type: string;       // 'bug' | 'crash' | 'error' (open set)
  deadlineMs: number; // the native deadline for THIS handle
}>;
setReportHandlerPhases(before: boolean, after: boolean): void;
completeReportHandler(handleId: string): void;
reportRead(handleId: string): Promise<UnsafeObject>;
reportUpdate(handleId: string, patch: UnsafeObject): Promise<void>;
reportAddFileAttachment(handleId: string, path: string, name: string, mimeType: string | null, move: boolean): Promise<void>;
reportAddDataAttachment(handleId: string, base64: string, name: string, mimeType: string | null): Promise<void>;
```

`reportRead` resolves `{ summary: string|null, description: string|null, severity: number /* 0..5; 0 = iOS unset */, labels: string[], attributes: {[k]: string|number|boolean}, screenshotDisplayIds: number[], attachmentNames: string[] }`.

`reportUpdate` patch keys, all optional: `summary: string|null`, `description: string|null`, `severity: 1..5`, `labels: string[]` (**replaces** — Android `setLabels`, iOS `replaceLabels:`), `clearAttributes: true` (applied first), `attributes: {[k]: string|number|boolean|null}` (merge; `null` removes). Unknown keys are `E_REPORT_BAD_ARGUMENT`. Validation is all-or-nothing: nothing is applied unless every field is valid.

**Public JS API (exact):**

```ts
// src/report/types.ts
export type ReportType = 'bug' | 'crash' | 'error' | (string & {});
export interface BugseeReportSnapshot {
  summary: string | undefined;
  description: string | undefined;
  severity: IssueSeverity | undefined;          // iOS 0, or anything outside 1..5 -> undefined
  labels: string[];
  attributes: Record<string, string | number | boolean>;
  screenshotDisplayIds: number[];               // ascending, always
  attachmentNames: string[];
}
export interface ReportPatch {
  summary?: string | null;
  description?: string | null;
  severity?: IssueSeverity;
  labels?: readonly string[];
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  clearAttributes?: true;
}
export interface BugseeReport {
  readonly id: string;                          // synchronous, from the event
  readonly type: ReportType;                    // synchronous, from the event
  read(): Promise<BugseeReportSnapshot>;
  getSummary(): Promise<string | undefined>;      setSummary(v: string | null): Promise<void>;
  getDescription(): Promise<string | undefined>;  setDescription(v: string | null): Promise<void>;
  getSeverity(): Promise<IssueSeverity | undefined>; setSeverity(v: IssueSeverity): Promise<void>;
  getLabels(): Promise<string[]>;                 setLabels(labels: readonly string[]): Promise<void>;
  getAttributes(): Promise<Record<string, string | number | boolean>>;
  setAttribute(name: string, value: string | number | boolean | null): Promise<void>;
  clearAttributes(): Promise<void>;
  getScreenshotDisplayIds(): Promise<number[]>;
  getAttachmentNames(): Promise<string[]>;
  addFileAttachment(path: string, options: { name: string; mimeType?: string; move?: boolean }): Promise<void>;
  addDataAttachment(base64: string, options: { name: string; mimeType?: string }): Promise<void>;
  update(patch: ReportPatch): Promise<void>;
}
export interface BugseeReportHandler {
  onBeforeReportCreated?(report: BugseeReport): void | Promise<void>;
  onAfterReportCreated?(report: BugseeReport): void | Promise<void>;
}
// src/report/errors.ts
export const ReportErrorCode = {
  HandleDead: 'E_REPORT_HANDLE_DEAD',
  AttachmentRejected: 'E_REPORT_ATTACHMENT_REJECTED',
  BadArgument: 'E_REPORT_BAD_ARGUMENT',
} as const;
export class BugseeReportError extends Error { readonly code: (typeof ReportErrorCode)[keyof typeof ReportErrorCode]; }
// facade
setReportHandler(handler: BugseeReportHandler | null): void;
```

Getters are sugar over one `reportRead`. Exported from `src/index.ts`: `ReportErrorCode`, `BugseeReportError`, and the types above.

**Behaviour the dispatcher must have:**
- Subscribes to `onReportHandlerRequest` on the first non-null `setReportHandler`; stays subscribed. `setReportHandler(h)` calls `setReportHandlerPhases(!!h?.onBeforeReportCreated, !!h?.onAfterReportCreated)`; `null` → `(false, false)`.
- Per event: take the callback for `phase` from the handler **current at dispatch**; none → `completeReportHandler(handleId)` synchronously. Otherwise build a proxy, run the callback, and in `finally` mark the proxy dead and call `completeReportHandler` exactly once. A throw or rejection is caught and reported with `console.error('[Bugsee] report handler threw', error)`; it never becomes an unhandled rejection.
- A local timer at `deadlineMs` marks the proxy dead; ops after that reject locally. JS still calls `completeReportHandler` once when the callback settles (native treats a second completion as a no-op).
- Dead proxy ops reject with `BugseeReportError` code `E_REPORT_HANDLE_DEAD` **without crossing the bridge**. Native rejections surface with the same `.code`.
- JS validation before crossing: `setSeverity` accepts only integers 1–5 (`0`, `6`, `2.5`, `NaN` → `E_REPORT_BAD_ARGUMENT`); labels must be strings; attribute values must be string, boolean, finite number or `null`; `addFileAttachment` strips and percent-decodes only a `file://` URL and passes a plain path through verbatim (final-review fix A2), rejects an empty path or name; `addDataAttachment` requires `/^[A-Za-z0-9+/]*={0,2}$/` with length % 4 == 0, and a non-empty name. `getScreenshotDisplayIds` sorts ascending (Android #178 is open).
- **Document on `setReportHandler`:** register before `launch()` to see reports recovered at launch; `onBeforeReportCreated` is at-most-once and may be skipped; `onAfterReportCreated` is at-least-once and must be idempotent — `setLabels`/`setAttribute` rather than appending, and check `getAttachmentNames()` before adding; mutations after the handler settles (or after its deadline) do not reach the report; the deadline is the SDK's, not the app's.

**Native stubs in this task** (so every commit builds on both platforms): Android and iOS implement the six new methods. `setReportHandlerPhases` and `completeReportHandler` are no-ops; the four promise methods reject `E_REPORT_HANDLE_DEAD` — truthful, since no stub ever mints a handle. The wrappers keep completing immediately. `ios-spec-coverage.test.ts`: every method named in the `Spec` interface of `NativeBugsee.ts` has a matching first selector segment in `BugseeModule.mm`.

- [x] **Red** — `dispatcher.test.ts`: `invokes onBeforeReportCreated for phase "before" and completes after it resolves`; `invokes onAfterReportCreated for phase "after"`; `completes immediately when no handler is set`; `completes immediately when the phase has no callback`; `completes exactly once when the callback throws synchronously`; `completes exactly once when the callback rejects, and nothing is unhandled`; `setReportHandler(null) tells native no phase is wanted`; `registers only the phases the handler defines`; `a handler replaced mid-flight finishes with the callback captured at dispatch`; `two onAfter deliveries for one report get two independent proxies`; `the proxy dies at deadlineMs even if the callback never settles` (fake timers). `proxy.test.ts`: `ops after completion reject with E_REPORT_HANDLE_DEAD without crossing`; `a native E_REPORT_HANDLE_DEAD surfaces with the same code`; `severity 0 reads as undefined`; `severity 7 reads as undefined`; `severity 4 reads as IssueSeverity.Critical`; `setSeverity rejects 0, 6, 2.5 and NaN before crossing`; `setLabels sends the whole list in one reportUpdate`; `setLabels rejects a non-string label before crossing`; `setAttribute(name, null) sends a removal`; `setAttribute rejects NaN, Infinity and objects`; `update with one bad field sends nothing`; `addFileAttachment strips file:// and percent-decodes`; `addFileAttachment rejects an empty path or name`; `addDataAttachment rejects non-base64 before crossing`; `E_REPORT_ATTACHMENT_REJECTED surfaces with its code`; `getScreenshotDisplayIds is ascending even when native is not`; `id and type are synchronous and come from the event`. `validate.test.ts`: `ReportErrorCode values are exactly the three stable strings`. → FAIL.
- [x] **Green** — the modules above; the mock gains `onReportHandlerRequest` (subscribe), `emitReportHandlerRequest(event)`, and `jest.fn`s for the six methods (`reportRead` default resolves the empty snapshot).
- [x] **Stubs** — as above; `ios-spec-coverage.test.ts` green; the Android `java-signatures` check and both example builds green.
- [x] **Mutate** — (1) delete the JS severity range check: `setSeverity rejects … before crossing` must fail. (2) move `completeReportHandler` out of `finally`: `completes exactly once when the callback throws` must fail. (3) drop the local dead flag: `ops after completion reject … without crossing` must fail. (4) delete the iOS stub for `reportRead`: `ios-spec-coverage` must fail.
- [x] **Commit** — `feat(report): setReportHandler and the BugseeReport proxy, bridge stubbed`.

**Acceptance:** the whole JS contract is pinned by tests against the mock; no platform behaviour changes yet; every build green.

---

### Task 3.4b — Report handler: Android bridge

**Files:**
- Create: `android/src/main/java/com/bugsee/reactnative/ReportHandlerBridge.java`, `ReportHandlerDeadlines.java`, `ReportOps.java`
- Modify: `BugseeReactNativeWrapper.java` (both callbacks), `BugseeModule.java` (replace the 3.4a stubs; attach/detach)
- Create tests: `ReportHandlerBridgeTest.java`, `ReportHandlerDeadlinesTest.java`, `ReportOpsTest.java`, and helper `FakeReports.java` (builds a `Report` with `java.lang.reflect.Proxy`, recording calls and holding state, so no test implements the ~40-method interface by hand)

**Interfaces (plain Java, no React Native, JVM-testable):**

```java
final class ReportHandlerBridge {
    enum Phase { BEFORE("before"), AFTER("after"); final String wire; }
    interface Sink { void onReportHandlerRequest(String handleId, String phase, String reportId, String type, double deadlineMs); }
    interface Scheduler { Cancellable schedule(Runnable task, long delayMs); }   // injectable; prod = one daemon thread "BugseeRN-ReportDeadline"
    interface Cancellable { void cancel(); }
    static ReportHandlerBridge shared();
    interface LiveDeadlineSource { long liveMs(); }                             // own interface: java.util.function needs API 24, minSdk is 21
    ReportHandlerBridge(Scheduler scheduler, LiveDeadlineSource live);           // package-private, for tests
    void setPhases(boolean before, boolean after);
    void attach(Sink sink);
    void detach(Sink stale);             // identity-checked; completes every outstanding handle; resets phases to false
    void dispatch(Phase phase, Report report, boolean isTerminating, Runnable sdkCompletion);
    boolean complete(String handleId);   // true only for the call that ran the SDK completion
    @Nullable Report reportFor(String handleId);
}
final class ReportHandlerDeadlines {
    static final long LIVE_DEADLINE_MS = 25_000, RECOVERY_DEADLINE_MS = 2_500, MIN_USEFUL_DEADLINE_MS = 1_000;
    static final String LIVE_HANDLER_THREAD = "BugseeReportHandlerThread";
    static long liveMs(@Nullable Integer optionSeconds);   // null/0 -> 25000; else min(25000, s*1000 - 1000)
    static long forThread(String threadName, long liveMs); // LIVE_HANDLER_THREAD -> liveMs; anything else -> 2500
}
final class ReportOps {
    static Map<String, Object> read(Report report);        // severity via getValue(); labels; attributes; sorted display ids; attachment names
    static void apply(Report report, Map<String, Object> patch) throws BadArgument;  // validates all, then applies
    static boolean addFile(Report report, String path, String name, @Nullable String mimeType, boolean move); // false = SDK returned null
    static boolean addData(Report report, byte[] data, String name, @Nullable String mimeType);
    static final class BadArgument extends Exception { … }
}
```

**`dispatch` order (each is a test):** `isTerminating` → run `sdkCompletion` synchronously, return, emit nothing. No sink attached, phase not registered, or deadline `< MIN_USEFUL_DEADLINE_MS` → complete immediately. Otherwise mint `"rh-" + counter`, store `{report, completion, done}`, arm the deadline, call the sink (a throwing sink completes the handle). `complete` is idempotent behind an `AtomicBoolean`, cancels the timer, removes the entry, and runs `sdkCompletion` inside `try/catch (Throwable)`. Every outcome logs one line at tag `BugseeRN`: `report handler <id> phase=<p> deadline=<ms>` on dispatch; `report handler <id> completed by=<js|deadline|terminating|no-handler|detach>` on completion — the device tests match these.

**Module:** reads `optionSeconds` for `liveMs` from `Bugsee.getLaunchOptions()` key `com.bugsee.option.config.report-handler-callback-timeout` (wrapped; any failure → `null`). Converts `ReadableMap` patch → `Map` (integral numbers within ±2^53 → `Long`, others → `Double`; booleans; strings; null). `reportAddDataAttachment` decodes with `android.util.Base64.decode(s, Base64.NO_WRAP)`; `IllegalArgumentException` → `E_REPORT_BAD_ARGUMENT`. Unknown handle → `E_REPORT_HANDLE_DEAD`. Ops run on the calling (native-modules) thread; the SDK documents `Report` as usable from any thread and its collections are synchronized. Severity is written with an explicit 1–5 check then `IssueSeverity.fromIntValue(n)` — **never the one-argument form on unchecked input**, which silently maps garbage to `VeryLow`. The module attaches itself as the sink in its constructor and detaches in `invalidate()`, exactly like `WrapperEventBus`.

- [x] **Red** — `ReportHandlerBridgeTest`: `terminatingCompletesSynchronouslyAndNeverReachesJs`; `noSinkCompletesImmediately`; `unregisteredPhaseCompletesImmediately`; `tooShortADeadlineCompletesWithoutEmitting`; `eachDeliveryGetsAFreshHandle` (two AFTER dispatches of one report); `completeRunsTheSdkCompletionExactlyOnce`; `deadlineCompletesAndKillsTheHandle` (manual scheduler); `completingBeforeTheDeadlineCancelsTheTimer`; `aThrowingSinkStillCompletes`; `aThrowingSdkCompletionDoesNotEscape`; `detachCompletesEverythingOutstandingAndClearsPhases`; `detachingAStaleSinkLeavesTheCurrentOne`. `ReportHandlerDeadlinesTest`: `liveIs25sUnderTheDefault30sCap`; `liveTracksALowerOption` (10 → 9000); `zeroOptionMeans25s`; `oneSecondOptionFallsBelowTheUsefulMinimum`; `recoveryIs2500`; `onlyTheSdkHandlerThreadIsLive` (`"BugseeReportHandlerThread"` → live; `"main"`, `"BugseeRN-x"` → 2500); `handlerThreadNameMatchesTheJavadoc`. `ReportOpsTest`: `readsSeverityByValueNotOrdinal` (`Critical` → 4); `appliesSeverityOneToFive`; `rejectsSeverityZeroAndSixAndLeavesTheReportAlone`; `patchIsAllOrNothing`; `labelsReplaceThroughSetLabels` (recorded calls: `setLabels` only, never `clearLabels` + `addLabels`); `nullAttributeRemoves`; `clearAttributesRunsBeforeAttributes`; `unknownPatchKeyIsRejected`; `typeCrossesAsItsString` (`IssueType.Crash` → `"crash"`); `screenshotIdsAreSortedAscending` (`[2,0,1]` → `[0,1,2]`); `aNullFromTheSdkIsARejectedAttachment`; `fileAttachmentPassesMoveThrough` (temp file). Run `./gradlew :bugsee-android-bridge:testDebugUnitTest` → FAIL.
- [x] **Green** — the three classes; the wrapper's two callbacks become `ReportHandlerBridge.shared().dispatch(Phase.X, report, isTerminating, completionCallback)`; the module replaces its stubs and emits `onReportHandlerRequest`.
- [x] **Mutate** — (1) delete the `isTerminating` early return: `terminatingCompletesSynchronouslyAndNeverReachesJs` must fail. (2) drop the `AtomicBoolean`: `completeRunsTheSdkCompletionExactlyOnce` must fail. (3) read severity with `ordinal()`: `readsSeverityByValueNotOrdinal` must fail. (4) make `forThread` return live for every thread: `onlyTheSdkHandlerThreadIsLive` must fail. Revert each; record.
- [x] **Commit** — `feat(android): route report handlers to JS through a handle registry`.

**Acceptance:** the SDK completion runs exactly once on every path, including JS reload; no deadline can exceed the SDK's cap for the path; all JVM tests green; the example builds.

---

### Task 3.4c — Live-report trigger: `upload(summary, description)`, pulled forward from Phase 8

**Files:** `src/NativeBugsee.ts`, `src/index.ts`, `src/__tests__/upload.test.ts`, `android/.../BugseeModule.java`, `ios/BugseeModule.mm` (stub)

**Interfaces:** spec `upload(summary: string, description: string): void`; facade `upload(summary: string, description: string): void` — both must be strings (`TypeError` otherwise, before crossing). Android: `Bugsee.upload(summary, description)`. iOS: a no-op stub commented `Task 3.4e`. The two-argument form only; severity and labels are Phase 8.

- [x] **Red** — `upload forwards summary and description`; `upload rejects a non-string summary or description before crossing`. → FAIL.
- [x] **Green** — as above. Phase 8's paragraph gains one line: "`upload(summary, description)` exists since Task 3.4c; add the severity/labels forms."
- [x] **Mutate** — forward `summary` twice: the first test must fail.
- [x] **Commit** — `feat(report): upload(summary, description), the live trigger the handler tests need`.

---

### Task 3.5a — Wrapper channel: Android seam and the internal JS log route

Implements the §10.3 decision as amended in `9ec0a37`: every line a wrapper injects is filtered **natively**, once; the RN wrapper never runs the customer's log filter in JS. The channel's `log` has no filtering flag, so there is nothing to pass. This task proves the seam only; Phase 4 builds `log()` on it and Phase 9 routes `console.*`. Nothing is buffered: before launch the channel is inert and drops lines (spec), so the §10.3 "flush after `setWrapper` returns" constraint does not arise until Phase 9 buffers.

**Files:**
- Create: `android/.../WrapperChannelHolder.java`, `android/.../WrapperRegistrar.java`
- Modify: `BugseeReactNativeWrapper.java` (`onWrapperChannelAvailable`), `ReactNativeWrapperInitProvider.java` and `BugseeModule.setWrapperInfo` (both through `WrapperRegistrar`), `BugseeModule.java` (`wrapperLog`)
- Modify: `src/NativeBugsee.ts`; `ios/BugseeModule.mm` (no-op stub commented `Task 3.5c`)
- Create: `src/wrapper/channel.ts`, `src/wrapper/__tests__/channel.test.ts`
- Create tests: `WrapperChannelHolderTest.java`, `WrapperRegistrarTest.java`, `scripts/__tests__/wrapper-registration-serialised.test.ts`

**Interfaces:**

```java
final class WrapperChannelHolder {           // process-wide; outlives every wrapper instance
    static WrapperChannelHolder shared();
    void set(@NonNull BugseeWrapperChannel channel);   // AtomicReference.set, nothing else
    void clear();
    void log(@Nullable String message, int level);     // channel.log(null, message, level(level), LogSource.Custom)
    void addNetworkEvent(@Nullable NetworkEvent e);     // channel.addNetworkEvent(e, true) -- ALWAYS true
}
final class WrapperRegistrar {
    interface Setter { void set(@Nullable BugseeWrapper wrapper); }         // own interface (no java.util.function below API 24); prod = Bugsee::setWrapper
    static void register(@Nullable BugseeWrapper wrapper);  // synchronized on one static lock; Bugsee.setWrapper(w); clear() after a null
    static void registerWith(Setter setter, @Nullable BugseeWrapper wrapper); // package-private, for tests
}
// BugseeReactNativeWrapper
@Override public void onWrapperChannelAvailable(@NonNull BugseeWrapperChannel channel) {
    WrapperChannelHolder.shared().set(channel);   // FIRST statement, and the only one
}
```

```ts
// NativeBugsee.ts
wrapperLog(message: string, level: number): void;
// src/wrapper/channel.ts -- internal: NOT exported from src/index.ts
export function forwardLog(message: string, level: LogLevel = LogLevel.Info): void;
```

**Level mapping — by value, identical on both platforms:**

| JS `LogLevel` | wire | Android `LogLevel` (`fromRawValue`) | iOS `BugseeLogLevel` |
|---|---|---|---|
| `Error` | 1 | `Error` (value 1, **ordinal 0**) | `BugseeLogLevelError` (1) |
| `Warning` | 2 | `Warning` | `BugseeLogLevelWarning` (2) |
| `Info` | 3 | `Info` | `BugseeLogLevelInfo` (3) |
| `Debug` | 4 | `Debug` | `BugseeLogLevelDebug` (4) |
| `Verbose` | 5 | `Verbose` | `BugseeLogLevelVerbose` (5) |

JS rejects anything else with `RangeError` before crossing. Native defends: outside 1–5 → `Info` (Android `LogLevel.fromRawValue((byte) n, LogLevel.Info)`; iOS `BugseeLogLevelInfo`). `BugseeLogLevelInvalid` (0) is never sent. `tag` is always `null`: iOS drops it, so passing one would make the platforms disagree. Source is always `Custom` (98), resolved by the bridge — never left missing, which iOS would read as `Unknown`.

**Guarding the call site** (wrapper-channel spec: the app's filter runs on the calling thread and on Android its exception propagates): `log` catches `Throwable`, logs it once per process at `BugseeRN` (`AtomicBoolean`), and does not rethrow into React Native. **Registration** is serialised by `WrapperRegistrar`'s lock (spec: "register from one thread"); the callback only stores, so it cannot deadlock under the SDK's registration lock.

- [x] **Red** — `WrapperChannelHolderTest` (a recording fake `BugseeWrapperChannel`): `logsWithSourceCustomAndNoTag`; `mapsLevelsByValue` (1→`Error` … 5→`Verbose`); `outOfRangeLevelBecomesInfo` (0, 6, −1); `noChannelIsANoOp`; `aThrowingFilterDoesNotEscapeAndIsReportedOnce`; `networkEventsAlwaysRequireFiltering` (a `NetworkEvent` from `java.lang.reflect.Proxy`); `clearRetiresTheChannel`; `theWrapperStoresTheChannelItIsHanded`. `WrapperRegistrarTest` (injected setter): `registrationsNeverOverlap` (two threads; the fake setter fails on re-entry); `unregisteringClearsTheChannel`. `wrapper-registration-serialised.test.ts`: `no source outside WrapperRegistrar calls Bugsee.setWrapper`. `channel.test.ts`: `forwards message and level`; `defaults to Info (3)`; `rejects 0, 6 and 2.5 before crossing`; `rejects a non-string message`; `is not exported from the public entry point`. → FAIL.
- [x] **Green** — as specified. Phase 4's paragraph gains one line: "`log()` builds on `forwardLog` / `wrapperLog` (Task 3.5a); do not add a second native route."
- [x] **Mutate** — (1) pass `LogSource.Bugsee`: `logsWithSourceCustomAndNoTag` must fail. (2) pass `requiresFiltering = false`: `networkEventsAlwaysRequireFiltering` must fail. (3) map with `LogLevel.values()[n]`: `mapsLevelsByValue` must fail. (4) remove the store from `onWrapperChannelAvailable`: `theWrapperStoresTheChannelItIsHanded` must fail.
- [x] **Commit** — `feat(android): hold the wrapper channel and forward a JS log line through it`.

**Acceptance:** the channel is stored outside the wrapper, first; a JS line reaches `channel.log` as `Custom` with the level by value; network events cannot be sent unfiltered through our code; registrations are serialised.

---

### Task 3.4d — Device verification, Android: report handler

Workbook Part 9 throughout: assert the experiment, not only the result.

**Files:**
- Create: `examples/bare/e2e/bundles.ts` (Android half), `examples/bare/e2e/scenario.ts`, `examples/bare/e2e/report-handler.test.ts`, `examples/bare/scenarios/report-handler.ts`
- Modify: `examples/bare/App.tsx` (dispatch on the scenario), `examples/bare/scripts/write-credentials.mjs` (write a default `e2e-scenario.json` = `{"scenario":"launch"}` when absent), `examples/bare/.gitignore` (`e2e-scenario.json`)

**Mechanism.** The harness writes `examples/bare/e2e-scenario.json` = `{ "scenario": "<name>", "nonce": "<random hex>" }` before starting the app; Metro serves it with the bundle, so no native code is needed to choose a scenario. Every marker and every value the app writes carries the nonce, so a bundle from an earlier run cannot pass.

**Helpers (`bundles.ts`):** `clearAndroidBundles()` = `adb shell run-as com.bareexample rm -rf files/bugsee_data/bundles`, then assert the directory is absent (9.1.3). `pullAndroidBundles()` = list `files/bugsee_data/bundles/*.bundle.zip` via `run-as`, `adb exec-out run-as com.bareexample cat <f>` into a temp dir, `unzip`, parse `request.json`, `manifest.json` and the `type: "log"` file named in the manifest. `airplane(on)` = `adb shell cmd connectivity airplane-mode enable|disable`; `afterAll` always disables it.

**Per-run preconditions (asserted, not assumed):** the `SDK build` banner step from 3.P1 passes; `clearAndroidBundles()` succeeded; airplane mode is on **before** the app starts (9.3.2); the app reaches `Status.Launched` offline (9.1.2). If it does not reach `Launched` offline, stop and report — do not fall back to a dead endpoint, which perturbs timing.

**Scenarios and assertions (`report-handler.test.ts`, `E2E_PLATFORM=android`):**
1. `live: the handler's edits reach the retained bundle` — scenario `rh-live`: `onBeforeReportCreated` sets summary `e2e-<nonce>`, description `d-<nonce>`, severity `IssueSeverity.Critical`, labels `['e2e', '<nonce>']`, attribute `nonce=<nonce>`, and `addDataAttachment(base64("hello <nonce>"), { name: 'e2e-<nonce>.txt', mimeType: 'text/plain' })`; `onAfterReportCreated` logs `BUGSEE_E2E rh after type=<t> severity=<n> labels=<json> ids=<json>`; the app then calls `Bugsee.upload('upload-<nonce>', '')`. Assert markers `BUGSEE_E2E rh before type=bug` and `rh after … severity=4`; logcat `BugseeRN … deadline=25000` (live path detected); the pulled `request.json` has `summary = e2e-<nonce>`, `severity = 4`, `labels ⊇ [<nonce>]`; `manifest.json` `attrs.nonce = <nonce>` and **exactly one** `attachment` file named `e2e-<nonce>.txt` (at-least-once `onAfter` must not duplicate it — the handler adds it only in `onBefore`).
2. `live: a dead handle rejects with E_REPORT_HANDLE_DEAD` — same run: the app keeps the `onBefore` proxy and, after the handler settles, calls `setSummary('late')`; marker `BUGSEE_E2E rh dead-handle code=E_REPORT_HANDLE_DEAD`; the bundle's summary is still `e2e-<nonce>`.
3. `live: a refused attachment surfaces E_REPORT_ATTACHMENT_REJECTED` — same run: `addFileAttachment('/nonexistent/<nonce>', { name: 'x' })`; marker with that code; no attachment named `x` in the manifest.
4. `timeout: a handler that never settles is completed at the deadline and the report still ships` — scenario `rh-hang`: `onBefore` awaits a promise that never settles. Assert `BugseeRN … completed by=deadline` between 25 s and 30 s after the dispatch line, and a bundle with summary `upload-<nonce>`.
5. `throw: a throwing handler still ships the report` — scenario `rh-throw`: `onBefore` throws. Assert `completed by=js` within 5 s and a bundle.
6. `terminating: an uncaught Java exception never reaches JS; onAfter does, next launch` — scenario `rh-crash` calls `testNativeCrash()` (Android `testCrash` throws `RuntimeException("Test crash")`). Assert the process actually died of it (9.1.4: logcat `FATAL EXCEPTION` + `java.lang.RuntimeException: Test crash`); if a debug build's red box swallows it instead, rerun this case on a release build and say so in the commit. Assert `BugseeRN … completed by=terminating` and **no** `BUGSEE_E2E rh before` in that run. Relaunch (airplane mode still on) with scenario `rh-observe` (handler registered before `launch()`): marker `BUGSEE_E2E rh after type=crash`, and the crash bundle carries the labels `onAfter` set.

**Not covered here, stated rather than implied:** a *successful* file-path attachment on device (JS cannot create a file without a dependency; covered by `ReportOpsTest.fileAttachmentPassesMoveThrough`), and Android early-crash recovery (not stageable by hand; covered by `ReportHandlerDeadlinesTest`).

- [x] **Red** — write the test and scenarios; run once before the app changes → FAIL at the first marker.
- [x] **Green** — wire `App.tsx` and the scenarios; all six pass on the WOD_LX1.
- [x] **Mutate** — temporarily set `LIVE_DEADLINE_MS` to 40 000: case 4 must fail (no `completed by=deadline` inside 30 s; the SDK's own 30 s cap fires first). Revert. *Done: as written it survived -- the bridge clamps the live deadline to the SDK option minus 1 s (29 s at the default 30), inside the window. Case 4 now also asserts `deadline=25000` and completion under 26 s, which kills it.*
- [x] **Commit** — `test(e2e): report handler on Android hardware`. Body: the banner line, observed dispatch-to-completion timings for cases 1, 4 and 5, and the build type used for case 6.

---

### Task 3.5b — Device verification, Android: wrapper channel

**Files:** `examples/bare/e2e/wrapper-channel.test.ts`, `examples/bare/scenarios/channel.ts`; reuses `bundles.ts` and `scenario.ts` from 3.4d.

Scenario `channel`: **before** `launch()`, `forwardLog('pre-<nonce>', LogLevel.Warning)`; after `Launched`, `forwardLog('BUGSEE_E2E channel <nonce>', LogLevel.Warning)`, then `Bugsee.upload('channel-<nonce>', '')`. The example deep-imports `@bugsee/react-native/src/wrapper/channel`; the function stays off the public surface.

- [x] **Red/Green** — `a channel line lands in the bundle as Custom`: the pulled log file has exactly one event whose `message` contains `channel <nonce>`, with `source = 98`, `level = 2`, and **no** `tag` key. `a line sent before launch is dropped`: no event contains `pre-<nonce>` (the channel is inert before launch). Preconditions exactly as 3.4d.
- [x] **Mutate** — temporarily pass `LogSource.StdOut` in `WrapperChannelHolder.log`: the first case must fail on `source`. Revert.
- [x] **Commit** — `test(e2e): a JS line reaches the Android bundle through the wrapper channel`.

**Not covered:** that the app's log filter runs on these lines — no filter API exists until Phase 9, whose device test must assert it.

---

### Task 3.P2 — iOS pin: `7.0.0-beta3`

**Files:** `native-versions.json`, `packages/react-native/ios/Support/Package.swift`, `packages/react-native/ios/Support/Package.resolved`, `scripts/__tests__/native-versions.test.ts`, `packages/react-native/BugseeReactNative.podspec`, `packages/react-native/ios/Podfile.lock`

- [x] **Step 1 — availability, first, and recorded in the commit:**

  ```sh
  gh api repos/bugsee/spm/tags --jq '.[].name' | grep -qx '7.0.0-beta3' && echo TAG-OK
  curl -sfI https://download.bugsee.com/sdk/ios/spm/Bugsee-7.0.0-beta3.zip | head -1   # need HTTP 200 (403 on 2026-09-28)
  ```

- [x] **Published path (both checks pass)** — `ios.sdk` → `7.0.0-beta3`; `exact: "7.0.0-beta3"` in `ios/Support/Package.swift`; regenerate `Package.resolved` with `xcodebuild -resolvePackageDependencies` in `ios/Support`; `pod install` in the example (the podspec's version stamp forces a fresh download). Fix beta2 → beta3 compile breaks in this commit only if mechanical (known: `+log:level:enforceFiltering:` became `+log:level:requiresFiltering:`; this repo does not call it). `yarn test`, the `ios-unit` scheme and both example delivery builds green.
- [x] **Fallback path (either check fails)** — build locally, in a separate clone (never `~/Projects/Bugsee/ios/sdk`):

  ```sh
  CLONE="$HOME/Projects/Bugsee/_clones/bugsee-cocoa-beta3"
  [ -d "$CLONE" ] || git clone https://github.com/bugsee/bugsee-cocoa.git "$CLONE"
  cd "$CLONE" && git fetch origin && git checkout --detach 74af69ee8
  git submodule update --init --recursive
  test "$(cat version.txt)" = 7.0.0-beta3
  # Mirror the env of the `Build` step in .github/workflows/deploy-beta.yml at this commit; it needs the
  # tvOS, visionOS and Mac Catalyst SDKs installed.
  /bin/sh -xe ./scripts/build.sh
  ls -l build/bugsee-spm-xcframework.zip && shasum -a 256 build/bugsee-spm-xcframework.zip
  ```

  Then commit the pin anyway: `ios.sdk` → `7.0.0-beta3`, `exact: "7.0.0-beta3"`, and in `Package.resolved` set the `spm` pin to `"version": "7.0.0-beta3"`, `"revision": "0000000000000000000000000000000000000000"`. The zero revision is deliberate: SwiftPM fails loudly on it instead of resolving something else, and `releaseBlockers` (3.P1) refuses it. **Expected red until beta3 publishes:** CI `ios-unit`, `ios (spm)`, `ios (cocoapods)` and `ios-e2e` (all resolve or download beta3). Do not merge the Phase 3 PR while they are red; when beta3 publishes, rerun the published path's steps and replace the placeholder.

  For running the `BugseeRNSupport` XCTests locally in fallback, a **local, uncommitted** SwiftPM mirror is allowed: a git repo whose `Package.swift` declares product `Bugsee` as `.binaryTarget(name: "Bugsee", path: "Bugsee.xcframework")`, tagged `7.0.0-beta3`, wired with `swift package config set-mirror --original https://github.com/bugsee/spm --mirror <that repo>` inside `ios/Support` (writes under the gitignored `.swiftpm/`). If `xcodebuild` ignores the mirror, the Support tests of 3.4e/3.5c run when beta3 publishes, and those tasks stay open until they have.

**As run: the fallback was used, then removed once beta3 published, the same day.** This task first landed the fallback (commit `01f3f22`), including a CocoaPods-only `BUGSEE_IOS_XCFRAMEWORK_ZIP` env override read by the podspec's `prepare_command`, so a local build could be consumed without a published zip. Beta3 published a few hours later, and the override was deleted in the same task (`b873020`) rather than kept for the next unpublished prerelease: review found it could not guarantee a local build never lingers, because CocoaPods decides whether to rerun `prepare_command` from the checksum of the raw podspec file, and an environment variable does not change that checksum. `podspec-override.test.ts`, written to pin the override's behaviour, was deleted with it. If a future prerelease needs the fallback again, it needs a mechanism CocoaPods will actually notice — not this one.

- [x] **Red** — `native-versions.test.ts` expects `7.0.0-beta3`. → FAIL.
- [x] **Green** — fallback landed first (`01f3f22`); superseded by the published pin (`b873020`) once beta3 published.
- [x] **Mutate** — see `01f3f22`'s and `b873020`'s commit messages for the round each ran against its own guard.
- [x] **Commit** — `build(ios): pin 7.0.0-beta3 from a local build until it publishes` (`01f3f22`), then `build(ios): pin the published 7.0.0-beta3, and drop the local-zip override` (`b873020`). Bodies: the availability output, the local build's SHA-256 and `74af69ee8`, then the published tag's SHA-256 and build stamp `0d9c9d0a-9`.

---

### Task 3.7 — Delete the `bugsee-cocoa#99` / `#100` workarounds

Both issues are closed as completed and both fixes are in beta2 and beta3 (see *Verified facts*). `git grep bugsee-cocoa#` finds every site.

**Files:** `ios/BugseeModule.mm` (`relaunch:`, `getLaunchOptions:`), `src/NativeBugsee.ts`, `src/index.ts`, `src/options/BugseeLaunchOptions.ts` (comments), `examples/bare/e2e/launch.test.ts` (the step comment citing the 30 s bridge timeout), plan Phase 2's "Waiting on SDK fixes" block (rewrite to "resolved in 7.0.0-beta2; removed in Task 3.7").

- [x] **Red** — the example additionally logs `BUGSEE_E2E effective wifi-only-upload=<value>` for `com.bugsee.option.config.wifi-only-upload`, a key it never sets (confirm `BugseeLaunchOptions.serialize` of its options lacks it); `launch.test.ts` asserts the value is a boolean on both platforms, i.e. iOS now answers for an unset option. Run before deleting anything: it passes already, because the fix is in the SDK — that is the evidence the caveat is obsolete; record it.
- [x] **Green** — `relaunch:` resolves straight from `started:` (keep the main-queue hop for `resolve`; delete `settled`, `settleOnce`, the `dispatch_after` and `E_RELAUNCH_NO_REPORT`); delete the #100 caveats and the `NOTE` in `getLaunchOptions:`. `git grep 'bugsee-cocoa#99\|bugsee-cocoa#100'` returns nothing.
- [x] **Mutate** — none possible on deleted code; instead run the launch e2e again and confirm `relaunch() settled resolved=true` arrives in under 5 s. Record the timing.
- [x] **Commit** — `fix(ios): drop the #99 and #100 workarounds, fixed in the SDK since 7.0.0-beta2`.

**As run: no iPhone XS attached, so both the Red and Mutate steps ran on the iOS Simulator (iPhone 17 Pro, iOS 26.5), per the controller's ruling that the iOS device steps of 3.7, 3.4f and 3.5d run there.** `relaunch()` settled `resolved=true` in 15ms before deletion and 17-19ms after — both far under 5s, and `wifi-only-upload` (a key the app never sets) came back as the boolean `false`, confirming iOS now answers for an unset option. A hardware pass on a physical iPhone remains required before merge (§12 of the design doc); it has not run for this task.

---

### Task 3.4e — Report handler: iOS bridge (and iOS `upload`)

**Files:**
- Create in `ios/Support/Sources/BugseeRNSupport/` (+ `include/`): `BGSRNReportHandlerBridge.{h,m}`, `BGSRNReportOps.{h,m}`, `BGSRNReportDeadlines.{h,m}`
- Create in `ios/Support/Tests/BugseeRNSupportTests/`: `BGSRNReportHandlerBridgeTests.m`, `BGSRNReportOpsTests.m`, `BGSRNReportDeadlinesTests.m`, `BGSRNFakeReport.{h,m}` (an `NSObject <BGSReportContract>` holding state and recording calls)
- Modify: `ios/BugseeModule.mm` (the category's two report callbacks; replace the six 3.4a stubs and the 3.4c `upload` stub; both `#if __has_include` import branches — `ios-delivery-parity.test.ts` enforces it)

**Interfaces (mirror 3.4b):**

```objc
typedef NS_ENUM(NSInteger, BGSRNReportPhase) { BGSRNReportPhaseBefore, BGSRNReportPhaseAfter };
@interface BGSRNReportHandlerBridge : NSObject
@property (class, readonly) BGSRNReportHandlerBridge *shared;
- (instancetype)initWithScheduler:(id (^)(dispatch_block_t task, int64_t delayMs))schedule
                           cancel:(void (^)(id token))cancel;                 // tests inject; prod uses a private serial queue
- (void)setPhasesBefore:(BOOL)before after:(BOOL)after;
- (void)attach:(id)sink block:(void (^)(NSDictionary *request))block;       // request = the event payload
- (void)detach:(id)sink;                                                    // completes all outstanding, resets phases
- (void)dispatchPhase:(BGSRNReportPhase)phase report:(id<BGSReportContract>)report
        isTerminating:(BOOL)isTerminating onMainThread:(BOOL)onMain completion:(BGSCallback)completion;
- (BOOL)complete:(NSString *)handleId;
- (nullable id<BGSReportContract>)reportFor:(NSString *)handleId;
@end
FOUNDATION_EXPORT const int64_t BGSRNLiveDeadlineMs;      // 25000
FOUNDATION_EXPORT const int64_t BGSRNRecoveryDeadlineMs;  // 2500
int64_t BGSRNDeadlineMs(BOOL onMainThread);              // main -> live; off main -> recovery
```

`onMainThread` is passed in (the category passes `NSThread.isMainThread`) so the rule is testable. `BGSRNReportOps`: `+readReport:` (severity as `NSInteger` 0–5 — `0` passes through, JS maps it to `undefined`; `screenshotDisplayIds` sorted ascending; `attachments[].name`), `+applyPatch:toReport:error:` (validate all then apply; severity 1–5 only, set via the typed property; labels via `replaceLabels:`; `NSNull` removes an attribute; `clearAttributes` first), `+addFileAtPath:name:mimeType:move:toReport:` (`addAttachmentWithFilePath:name:mimeType:move:`), `+addData:name:mimeType:toReport:` (`addAttachmentWithData:name:mimeType:`; base64 decoded with `initWithBase64EncodedString:options:0`, `nil` → `E_REPORT_BAD_ARGUMENT`). `type` crosses as the report's `type` string. Registry state behind `os_unfair_lock`; the SDK completion always runs **outside** the lock.

**Thread rule, load-bearing:** report ops and `completeReportHandler` must **not** hop to the main queue. On the live path the SDK calls the handler on main and waits (bounded) for the completion; an op that needs main while main is the thread being waited on stalls until our deadline. `BGSReportContract` methods are lock-synchronized per `BGSContracts.h`, so the module's method queue is safe. Only `upload` hops to main (`[Bugsee uploadWithSummary:description:]`), like every other SDK entry point.

Log lines via `NSLog` (reaches the `devicectl --console` stream): `BugseeRN report handler <id> phase=<p> deadline=<ms>` and `… completed by=<js|deadline|terminating|no-handler|detach>`.

- [x] **Red** — XCTests mirroring 3.4b by name: `testTerminatingCompletesSynchronouslyAndNeverReachesJs` (iOS never passes YES today; the contract still allows it); `testNoSinkCompletesImmediately`; `testUnregisteredPhaseCompletesImmediately`; `testEachDeliveryGetsAFreshHandle`; `testCompleteRunsTheSdkCompletionExactlyOnce`; `testDeadlineCompletesAndKillsTheHandle`; `testCompletingBeforeTheDeadlineCancelsTheTimer`; `testDetachCompletesEverythingOutstanding`; `testMainThreadIsLiveAndOffMainIsRecovery` (25000 / 2500); `testReadsUnsetSeverityAsZero`; `testReadsSeverityByValue` (`BugseeSeverityCritical` → 4); `testRejectsSeverityZeroAndSixAndLeavesTheReportAlone`; `testPatchIsAllOrNothing`; `testLabelsReplaceThroughReplaceLabels`; `testNSNullRemovesAnAttribute`; `testScreenshotIdsAreSortedAscending`; `testANilFromTheSdkIsARejectedAttachment`; `testInvalidBase64IsABadArgument`; `testFileAttachmentPassesMoveThrough` (temp file). → FAIL (`xcodebuild test -scheme BugseeRNSupport`, per the Support manifest's comment).
- [x] **Green** — the three classes; the category's `onBeforeReportCreated:…`/`onAfterReportCreated:…` call `dispatchPhase:…onMainThread:NSThread.isMainThread…`; the module attaches to the bridge in `init` and detaches in `invalidate`, exactly like `BGSRNEventBus`, replaces its stubs and emits `onReportHandlerRequest`; `upload` implemented.
- [x] **Mutate** — (1) drop the once-guard: `testCompleteRunsTheSdkCompletionExactlyOnce` must fail. (2) return live for both threads: `testMainThreadIsLiveAndOffMainIsRecovery` must fail. (3) apply labels with `clearLabels` + `addLabels:`: `testLabelsReplaceThroughReplaceLabels` must fail. Revert; record.
- [x] **Commit** — `feat(ios): route report handlers to JS through a handle registry`.

---

### Task 3.5c — Wrapper channel: iOS seam

**Files:** create `ios/Support/Sources/BugseeRNSupport/BGSRNWrapperChannelHolder.{h,m}` (+ `include/`), `ios/Support/Tests/BugseeRNSupportTests/BGSRNWrapperChannelHolderTests.m`; modify `ios/BugseeModule.mm`.

```objc
@interface BGSRNWrapperChannelHolder : NSObject
@property (class, readonly) BGSRNWrapperChannelHolder *shared;
@property (atomic, strong, nullable) id<BGSWrapperChannel> channel;   // outside the wrapper object
- (void)logMessage:(nullable NSString *)message level:(NSInteger)level; // tag nil, BGSLogEventSourceCustom, 1..5 else Info
- (void)addNetworkEvent:(nullable BugseeNetworkEvent *)event;           // requiresFiltering:YES, always
@end
```

The category adds `- (void)onWrapperChannelAvailable:(id<BGSWrapperChannel>)channel { BGSRNWrapperChannelHolder.shared.channel = channel; }` — first statement, and the only one. Every `+setWrapper:` in the module goes through one helper that runs on main (already the case in `setWrapperInfo:`) and sets `channel = nil` after registering `nil`. Each channel call checks `respondsToSelector:` first — every channel method is `@optional`. No `@try`: the SDK catches filter exceptions itself, and unwinding an ObjC exception through ARC frames leaks. `wrapperLog:level:` replaces its 3.5a stub. Level mapping: the table in 3.5a.

- [x] **Red** — `testLogsWithSourceCustomAndNilTag`; `testMapsLevelsByValue`; `testOutOfRangeLevelBecomesInfo` (0, 6); `testNetworkEventsAlwaysRequireFiltering`; `testNoChannelIsANoOp`; `testAChannelWithoutTheSelectorIsANoOp`; `testClearingRetiresTheChannel`. → FAIL.
- [x] **Green** — as specified.
- [x] **Mutate** — (1) `BGSLogEventSourceBugsee`: the source test must fail. (2) `requiresFiltering:NO`: the network test must fail. Revert.
- [x] **Commit** — `feat(ios): hold the wrapper channel and forward a JS log line through it`.

---

### Task 3.4f — Device verification, iOS: report handler

**Files:** extend `examples/bare/e2e/bundles.ts` (iOS half), `examples/bare/e2e/report-handler.test.ts` (`E2E_PLATFORM=ios`).

**Retaining a bundle on iOS.** Human step: the iPhone XS is **cabled** (devicectl must not depend on Wi-Fi), airplane mode on **and Wi-Fi off** (iOS keeps Wi-Fi on in airplane mode if it was re-enabled before), before the app starts. **Pulling it:** `xcrun devicectl device info files --device $IOS_DEVICE_ID --domain-type appDataContainer --domain-identifier org.reactjs.native.example.BareExample` to find `**/bundles/*.bundle.zip` (the SDK writes `<capture>/bundles/<requestId>.bundle.zip`), then `xcrun devicectl device copy from … --source <that path> --destination <tmp>`. Clearing: delete the app's bundles directory the same way, or reinstall, and assert none remain. **Which build:** iOS prints no commit banner, so assert `request.json` `environment.sdk` reports version `7.0.0-beta3`, and record `environment.sdk.build` if present; in fallback, also record the override zip's SHA-256 from the podspec stamp (`packages/react-native/.bugsee-xcframework-version`).

**As run (no iPhone attached; iOS 26.5 simulator, iPhone 17 Pro).** The simulator has no airplane mode, so each launch carries a closed loopback endpoint (`DEAD_ENDPOINT`, `https://127.0.0.1:9`, through `e2e-scenario.json`); the SDK logs `Session not initialized. - Could not connect to the server.`, which the test asserts. The data container is a host directory (`simctl get_app_container … data`, then `Library/Caches/com.bugsee.data/capture/bundles`), and the bundle zips store most entries with zstd (method 93), which `extractZip` in bundles.ts reads. The iOS SDK's version line (`Bugsee IOS SDK ver:7.0.0-beta3 build:0d9c9d0a-9`) stands in for a banner. The devicectl recipe above is not implemented: iOS mode is simulator-only until hardware is attached.

- [x] **Cases** — 1–5 done on the simulator; **case 6 blocked there**: the simulator slice of 7.0.0-beta3 has no crash reporter, so no crash is ever recovered (Task 3.4f report). It stays in the file behind `E2E_IOS_RECOVERY=1`. Original: 1–5 of 3.4d unchanged in intent, on iOS: live edits reach the bundle (`deadline=25000`, dispatched on main); dead handle; refused attachment; hang completed by deadline in 25–30 s; throw. Case 6 becomes `recovery: a crash recovered at the next launch reaches JS off main with deadline=2500` — scenario `rh-crash` calls `testNativeCrash()`; assert the process died (9.1.4: the console stream ends, and the relaunch dispatches a `type=crash` report); relaunch with `rh-observe` and assert `BugseeRN … deadline=2500` and the JS marker. iOS never passes `isTerminating = YES`; the terminating branch is covered by `testTerminatingCompletesSynchronouslyAndNeverReachesJs` only — state this in the commit.
- [x] **Mutate** — set `BGSRNLiveDeadlineMs` to 40000: the hang case must fail (SDK's 30 s fires first). Revert. *(Failed as required: `deadline=40000`, and the SDK moved on at +30.0 s, completing the after phase `no-handler` before our deadline could fire.)*
- [x] **Commit** — `test(e2e): report handler on iOS hardware`. Body: `environment.sdk`, timings, and whether the published or the fallback framework was used.

---

### Task 3.5d — Device verification, iOS: wrapper channel

Identical to 3.5b on the iPhone XS with 3.4f's retention and pull recipe: one log event containing `channel <nonce>` with `source = 98`, `level = 2`, no `tag`; nothing containing `pre-<nonce>`.

**As run (no iPhone attached; same target as 3.4f — iOS 26.5 simulator, iPhone 17 Pro).** Both cases passed, reusing 3.4f's `startIosRun`, retention and pull recipe rather than forking the test: the pulled log event was `{"level":2,"source":98,"message":"BUGSEE_E2E channel <nonce>"}`, byte-shape identical to Android's. A hardware pass on a physical iPhone is required before merge (§12 of the design doc) — this task alone does not satisfy it.

- [x] **Red/Green** — as above.
- [x] **Mutate** — temporarily passed `BGSLogEventSourceStdOut` in `BGSRNWrapperChannelHolder.m`; the source assertion failed as predicted (`Expected: 98, Received: 1`). Reverted, rebuilt, reinstalled, re-ran green twice.
- [x] **Commit** — `test(e2e): a JS line reaches the iOS bundle through the wrapper channel`.

---

### Task 3.6 — Docs catch-up (design doc and plan)

**Files:** `docs/design/2026-09-15-sdk-design.md`, `docs/design/plans/2026-09-16-implementation-plan.md`, create `scripts/__tests__/docs-versions.test.ts`.

**Edits (each exact):**
- Plan, Global Constraints: Android SDK **7.2.0** → **7.3.0** (with the reason: the wrapper channel, report-contract methods, handler thread and `$$WRAPPER` consumer are not in 7.2.0; a `7.3.0-SNAPSHOT` pin is transitional, see Phase 3 rulings); Gradle plugin **4.0.6** → **4.0.7** (4.0.6 strips every extension's provider, workbook 1.4); iOS **7.0.0-beta1** → **7.0.0-beta3**; add "iOS deployment target **15.0**".
- Design §2 Goals: the same versions.
- Design §6.1: replace "It supersedes the `$$WRAPPER` launch option, which **no longer exists** in `Options.java` at 7.2.0." with: `com.bugsee.option.$$WRAPPER` exists and is consumed by Android (`bugsee-android` #119, `EnvironmentInfoProvider.resolveWrapper`), which reads it only when no wrapper object is registered — the same rule iOS applies to `wrapper_info`. This wrapper always registers the object first (ContentProvider at `initOrder=200`; module init on iOS), so it does not also send `$$WRAPPER`. Add a table row: `onWrapperChannelAvailable(channel)` | the attributed route for logs, network events and breadcrumbs (Task 3.5).
- Design §6.4: `api("com.bugsee:bugsee-android:7.2.0")` → the version read from `native-versions.json`.
- Design §6.5: "The SDK binary supports 13.0" → the SDK's deployment target is 15.0 from beta3.
- Design §9.1 table: iOS unhandled `logUnhandledException:name:reason:completion:` → `logUnhandledException:reason:completion:` (`Bugsee.h:381` on `nextgen`: `+logUnhandledException:(NSString *)name reason:(NSString *)reason completion:`).
- Design §10.3: renumber the constraints 1, 2, 4, 3 → 1, 2, 3, 4.
- Design §14.6 (and §14.5's "Superseded in part" note): `bugsee-cocoa#91` / `bugsee-android#90` are **resolved via the wrapper channel** (`sdk/wrapper-channel`; Android #149, iOS #137–#140), which superseded the public source-aware overload; the wrapper records `LogSource.Custom` through the channel (Task 3.5). Note that `bugsee-cocoa#91` is still open on GitHub and should be closed as superseded; `bugsee-android#90` is closed.
- Design Appendix A: a dated note at its top: superseded for versions by the 2026-09-28 facts in Phase 3 of the plan.
- Plan, "Cross-repo dependencies": replace the #91/#90 bullet with the same resolution; add `bugsee-android#178` (display-id order; the bridge sorts until it lands).
- Plan, Phase 12: feedback-spm pins in lockstep with the core pin (`7.0.0-beta3`), not `beta1`.
- `bugsee-cocoa#99`/`#100` notes: already handled by Task 3.7 (fixed; verified closed and in beta2). No other workaround notes remain — confirm with `git grep bugsee-cocoa#`.

- [x] **Red** — `docs-versions.test.ts`: `the plan's Global Constraints name the pinned Android, plugin and iOS versions` and `the design's Goals name the same`, comparing against `native-versions.json` with a `-SNAPSHOT` suffix stripped. → FAIL on the current docs.
- [x] **Green** — the edits above.
- [x] **Mutate** — change `ios.sdk` in a copy passed to the checker: the test must fail. (Test the checker function, not only the live files.)
- [x] **Commit** — `docs: catch the design and plan up with 7.3.0, beta3 and the wrapper channel`.

---

### Task 3.P3 — Flip Android to `7.3.0`

Runs as soon as 7.3.0 is on Maven Central — before the review gate if possible.

- [ ] **Precondition** — `curl -sfI https://repo1.maven.org/maven2/com/bugsee/bugsee-android/7.3.0/bugsee-android-7.3.0.pom` and the same for `bugsee-android-ndk` both answer 200.
- [ ] **Change** — `native-versions.json`: `"sdk": "7.3.0"` and delete `snapshotCommit`; delete the two guarded `mavenLocal` blocks (root `settings.gradle`, `examples/bare/android/build.gradle`); update `native-versions.test.ts`; regenerate `packages/react-native/src/options/android-options-manifest.json` against the 7.3.0 sources (`node scripts/cli-extract-option-keys.ts <iosRoot> <androidRoot at v7.3.0>`), because `option-manifest-parity.test.ts` requires `manifest.sdkVersion === android.sdk` and fails the moment the pin flips (final-review fix A3). The CLI also rewrites `option-keys.json`: restore that file here and leave it to 3.P4. Nothing else.
- [ ] **Verify** — `yarn test` (the maven-local test branches on the pin: for a released pin it asserts no `mavenLocal` in any tracked Gradle file; `option-manifest-parity.test.ts` asserts the regenerated manifest's `sdkVersion` is `7.3.0`); `BUGSEE_RELEASE=1 yarn test` passes for Android (iOS may still block if 3.P2 is on its placeholder); CI's android job green. Device: the harness's `SDK build` step shows `Bugsee Android SDK 7.3.0 [<sha>]`; compare `<sha>` with `git -C "$CLONE" rev-parse --short v7.3.0` after fetching tags. If the release commit differs from `snapshotCommit`, rerun 3.4d and 3.5b before closing this task.
- [ ] **Mutate** — re-add an unconditional `mavenLocal()` to the example: the maven-local test must fail. Revert.
- [ ] **Commit** — `build(android): pin the released 7.3.0`. Body: the banner line and both SHAs.

---

### Task 3.P4 — Regenerate `option-keys.json` against `7.3.0`

Added by controller ruling. Pending — runs after 3.P3, against the flipped, released Android pin, not against the SNAPSHOT.

**Why:** `option-keys.json` (`scripts/cli-extract-option-keys.ts`) is a committed fixture generated from the Android and iOS SDK sources. It was last regenerated against Android 7.2.0. 7.3.0 is the release the wrapper channel, the report-contract methods and `com.bugsee.option.$$WRAPPER` shipped in (Phase 3's rulings); Android's option surface has moved since, and the fixture has not been asked to notice.

- [ ] Regenerate `option-keys.json` (and the `shared`/`android`-only/`iOS`-only split it derives) from the `7.3.0` Android sources and the pinned iOS `7.0.0-beta3` sources.
- [ ] Expose any option `7.3.0` added that Android carries and this wrapper does not yet surface as a first-class accessor — at minimum, confirm none of the new keys are silently dropped the way `19a034a` fixed for deprecated-but-registered options.
- [ ] `option-manifest-parity.test.ts` and `option-keys.test.ts` stay green against the regenerated fixture.
- [ ] **Commit** — `build(options): regenerate option-keys.json against 7.3.0`.

---

### Phase 3 review gate

Spawn a reviewer subagent. It must independently: run `yarn test`, `BUGSEE_RELEASE=1 yarn test` (and report every blocker it prints), the Android JVM tests and the `BugseeRNSupport` XCTests; confirm `mavenLocal` is either absent or SNAPSHOT-filtered; confirm by reading the code that the SDK completion runs exactly once on every path (terminating, no handler, phase unregistered, JS resolve, JS throw, deadline, JS reload) on both platforms, and that no deadline can exceed the SDK's cap; confirm no report op hops to the iOS main queue; confirm network events cannot leave our code with `requiresFiltering = false`; and **rerun** the device tests of 3.4d, 3.5b, 3.4f and 3.5d rather than trust reported output. The phase is not releasable while `releaseBlockers` is non-empty.

**A hardware pass is required before merge, not only this gate's simulator/emulator reruns.** 3.4f's recovery case (case 6, gated `E2E_IOS_RECOVERY=1`) and 3.5d both ran on the iOS Simulator, because the simulator slice of `7.0.0-beta3` has no crash reporter — no crash is ever recovered there, so recovery cannot be exercised without a physical iPhone. Android is already covered end to end on the WOD_LX1. Before merge: run 3.4f's case 6 and 3.5d on a physical iPhone, and implement the `devicectl` bundle-pull recipe for physical iPhones — today's `pullIosBundles`/`clearIosBundles` in `examples/bare/e2e/bundles.ts` only read the simulator's host-filesystem data container via `simctl`.

Address findings; re-review until satisfied.

---

### Task 3.Q — Clear the scripts mutation gate, and three small leftovers from the final review

Added by controller ruling after the Phase 3 final review; not part of the original task list above. See `task-3.Q-brief.md` and `task-3.Q-report.md`.

- [x] `yarn mutate:scripts` reaches its break threshold (85%): was 82.76% (already failing before the fix wave), now 91.57%. Fixed mostly by adding tests to `contract-members.ts` (47.31% → 93.83%, and deleted a dead annotation-stripping line the fix-round review found) and `option-keys.ts` (76.11% → 99.12%); the remaining survivors across all files are documented as equivalent, with reasoning, in the report.
- [x] D4 cleanup order: `examples/bare/e2e/report-handler.test.ts` and `wrapper-channel.test.ts` now run `airplane(false)` in its own nested `try`/`finally`, so bundle removal and `log.stop()` run even if it throws.
- [x] `scripts/__tests__/e2e-pulled-bundles.test.ts` no longer leaks a `bugsee-bundles-*` temp dir on every `yarn test`: the "keeps them" case now deletes the root it asked to keep, and every test asserts no such directory it created survives it.
- [x] `ReactRootOriginTracker` gained a `disposed` guard (refresh() no-ops once dispose() has run), resolves its root's location/viewport/display id as one atomic snapshot (aborting the refresh, rather than publishing a partial/made-up origin, if the weakly-held view is gone by the time it is resolved), and releases its layout listener via the root (which can fall back to the root's current registration if the one the listener was originally added through has been merged into the window's `ViewTreeObserver` and killed — the case where a listener is registered before the decor view is attached). New JVM tests (`ReactRootOriginTrackerTest`) drive all of this through a `LifecycleSource`/`RootFinder` seam, since the module has no Robolectric.

---

## Phases 4–6 — the mechanical middle

Each is small by design: they establish the bridging pattern that the harder phases reuse.

**Phase 4 — Logging, events, traces.** `log(text, level)`, `event(name, params)`, `trace(name, value)`. Tests: level mapping both directions; params survive the bridge. Device test asserting the lines appear in a report. `log()` builds on `forwardLog` / `wrapperLog` (Task 3.5a); do not add a second native route.

**Phase 5 — Attributes & identity.** `setAttribute`/`getAttribute`/`getAllAttributes`/`clearAttribute`/`clearAllAttributes`; `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier`. Tests include round-tripping non-string values, since Android takes `Serializable` and iOS takes `id`.

**Phase 6 — Privacy.** `startBlackout`/`endBlackout`/`isBlackout`; `<BugseeSecure>` wrapping children and disposing on unmount; secure rectangles; `captureViewHierarchy`. `<BugseeSecure>` replaces `toggleProtected` — declarative, and it cannot leak a registration. Device test: a blackout window really blanks the video.

Each phase ends in a review gate.

---

## Phase 7 — Exceptions

**Ships:** `logException`, `logUnhandledException`, `ErrorBoundary`, and the debug-ID payload.

- [ ] **7.1** Stack parsing and the payload, preserving the `ReactNativeWebException` name — the backend routes on that exact string and Android 7.x has no structured foreign-frame API to replace it.
- [ ] **7.2** Global handlers: `ErrorUtils.setGlobalHandler` and unhandled rejection tracking.
- [ ] **7.3** `debug_ids` read from `globalThis._bugseeDebugIds`. The worker accepts a crash-level list or a filename→id map plus per-frame ids; send the map.
- [ ] **7.4** `ErrorBoundary`.
- [ ] **7.5** Device test: throw in JS, confirm the report arrives with a JS stack.
- [ ] **7.6 (to-do)** Android's `testCrash()` (used by Phase 1's `testNativeCrash` and Task 3.4d's `rh-crash` scenario) throws a Java `RuntimeException`, not a native (NDK/signal) crash — it exercises the JVM uncaught-exception path, not the crashpad-backed native-crash path the NDK dependency (Task 3.P1) exists for. Task 3.4d worked around this from *outside* the app (`adb shell run-as … kill -11 <pid>`) to get Crashpad to exec at all, just to count its `.so`. Add a real, JS-triggerable native trigger — e.g. a small JNI call that segfaults or aborts on purpose — so the native-crash reporting path gets first-class device coverage instead of only a Java exception standing in for it and an external `kill -11` filling the gap.
- [ ] Review gate.

---

## Phase 8 — Reporting

`showReportDialog`, `upload`, `createReport`, attachments via the wrapper's `ReportHandler`. Note `upload` has no `includeVideo` overload in 7.x — the 6.x parameter is gone and must not be reintroduced. `upload(summary, description)` exists since Task 3.4c; add the severity/labels forms. Device test: trigger the dialog, submit, confirm the issue appears.

---

## Phase 9 — Capture & filters

The phase with the most native↔JS round-tripping, hence the most device testing.

- [ ] **9.1** Console capture with the JS patch.
- [ ] **9.2** Log filter — the native→JS round trip. **A filter callback that cannot complete must drop the line, not pass it through**; failing open at a redaction boundary leaks exactly what the callback existed to remove.
- [ ] **9.3** Network: keep the WebSocket patch; `patchXhr` stays disabled. **Do not assume native capture covers `fetch`/XHR on Android** (found 2026-09-29, from the Android SDK source):
  - RN's `NetworkingModule` runs on OkHttp, and Bugsee instruments OkHttp only when `bugsee-android-okhttp` is on the classpath.
  - This package declares only `bugsee-android` + `bugsee-android-ndk`.
  - The Bugsee Gradle plugin adds the okhttp artefact only when the app *directly* declares `com.squareup.okhttp3` (`BugseePlugin.hasOkHttpDependency`). When the artefact is present, it injects into every `OkHttpClient.Builder.build()`, including inside `react-android`.
  - A typical RN app gets OkHttp only transitively, so JS requests are likely **not** captured today.

  Decide between declaring `bugsee-android-okhttp` from this package (and verify the injection reaches RN's client) and a `NetworkingModule` interceptor. A device test must show a JS `fetch` in a retained bundle on both platforms. On iOS, confirm that NSURLSession capture covers RN's networking the same way.
- [ ] **9.4** Network filter, same round-trip shape.
- [ ] **9.5** `addBreadcrumb(crumb)` and `setBreadcrumbFilter(cb)`. Breadcrumbs are built through the SDK's exchange factory on both platforms, so the bridge constructs rather than forwards.
- [ ] **9.6** `addNetworkEvent` for stacks the SDK does not auto-instrument.
- [ ] **9.7** Dedup across the two console streams, *before* either filter runs — otherwise the user's callback runs twice on one line by two routes. Device test in **both** Debug and Release; RN only routes `console.*` through `RCTLog` under `__DEV__`, and Hermes release builds commonly strip console calls.
- [ ] Review gate.

---

## Phase 10 — Notify & APM

`notify(title, body, severity, fields, urgent)`; `startTransaction`, `startSpan`, `getActiveSpan`. Spans are objects with lifetime, so the bridge must not leak them — tests pin that a finished span is released. Device test: a notification arrives; a transaction appears in a report.

---

## Phase 11 — Appearance & data

`appearance` over two mapping tables — Android is keyed (`setColor(ReportAppearance.X, int)`), iOS is property-based on `BugseeTheme`. `deleteCollectedDataOnDevice(includingIntermediate)`. Feedback appearance is **not** here; it ships with the feedback package, since `FeedbackAppearance` lives in the feedback artifact on Android.

---

## Phase 12 — Feedback package

`@bugsee/react-native-feedback`: `showFeedbackUI`, `setGreeting`, `setListener`, feedback appearance. Android reaches it through `Bugsee.ext(Feedback.class)`; iOS through `BugseeFeedback.shared`, a separate SPM package (`bugsee/feedback-spm`, exact `7.0.0-beta3` — in lockstep with the core pin, not `beta1`) that itself pins the core exactly — so both move in lockstep. Needs no config plugin: autolinking picks up the Gradle dependency and its podspec carries its own vendoring.

---

## Phase 13 — Build tooling

- [ ] **13.1** Source maps: `bugsee-cli sourcemaps inject` then `debug-files upload --type sourcemaps`. Injection must happen on the **composed** Hermes map, after `compose-source-maps.js`, or the debug ID lands on a map nothing consults.
- [ ] **13.2** dSYM upload as an Xcode **scheme post-action** running `bugsee-cli xcode post-action`. A build phase also works but needs `BUGSEE_BUILD_INFO_ALL_ACTIONS=1`, and Xcode 15+ defaults `ENABLE_USER_SCRIPT_SANDBOXING` to `YES`, which blocks it.
- [ ] **13.3** Android mapping and NDK symbols — the Gradle plugin's job once applied. Write `android/bugsee.properties` with the **unprefixed** `app_token=` key (not `plugin.appToken`) at the *root* project, and default `plugin.ndk.enabled=true` for RN, since every RN app ships Hermes and `libreactnative.so` it did not write.
- [ ] **13.4** Expo config plugin, with a `prebuild --clean` test — the `.xcscheme` edit is the most fragile part and Expo has no helper for it.
- [ ] **13.5** End-to-end: a release build whose JS stack symbolicates in the dashboard. This is the only test that proves the whole chain.
- [ ] Review gate.

---

## Cross-repo dependencies

- **`@bugsee/cli`** — merged in `bugsee/bugsee-cli#21`; needs its trusted-publisher bootstrap before first publish. Blocks Phase 13.1.
- **Option manifests** — schema merged as `bugsee/specs#14`; neither SDK publishes one yet. Blocks Phase 2.7 only.
- **`bugsee/bugsee-cocoa#91` / `bugsee-android#90`** — **resolved**, via the wrapper channel rather than the public source-aware overload originally filed for it (`bugsee/specs` `sdk/wrapper-channel`; Android #149, iOS #137–#140). The wrapper records `LogSource.Custom` through `onWrapperChannelAvailable` (Task 3.5). `bugsee-android#90` is closed; `bugsee-cocoa#91` is still open on GitHub and should be closed as superseded.
- **`bugsee/bugsee-android#178`** — screenshot display ids are not returned in ascending order. Open; the bridge sorts them itself (`getScreenshotDisplayIds`, Task 3.4a) until it lands.

## Out of scope

tvOS, visionOS and Mac Catalyst. The xcframework ships those slices, but the manifest declares `.iOS` only and no example app covers them.
