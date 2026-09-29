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
| 6 | Privacy | Blackout, `<BugseeSecure>`, secure rects, `captureViewHierarchy`, the `vh` view tree (`Bugsee.wrap`) |
| 7 | Exceptions | `logException`, `logUnhandledException`, `ErrorBoundary`, debug IDs |
| 8 | Reporting | `showReportDialog`, `upload`, `createReport`, attachments |
| 9 | Capture & filters | console, network, breadcrumbs, and their filter callbacks |
| 10 | Notify & APM | `notify`, `startTransaction`, `startSpan`, `getActiveSpan` |
| 11 | Appearance & data | `appearance`, `deleteCollectedDataOnDevice` |
| 12 | Feedback package | `@bugsee/react-native-feedback` |
| 13 | Build tooling | Source maps, dSYM upload, Expo config plugin |

Phases 4 and 5 are deliberately small — they settle how values cross the bridge, the pattern 7–11 reuse, so the hard parts arrive after the pattern is proven. Phase 6 carries the first native→JS round trip on the capture path (the `vh` data request), so it is the largest of the three.

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

> **Superseded by Task 4.5 (JSON text).** The patch now crosses as `reportUpdate(handleId: string, patchJson: string)`: iOS's object-argument conversion dropped its `null` members.

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

**Module:** reads `optionSeconds` for `liveMs` from `Bugsee.getLaunchOptions()` key `com.bugsee.option.config.report-handler-callback-timeout` (wrapped; any failure → `null`). Converts `ReadableMap` patch → `Map` (integral numbers within ±2^53 → `Long`, others → `Double`; booleans; strings; null). *(Superseded by Task 4.5 (JSON text): the module takes `patchJson` and `ReportOps.applyJson` parses it with `BridgeJson`, whose integral literals are already `Integer`/`Long`; the converter and `wireNumber` are gone.)* `reportAddDataAttachment` decodes with `android.util.Base64.decode(s, Base64.NO_WRAP)`; `IllegalArgumentException` → `E_REPORT_BAD_ARGUMENT`. Unknown handle → `E_REPORT_HANDLE_DEAD`. Ops run on the calling (native-modules) thread; the SDK documents `Report` as usable from any thread and its collections are synchronized. Severity is written with an explicit 1–5 check then `IssueSeverity.fromIntValue(n)` — **never the one-argument form on unchecked input**, which silently maps garbage to `VeryLow`. The module attaches itself as the sink in its constructor and detaches in `invalidate()`, exactly like `WrapperEventBus`.

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

- [x] **Precondition** — `curl -sfI https://repo1.maven.org/maven2/com/bugsee/bugsee-android/7.3.0/bugsee-android-7.3.0.pom` and the same for `bugsee-android-ndk` both answer 200.
- [x] **Change** — `native-versions.json`: `"sdk": "7.3.0"` and delete `snapshotCommit`; delete the two guarded `mavenLocal` blocks (root `settings.gradle`, `examples/bare/android/build.gradle`); update `native-versions.test.ts`; regenerate `packages/react-native/src/options/android-options-manifest.json` against the 7.3.0 sources (`node scripts/cli-extract-option-keys.ts <iosRoot> <androidRoot at v7.3.0>`), because `option-manifest-parity.test.ts` requires `manifest.sdkVersion === android.sdk` and fails the moment the pin flips (final-review fix A3). The CLI also rewrites `option-keys.json`: restore that file here and leave it to 3.P4. Nothing else.
- [x] **Verify** — `yarn test` (the maven-local test branches on the pin: for a released pin it asserts no `mavenLocal` in any tracked Gradle file; `option-manifest-parity.test.ts` asserts the regenerated manifest's `sdkVersion` is `7.3.0`); `BUGSEE_RELEASE=1 yarn test` passes for Android (iOS may still block if 3.P2 is on its placeholder); CI's android job green. Device: the harness's `SDK build` step shows `Bugsee Android SDK 7.3.0 [<sha>]`; compare `<sha>` with `git -C "$CLONE" rev-parse --short v7.3.0` after fetching tags. If the release commit differs from `snapshotCommit`, rerun 3.4d and 3.5b before closing this task.
- [x] **Mutate** — re-add an unconditional `mavenLocal()` to the example: the maven-local test must fail. Revert.
- [x] **Commit** — `build(android): pin the released 7.3.0`. Body: the banner line and both SHAs.

**As run (2026-09-29).**
- **Precondition:** `bugsee-android`, `bugsee-android-ndk` and `bugsee-android-okhttp` 7.3.0 all answer 200 on Maven Central.
- **SHAs:** `v7.3.0` = `beb390dc02bae24d43fc6addd83c33ace4406087`; the old `snapshotCommit` `234dcddfcb972da008eeeb0e3ad8757e27ba3e50` is an ancestor, 15 commits behind. They differ, so every Android suite was rerun.
- **Resolution:** Gradle resolves `bugsee-android:7.3.0` from Maven Central. The cached AAR's SHA-1 `666674c7…` matches Central's `.sha1`. The stale `~/.m2` 7.3.0 AAR (`ce189836…`, 2026-09-20) is no longer consulted.
- **Manifest:** regenerated from `v7.3.0` and iOS `0d9c9d0a3`. The only change is the new `com.bugsee.option.detect.exit.bg_low_memory_as_error` (#190), plus `sdkVersion` and `generatedAt`.
- **Checks:**
  - `yarn test`: 1155 passed, 1 skipped.
  - `BUGSEE_RELEASE=1 yarn test`: 1156 passed, with no blockers on either platform.
  - Lint, typecheck, root `./gradlew test`, and the example's `:bugsee_react-native:testDebugUnitTest :app:assembleDebug` are all green.
  - CI was not run because nothing was pushed. Its SNAPSHOT guard passes locally.
- **Mutation:** an unconditional `mavenLocal()` in the example fails `maven-local.test.ts` (Expected 0, Received 1). Reverted.
- **WOD_LX1 (`AMRJCP4718402860`):** the banner reads `Bugsee Android SDK 7.3.0 [beb390dc0]`, which matches `v7.3.0`. Every Android suite passes:
  - debug build: `launch`, `data` 4/4, `attributes` 6/6, `wrapper-channel` (3.5b) 2/2, `secure-rectangles` (`E2E_EDGE_TO_EDGE=true`) 1/1, and `report-handler` cases 1–5 and 7;
  - debuggable release build: `report-handler` (3.4d) 7/7 with the iOS-only case skipped, then case 6 again twice, 3/3 in total. In every case-6 run the onAfter dispatch completed `by=js` in +9–13 ms, and the crash bundle carried the nonce labels. Four `libbugsee*.so` files loaded.

---

### Task 3.P4 — Regenerate `option-keys.json` against `7.3.0`

Added by controller ruling. Pending — runs after 3.P3, against the flipped, released Android pin, not against the SNAPSHOT.

**Why:** `option-keys.json` (`scripts/cli-extract-option-keys.ts`) is a committed fixture generated from the Android and iOS SDK sources. It was last regenerated against Android 7.2.0. 7.3.0 is the release the wrapper channel, the report-contract methods and `com.bugsee.option.$$WRAPPER` shipped in (Phase 3's rulings); Android's option surface has moved since, and the fixture has not been asked to notice.

- [ ] Regenerate `option-keys.json` (and the `shared`/`android`-only/`iOS`-only split it derives) from the `7.3.0` Android sources and the pinned iOS `7.0.0-beta3` sources.
- [ ] Expose any option `7.3.0` added that Android carries and this wrapper does not yet surface as a first-class accessor — at minimum, confirm none of the new keys are silently dropped the way `19a034a` fixed for deprecated-but-registered options.
- [ ] `option-manifest-parity.test.ts` and `option-keys.test.ts` stay green against the regenerated fixture.
- [ ] **Commit** — `build(options): regenerate option-keys.json against 7.3.0`.

---

### Task 3.T — Phase 3 pre-merge tidy-ups (done)

Added by controller ruling. Commits `5ef0b60`..`ec4220e`. Both reviews are clean.

- [x] The root tracker's listener handle is simplified to `LayoutListenerToken.release()`. It holds only weak references and is idempotent, and the observer is re-homed only while the saved observer is dead and the view is attached. This closes the leak when a root is replaced inside a live window. The B1 conversion is byte-identical.
- [x] The Android dispatch-vs-detach race is closed: the sink is re-checked after the put.
- [x] Report attribute names: empty names are rejected in JS and natively. `"__proto__"` is sent and read back as an own key.
- [x] Small leftovers: the e2e `finally` ordering, the pulled-bundles test cascade, the dispatcher's trailing `.catch`.

### Task 3.H — Hardware pass (required before merge)

Added by controller ruling. Run it once a physical iPhone (the XS) is attached, together with the WOD_LX1 (`AMRJCP4718402860`). Every item is a real run on hardware with its evidence recorded. None may accept "either outcome".

- [x] **Harness: physical-iPhone path.** A `DeviceConsole` over `devicectl … --console`. Bundle pull with `devicectl device copy from --domain-type appDataContainer`. Clear by deleting that directory and asserting it's gone. `DEAD_ENDPOINT` retention (the phone's own loopback). Process death proved by the end of the console stream plus the recovered crash bundle, not the host's DiagnosticReports. Check the `threadOf()` prefix survives `devicectl` output. Build it on the shared `e2e/harness.ts` helpers.
- [x] **iOS** (through Phase 5):
  - 3.4f case 6 (recovery), with `E2E_IOS_RECOVERY=1`;
  - 3.5d (the channel);
  - Task 4.4;
  - Task 5.5, including across a real process restart, and clearing the Keychain identity first and last;
- [ ] **iOS, Phase 6:** Task 6.9, plus any cases gated during Phase 6 (not yet written when the pass above ran).
- [x] **Android on the WOD_LX1:**
  - 3.4d case 6 (the native-crash recovery case; it flakes on the emulator);
  - the B1 secure-rectangle check with `edgeToEdgeEnabled=false`, run as an e2e assertion rather than the one-off manual numbers.
- [x] **Record** the device models and OS versions, the SDK banner or version, and the per-case evidence in the commit body.

**As run (2026-09-29, through Phase 5).**
- **Devices:**
  - iPhone XS "KRSFT" (iPhone11,2), iOS 18.7.9 (22H355), Debug build, `Bugsee IOS SDK ver:7.0.0-beta3 build:0d9c9d0a-9`;
  - WOD_LX1 (HONOR WOD-LX1), Android 14 / API 34, `Bugsee Android SDK 7.3.0-SNAPSHOT [234dcddfc]`.
- **iPhone XS:** every iOS suite passes: `E2E_PLATFORM=ios E2E_IOS_TARGET=device E2E_IOS_RECOVERY=1 yarn e2e` gives 20 passed and 2 skipped (both Android-only). Case 3 of 5.5 is still `it.failing` for the SDK bug. Run as a plain `it`, it fails at its first assertion: `manifest.attrs` is `{}` against the 10 expected keys. The later `email` assertion is not reached.
- **WOD_LX1:**
  - case 6 passes 3/3 on the debuggable release build;
  - B1 is now asserted per build: `E2E_EDGE_TO_EDGE=false` with `assembleDebug -PedgeToEdgeEnabled=false`, with no source change;
  - a mutant that drops the origin fails B1, 51 px off.
- **Harness changes:**
  - iOS scenarios travel as launch arguments. The iPhone's Debug app runs its embedded bundle without Local Network permission.
  - An iPhone clear wipes the app's whole container, the only removal devicectl has, and asserts the SDK directories are gone.
  - `launch.test.ts` runs iOS against `DEAD_ENDPOINT`. The placeholder token otherwise leaves the SDK's `BugseeKilledSdkKey` behind.
- **Harness safety (review round):**
  - The iPhone comes only from an allowlist in `e2e/device.ts` (the XS alone). Its model and UDID are checked with `devicectl list devices` before any other command, and `E2E_IOS_TARGET` must be stated as exactly `simulator` or `device`.
  - A placeholder token always launches against the dead loopback endpoint (`examples/bare/endpoint.ts`), on both platforms and whatever path launched the app.
- The full per-case evidence is in the body of commit `a8153be` (docs(plan): Task 3.H hardware pass, as run through Phase 5).

**Open from this pass:**
- **iOS crash recovery: onAfter edits reach the recovered crash bundle in only 1 of 5 runs on the XS.**
  - JS logged `labels-set` and completed `by=js` each time, but `request.labels` was `[]` in 4 runs.
  - Root cause, per the review: beta3's `handleRecoveredReportingRequest` runs the bounded dispatch (`invokeBoundedReportHandlers`). That dispatch waits only for the handler calls to *return*, not for their completion, and then persists the request at once.
  - Our bridge returns microseconds after emitting to JS, so JS's edits usually lose the race with bundling. The late-completion persist block does nothing once bundling has started.
  - Our ordering is verified correct: the patch is applied synchronously before `reportUpdate` resolves, and completion runs only after the handler resolves.
  - Android's live recovery path landed its labels 3 of 3 times.
  - Tracked as an iOS SDK issue: the bounded path says handlers "may work asynchronously" but honours only work that beats bundling.
  - No iOS labels assertion yet, not even as `it.failing`: at 1 in 5 it would flake. A wrapper-side mitigation (block the SDK's worker until JS completes, on the off-main path only) is possible but needs a deadlock review.
- **iOS `launch()` resolves about 8 s late on the XS when a retained bundle is still pending and the endpoint is dead.** It came in at 8.1–8.5 s, against 0.03–0.5 s after a wipe. That is close to `launch.test.ts`'s 10 s budget. Normal suite order clears on exit, but an interrupted suite could leave the next `launch.test.ts` near that edge.
- **Fixed in the review round:** Android `launch.test.ts` used to contact the real endpoint with the placeholder token on every run. It now launches against the dead endpoint, and the app's placeholder rule covers every other path. On the WOD_LX1 the SDK itself reports `com.bugsee.option.$$ENDPOINT` = `https://127.0.0.1:9`.

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

## Phases 4–6 — shared ground

These three phases run **in order: 4, then 5, then 6**. Each ends with its own review gate, and the next phase does not start until the gate is satisfied. Phases 4 and 5 are small: they settle how values cross the bridge, a pattern Phases 7–11 reuse. Phase 6 carries the first native→JS round trip on the capture path (the `vh` data request), so it is the largest of the three.

**Implementers never create external resources.** That means no GitHub issues, PRs or branches in any other repository; no pushes; no Bugsee applications, tokens or uploads; and no published packages. When a task finds something that needs one (an SDK defect, a specs correction), it writes the finding into its task report for the controller and carries on or stops, as the task says.

**Paths used below.**
- `src/…` = `packages/react-native/src/…`
- `android/…` = `packages/react-native/android/src/main/java/com/bugsee/reactnative/…`
- `androidTest/…` = `packages/react-native/android/src/test/java/com/bugsee/reactnative/…`
- `support/…` = `packages/react-native/ios/Support/Sources/BugseeRNSupport/…`, with headers under `support/include/…`
- `supportTests/…` = `packages/react-native/ios/Support/Tests/BugseeRNSupportTests/…`
- `ios/BugseeModule.mm` = `packages/react-native/ios/BugseeModule.mm`
- `e2e/…` and `scenarios/…` are under `examples/bare/`

**Commands used below.**
- JS: `yarn test`, then `yarn mutate:src` (break threshold 95%).
- Android JVM: `./gradlew :bugsee-android-bridge:testDebugUnitTest`.
- iOS Support: `cd packages/react-native/ios/Support && xcodebuild test -scheme BugseeRNSupport -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'`.
- RN floor: `./scripts/check-rn-compat.sh 0.81`.
- Android device: `yarn workspace bugsee-example-bare device:android`, then `E2E_PLATFORM=android yarn workspace bugsee-example-bare e2e <file>`.
- iOS device: `yarn workspace bugsee-example-bare device:ios`, then `E2E_PLATFORM=ios yarn workspace bugsee-example-bare e2e <file>`.

**Rules for every native method added in these phases.**
- On iOS, every SDK call runs on main through `BGSRNRunOnMain` (Global Constraints). A promise resolves from inside that block.
- On Android, calls run on the native-modules thread. Every SDK method used here is documented thread-safe.
- A void TurboModule method never lets an exception escape: nothing can reject it, so an exception would crash the host. It catches `RuntimeException` on Android (logging at `BugseeRN`); on iOS it guards with `respondsToSelector:` or `isKindOfClass:`, never with `@try`.
- Every new spec method gets a stub or an implementation on both platforms **in the same commit**. `ios-spec-coverage.test.ts` and the `check-rn-compat.sh` java-signatures step stay green at every commit.
- The JS mock (`src/__mocks__/native.ts`) gains a `jest.fn` for every new method, and `reset()` restores its default.

**Devices.** Android runs on the WOD_LX1 (`AMRJCP4718402860`). iOS runs on the iOS 26.5 simulator (iPhone 17 Pro) until an iPhone is attached. The per-run preconditions are 3.4d's (Android) and 3.4f's (iOS), asserted through `startRun()` in `e2e/harness.ts`: the SDK build banner or version line matches the pin, bundles are cleared and the clear is asserted, retention is set up (airplane mode, or `DEAD_ENDPOINT`), and the SDK reaches `Launched`. **Hardware pass: add to Task 3.H** means the case joins the hardware-pass list the Phase 3 gate requires before merge. If Task 3.H does not yet exist as its own task, append the case to the Phase 3 review gate's hardware-pass paragraph instead. Every iOS device task below joins that list whole. Where a phase also names a gated case, it runs only behind its environment variable and joins the list too. A device test never accepts "either outcome": when a platform genuinely differs, the test states each platform's expected value, and when a precondition cannot be met, the test fails and the task stops and reports.

---

## Phase 4 — Logging, events, traces

**Ships:** `Bugsee.log(message, level?)`, `Bugsee.event(name, params?)`, `Bugsee.trace(name, value)`.

### Rulings (controller, 2026-09-29)

- **Ruling:** Phase 4 runs first. Phase 5 does not start until Phase 4's review gate is satisfied.
- **Ruling:** `log()` goes through the existing `forwardLog` → `wrapperLog` → wrapper-channel route **only**. Its source stays `Custom` (98) and its level maps by value. No second native route.
- **Ruling:** `event` and `trace` call the SDKs' public APIs.
- **Ruling:** params must survive the bridge with their types and nesting intact. JS rejects any value outside the accepted domain before it crosses.
- **Ruling:** device tests assert the lines, events and traces in retained bundles on both platforms.
- **Ruling (after Task 4.4):** an object payload that can carry `null` crosses the bridge as **JSON text**, never as `UnsafeObject`. React Native's iOS `convertJSIObjectToNSDictionary` skips every member whose value converts to `nil`, and a JS `null` does unless `enableModuleArgumentNSNullConversionIOS` is on (default `false`). A library cannot depend on that app-level flag across its 0.81 floor. Android's `ReadableMap` keeps the `null`, so the same call meant different things on the two platforms. This hit event params (4.4 case 2) and, silently, Phase 3's report patch (`summary: null`, `description: null`, attribute `null`). See Task 4.5.
- **Ruling (Task 4.5, fix round 1):** `encodeBridgeObject` replaces every lone UTF-16 surrogate, in keys and values, with U+FFFD before encoding (`String.prototype.toWellFormed` where the engine has it, a manual fallback where it does not). `JSON.stringify` escapes a lone surrogate as `\ud800`, and iOS's `NSJSONSerialization` rejects the whole text for it; RN's own string conversion used to produce U+FFFD, and this keeps that.
- **Follow-up, not fixed by Task 4.5:** launch options (`launch`/`relaunch`, `UnsafeObject`) have the same iOS null-drop exposure: a `null`-valued option never reaches the iOS SDK.

### Planner decisions (reviewable; change them here, not inside a task)

- **`log()` is a facade over `forwardLog`, not `forwardLog` itself.** The public signature is 6.x's `log(text, level)`, a method on the default export like every other entry point. `forwardLog` stays internal: Phase 9 routes `console.*` through it, and that caller may need things the public method must not expose. The facade adds nothing but the name. A static test holds the "one route" rule: `index.ts` never calls `wrapperLog` directly.
- **Consequence to document on `log()`:** a line sent through the channel is filtered by the app's log filter, unlike the native `Bugsee.log`, which bypasses it by default. That is §10.3's rule. A line sent before `launch()` is dropped, because the channel is inert until then (3.5b, 3.5d).
- **Typed trace methods, one per value type** (`traceNumber`, `traceString`, `traceBoolean`), rather than one `UnsafeObject` wrapper. Codegen has no union parameter type. A typed boolean reaches iOS as a `CFBoolean` and Android as a `Boolean`, so it cannot arrive as a `0`/`1` number, which is the silent failure an untyped path allows.
- ~~**Event params cross as `UnsafeObject | null`, unconverted.**~~ Superseded by the Task 4.5 ruling: params cross as `string | null`, JSON text parsed natively. Both SDKs serialise nested maps, lists, strings, booleans, numbers and null (verified facts below). Both write an integral number as an integer, and both parsers yield an integer type for an integral literal (Android `Integer`/`Long`, iOS an integer `NSNumber`).

### Verified facts these tasks rely on (2026-09-29)

**Android** (`bugsee-android` `234dcddfc`, the pinned SNAPSHOT):
- API: `Bugsee.event(String, HashMap<String,Object>)`, `Bugsee.event(String)` and `Bugsee.trace(String, Object)`.
- A null or empty name, or a null trace value, is a no-op.
- There is no launch gate: before start the consumer is null and the call is dropped.
- JSON writer (`shared/serialization/json/Writer.java`):
  - an integral `Number` is written as an integer (`3.0` → `3`);
  - a fractional one is written with `Double.toString`;
  - NaN and ±Infinity are written as **strings**.
- `Map` and `Iterable` nest.

**iOS** (`7.0.0-beta3`, `74af69ee8`):
- API: `+event:params:` (nullable `NSDictionary`) and `+trace:value:` (nonnull `id`).
- Both are no-ops unless the SDK is Launched or Launching (`bugseeAvailableForUserDumps`).
- `BGSJSONWriter`:
  - a `CFBoolean` is written as `true`/`false`;
  - a double is written in its shortest round-trip `%g` form (`3`, `9007199254740991`);
  - NaN and ±Infinity are written as `null`;
  - `NSNull`, arrays and dictionaries nest.
- MessagePack accepts `NSNull`.
- User traces are re-emitted at every capture-part switch (snapshot replay), so one `trace()` call can produce several entries with the same value.

**Bundle files** (`bugsee/specs` `sdk/reporting/bundle/`):
- `log` holds `{timestamp, level, source, tag?, message}`.
- `events.user` holds `{timestamp, displayId?, name, params?}`; `params` is present only if non-empty.
- `traces.user` holds `{timestamp, displayId?, name, value}`.

**Harness gap:** `e2e/bundles.ts` `PulledBundle` exposes only the `log` file.

### Constants

| Name | Value | Why |
|---|---|---|
| `EVENT_PARAMS_MAX_DEPTH` | `16` | Nesting past this is almost certainly a cycle or an accident. It is rejected with the path. |

| Error | When |
|---|---|
| `TypeError` | A value of the wrong type: a non-string message or name, a param value outside the domain (the message names its path, e.g. `params.nested.list[2]`), or a trace value that is not a string, finite number or boolean. |
| `RangeError` | A log level outside 1–5 (already thrown by `forwardLog`), an empty event or trace name, a non-finite number, or nesting deeper than 16. |

All errors are thrown synchronously, before anything crosses. The three methods are fire-and-forget (`void`), like `upload`.

**The accepted value domain.**
- Event params are a *plain object*: its prototype is `Object.prototype` or `null`. Its values, recursively, are:
  - `string`;
  - finite `number`;
  - `boolean`;
  - `null`;
  - arrays of these;
  - plain objects of these.
- An `undefined` object member is **omitted**, as `JSON.stringify` does, and this is documented.
- Everything else is rejected, with its path:
  - `undefined` as an array element;
  - `NaN` and `±Infinity`;
  - `bigint`, `symbol` and functions;
  - `Date`, `Map`, `Set`, typed arrays and class instances;
  - a cycle;
  - depth greater than 16.
- A trace value is a `string`, a finite `number` or a `boolean`. Anything else, `null` included, is rejected.

---

### Task 4.1 — `Bugsee.log()`: the public facade over `forwardLog`

**Files:**
- Modify: `src/index.ts`
- Create: `src/__tests__/log.test.ts`, `scripts/__tests__/single-log-route.test.ts`

**Interface (exact):**

```ts
// src/index.ts, on class Bugsee
/**
 * One line into the Bugsee log, attributed to the wrapper (source Custom, no
 * tag) and filtered natively by the app's log filter, exactly once. Dropped
 * before launch() -- the channel is inert until then.
 */
log(message: string, level: LogLevel = LogLevel.Info): void {
  forwardLog(message, level);
}
```

`forwardLog` stays unexported from `src/index.ts`.

- [ ] **Red**
  - `log.test.ts`, mocking `../wrapper/channel` with a spy:
    - `log forwards message and level through forwardLog`;
    - `log defaults to Info (3)`;
    - `log is a method on the default export`.
  - `log.test.ts`, with the native mock and no channel mock:
    - `log rejects 0, 6 and 2.5 before crossing` (RangeError, `wrapperLog` not called);
    - `log rejects a non-string message before crossing` (TypeError);
    - `forwardLog is still not exported from the package entry`.
  - `single-log-route.test.ts`:
    - `only src/wrapper/channel.ts references wrapperLog`: read every `src/**/*.ts(x)` outside `__tests__` and `__mocks__`, strip comments, and allow `NativeBugsee.ts` (the declaration) and `wrapper/channel.ts` only;
    - `src/index.ts reaches the channel only through forwardLog`.
  - Run → FAIL.
- [ ] **Green** — the method above, plus its JSDoc (source Custom, filtered natively, dropped before launch).
- [ ] **Mutate**
  - (1) Replace the body with `NativeBugsee.wrapperLog(message, level)`. `only src/wrapper/channel.ts references wrapperLog` must fail.
  - (2) Default to `LogLevel.Debug`. `log defaults to Info (3)` must fail.
  - Revert each and record the results.
- [ ] **Commit** — `feat(log): Bugsee.log over the wrapper channel, the one native route`.

**Acceptance:** `Bugsee.log` exists. It cannot reach native except through `forwardLog`, and no new native code exists.

---

### Task 4.2 — `event` and `trace`: JS validation, spec, and both bridges

**Files:**
- Create: `src/data/validate.ts`, `src/data/__tests__/validate.test.ts`, `src/__tests__/event-trace.test.ts`
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`
- Modify: `android/BugseeModule.java`
- Modify: `ios/BugseeModule.mm` (both `#if __has_include` import branches if a Support header is added; `ios-delivery-parity.test.ts` enforces it)
- Create: `support/BGSRNValues.m`, `support/include/BGSRNValues.h`, `supportTests/BGSRNValuesTests.m`

**TurboModule additions (exact):**

```ts
event(name: string, params: UnsafeObject | null): void;
traceNumber(name: string, value: number): void;
traceString(name: string, value: string): void;
traceBoolean(name: string, value: boolean): void;
```

> **Superseded by Task 4.5 (JSON text).** `event` is now `event(name: string, paramsJson: string | null): void`, the params JSON text from `encodeBridgeObject`.

**Public JS API (exact):**

```ts
// src/data/validate.ts
export type EventParamValue =
  | string | number | boolean | null
  | readonly EventParamValue[]
  | { readonly [key: string]: EventParamValue | undefined };
export type EventParams = { readonly [key: string]: EventParamValue | undefined };
export type TraceValue = string | number | boolean;
export const EVENT_PARAMS_MAX_DEPTH = 16;
/** Throws TypeError/RangeError; returns a fresh plain copy with undefined members omitted. */
export function copyEventParams(params: EventParams): Record<string, unknown>;
export function assertEventOrTraceName(kind: 'event' | 'trace', name: unknown): asserts name is string;
export function assertTraceValue(value: unknown): asserts value is TraceValue;

// src/index.ts, on class Bugsee
event(name: string, params?: EventParams): void;   // params undefined -> native null
trace(name: string, value: TraceValue): void;      // dispatches on typeof value
```

Export `EventParams`, `EventParamValue` and `TraceValue` as types from `src/index.ts`.

**Android** (`BugseeModule.java`):
- `event(String name, @Nullable ReadableMap params)` calls `Bugsee.event(name)` when `params == null`. Otherwise it calls `Bugsee.event(name, params.toHashMap())`. *(Superseded by Task 4.5 (JSON text): `event(String name, @Nullable String paramsJson)`, parsed with `BridgeJson.parseObject`; unparseable text is logged and the event dropped.)*
- `traceNumber(String name, double value)` calls `Bugsee.trace(name, value)` (a boxed `Double`).
- `traceString` calls `Bugsee.trace(name, value)`.
- `traceBoolean(String name, boolean value)` calls `Bugsee.trace(name, Boolean.valueOf(value))`.
- Each is wrapped in `try { … } catch (RuntimeException e) { Log.e("BugseeRN", "<method> failed", e); }`.

**iOS** (`BugseeModule.mm`), each inside `BGSRNRunOnMain`:
- `event:params:` calls `[Bugsee event:name params:params]`, where `params` is `nil` when JS sent `null`. *(Superseded by Task 4.5 (JSON text): `event:paramsJson:`, parsed with `BGSRNJSONObject`; unparseable text is logged and the event dropped.)*
- `traceNumber:value:` calls `[Bugsee trace:name value:@(value)]`.
- `traceString:value:` calls `[Bugsee trace:name value:value]`.
- `traceBoolean:value:` calls `[Bugsee trace:name value:BGSRNBoolNumber(value)]`.

`support/BGSRNValues.h` declares `FOUNDATION_EXPORT NSNumber *BGSRNBoolNumber(BOOL value);`. It returns `(__bridge NSNumber *)kCFBooleanTrue` or `kCFBooleanFalse`, so the boolean identity cannot depend on how `@(…)` boxes a `BOOL` on a given architecture.

- [ ] **Red**
  - `validate.test.ts`:
    - `accepts nested objects and arrays of JSON values`;
    - `omits undefined object members`;
    - `rejects NaN, Infinity and -Infinity, naming the path` (e.g. `params.a.b[1]`);
    - `rejects undefined inside an array`;
    - `rejects functions, symbols and bigint`;
    - `rejects Date, Map, Set, Uint8Array and a class instance`;
    - `rejects a cycle`;
    - `rejects nesting deeper than 16 and accepts exactly 16`;
    - `rejects params that are not a plain object` (`[]`, `null`, `new (class {})()`);
    - `accepts an object with a null prototype`;
    - `returns a copy: mutating the input afterwards does not change it`;
    - `rejects an empty or non-string name` (both kinds);
    - `trace accepts a string, a finite number and a boolean`;
    - `trace rejects null, undefined, NaN, Infinity and objects`.
  - `event-trace.test.ts` (native mock):
    - `event forwards name and the copied params`;
    - `event without params sends null`;
    - `event with {} sends {}`;
    - `event validates before crossing` (the native `event` not called on a bad value);
    - `a number trace goes to traceNumber`;
    - `a string trace goes to traceString`;
    - `a boolean trace goes to traceBoolean`;
    - `a bad trace crosses nothing`.
  - `BGSRNValuesTests.m`:
    - `testTrueIsTheCFBooleanSingleton`;
    - `testFalseIsTheCFBooleanSingleton`;
    - `testABoolNumberIsNotAnInteger` (`CFGetTypeID` is `CFBooleanGetTypeID()`).
  - Run → FAIL.
- [ ] **Green**
  - The modules above.
  - The mock gains `event`, `traceNumber`, `traceString` and `traceBoolean`.
  - Android and iOS as specified.
  - `ios-spec-coverage`, `check-rn-compat.sh 0.81` and both example builds green.
- [ ] **Mutate**
  - (1) Drop the `Number.isFinite` check. `rejects NaN, Infinity and -Infinity` must fail.
  - (2) Send booleans to `traceNumber`. `a boolean trace goes to traceBoolean` must fail.
  - (3) Drop cycle detection. `rejects a cycle` must fail (a stack overflow is not the expected `TypeError`).
  - (4) Make `BGSRNBoolNumber` return `@((int)value)`. `testTrueIsTheCFBooleanSingleton` must fail.
  - Revert each and record the results.
- [ ] **Commit** — `feat(data): event and trace with a validated value domain, both bridges`.

**Acceptance:** both methods reject every out-of-domain value in JS before it crosses. Each value type reaches the SDK as that type on both platforms, and every build is green.

---

### Task 4.X — Separate build directories for the standalone and example Android builds

Added by controller ruling, not originally in this plan. `packages/react-native/android` is built by two Gradle builds -- the standalone unit-test build at the repo root (`:bugsee-android-bridge`) and the example app (`examples/bare/android`, via autolinking as `:bugsee_react-native`) -- and both defaulted to writing into the same `packages/react-native/android/build/`, so running one after the other without a clean in between left each build seeing the other's stale classes, generated codegen and test results; this had already misled two implementers into reading a real pass as a `ClassNotFoundException` failure. The root `settings.gradle` now redirects only the standalone project's output, via `gradle.beforeProject` and `layout.buildDirectory`, to `<repo root>/build/android-bridge` (already covered by the existing bare `build/` gitignore entry), leaving the example build's own default untouched; no CI step, script (`cli-check-java-signatures.ts` takes its paths as arguments and never hardcoded the shared directory) or doc hardcoded the old shared output path, so nothing else needed updating. `scripts/build-dir-redirect.ts` + `scripts/__tests__/build-dir-redirect.test.ts` (100% mutation score standalone) assert the redirect is in place and that no tracked script or CI file references the old path. Verified from clean in both orders -- root `test`, then example `testDebugUnitTest` + `assembleDebug`, and the reverse -- all green: 123 tests in the example build, 114 in the standalone build (which excludes the TurboModule/`ReactRootOriginTracker` tests that need the RN classpath the example alone provides). Full report: `.superpowers/sdd/2026-09-16-implementation-plan/task-4.X-report.md`.

- [x] **Commit** — `build(android): give the standalone test build its own build directory`.

---

### Task 4.3 — Device verification, Android: lines, events and traces in a retained bundle

**Files:**
- Modify: `e2e/bundles.ts`, adding `captures` and `captureEvents`
- Create: `scripts/__tests__/e2e-capture-files.test.ts`, `scenarios/data.ts`, `e2e/data.test.ts`
- Modify: `App.tsx` (dispatch the `data` scenario; `preLaunchDataProbe` before `launch()`, like `preLaunchChannelProbe`)

**Harness additions (exact):**

```ts
// PulledBundle gains:
readonly captures: ReadonlyMap<string, string>;  // raw text, keyed by manifest `type`, for every entry whose stored file ends in `.json`
// and:
export function captureEvents(bundle: PulledBundle, type: string): Array<Record<string, unknown>>; // `events` of that file; [] when the manifest has none
```

`parseBundle` fills `captures` for both platforms, and `log` stays as it is.

**Scenario `data` (`scenarios/data.ts`).** Every name and value carries the run's nonce `<n>`.

Before `launch()`:
- `Bugsee.log('pre-<n>')`;
- `Bugsee.event('pre-<n>')`;
- `Bugsee.trace('pre-<n>', 1)`;
- then the marker `BUGSEE_E2E data pre-sent nonce=<n>`.

After `Launched`:
- `Bugsee.log('BUGSEE_E2E data log L<l> <n>', l)` for `l` of 1–5, then `Bugsee.log('BUGSEE_E2E data log default <n>')`;
- `Bugsee.event('data-<n>', PARAMS)`, where `PARAMS = { str: 's-<n>', int: 3, neg: -7, frac: 1.5, big: 9007199254740991, yes: true, no: false, nil: null, nested: { list: [1, 'two', { deep: false }], empty: {} }, skipped: undefined }`;
- `Bugsee.event('data-bare-<n>')`;
- `Bugsee.trace('data-num-<n>', 42)`, `Bugsee.trace('data-frac-<n>', 0.25)`, `Bugsee.trace('data-str-<n>', 'on')` and `Bugsee.trace('data-bool-<n>', true)`;
- the marker `BUGSEE_E2E data sent nonce=<n>`;
- `Bugsee.upload('data-<n>', '')`.

**Cases (`e2e/data.test.ts`, one run, one retained bundle):**
1. `lines land as Custom at the level they were sent at` — for each `l` in 1–5 the `log` file has exactly one event whose `message` is `BUGSEE_E2E data log L<l> <n>`, with `level = l`, `source = 98` and no `tag` key. The `default` line has `level = 3`.
2. `an event's params survive the bridge`
   - `captureEvents(b, 'events.user')` has exactly one entry named `data-<n>`, whose `params` deep-equal `PARAMS` without `skipped`.
   - The raw `events.user` text matches `/"big":9007199254740991[,}]/` and `/"int":3[,}]/`: integers, with no exponent and no `.0`.
   - The entry named `data-bare-<n>` has no `params` key.
3. `traces keep their value and their type` — for each of the four names, `traces.user` has at least one entry, and **every** entry with that name has a `value` `===` the one sent (`42`, `0.25`, `'on'`, `true`). `typeof` must match, since snapshot replay may repeat an entry.
4. `nothing sent before launch reaches the bundle`
   - The marker `data pre-sent` precedes `Launched` in the log (the experiment really ran).
   - No log message, event name or trace name contains `pre-<n>`.

- [ ] **Red**
  - `e2e-capture-files.test.ts` (fixture directory in a temp root):
    - `reads every JSON capture the manifest names, keyed by type`;
    - `captureEvents is empty for a type the manifest lacks`;
    - `a manifest entry whose file is missing is skipped`.
  - Write the device test and the scenario. Run once before wiring `App.tsx` → FAIL at the first marker.
- [ ] **Green** — wire `App.tsx`. All four cases pass on the WOD_LX1.
- [ ] **Mutate**
  - (1) Temporarily make `Bugsee.event` send `null` params. Case 2 must fail.
  - (2) Temporarily make Android `traceBoolean` call `Bugsee.trace(name, value ? 1 : 0)`. Case 3 must fail on `typeof`.
  - Revert and record.
- [ ] **Commit** — `test(e2e): log, event and trace in an Android bundle`. The commit body records the banner line and one event line and one trace line from the pulled files.

---

### Task 4.4 — Device verification, iOS (simulator): the same four cases

**Files:**
- Modify: `e2e/data.test.ts`, which runs under `E2E_PLATFORM=ios` through `startRun`/`awaitBundles`, exactly as 3.5d reused 3.4f

Cases 1–4 of 4.3 apply unchanged. Two iOS notes:
- Case 4's pre-launch drop is the SDK's own gate (`bugseeAvailableForUserDumps`) for `event` and `trace`, and the channel holder's for `log` (no wrapper is registered before `launch()`). Say so in the test's header comment, as `scenarios/channel.ts` does.
- iOS writes `displayId: 0` on every user event and trace. The test does not assert on `displayId`.

- [x] **Red/Green** — all four cases pass on the simulator. (Case 2 failed until Task 4.5.)
- [x] **Mutate** — temporarily make iOS `traceBoolean` pass `@(value ? 1 : 0)` as an `int`. Case 3 must fail. Revert and record.
- [x] **Commit** — `test(e2e): log, event and trace in an iOS bundle`.

**Hardware pass: add to Task 3.H** — Task 4.4 on a physical iPhone.

---

### Task 4.5 — Carry null-bearing objects across the bridge as JSON

Added by controller ruling after Task 4.4 (see Rulings above). Task 4.4 case 2 failed on the simulator because `"nil": null` never reached the SDK; the same conversion made a report patch's `null`s (clear the summary or description, remove an attribute) silently do nothing on iOS, which `BGSRNReportOps`' unit tests could not see because they pass `NSNull` directly.

**Fix: one transport for object payloads, on both platforms.**
- **JS:** `src/bridge/json.ts` `encodeBridgeObject(value): string` JSON-stringifies an already-validated plain value (the event-params copy, the validated report patch).
- **Spec:** `event(name: string, paramsJson: string | null): void` and `reportUpdate(handleId: string, patchJson: string): Promise<void>`. Every other argument is unchanged.
- **Android:** `BridgeJson` (org.json → `LinkedHashMap`/`ArrayList`; `JSONObject.NULL` → `null`; an integral literal stays `Integer`/`Long`, anything else numeric becomes `Double`). `ReportOps.applyJson` parses, then applies with the existing all-or-nothing `apply(Map)`. Unparseable patch text → `E_REPORT_BAD_ARGUMENT`; unparseable event params → logged, event dropped.
- **iOS:** `BGSRNJSONObject` (`NSJSONSerialization`, `NSNull` kept, integer `NSNumber` for an integral literal, `CFBoolean` for `true`/`false`) in `BugseeRNSupport`, and `+[BGSRNReportOps applyPatchJSON:toReport:error:]`. Same error mapping as Android.
- **Checks:** the mock's `event`/`reportUpdate` take strings, with a `jsonOf()` matcher; `ios-spec-coverage` checks every Spec method's full selector; `check-rn-compat.sh` asserts the generated protocol takes `NSString` for both.

**Device proof:** 4.4 case 2 passes on the simulator with `"nil": null`. A new report-handler case, `clear` (`rh-clear`), sets the summary, description and two attributes, then clears two fields and removes one attribute with `null`: the bundle has them cleared on both platforms. It fails on the pre-fix iOS bridge. 4.3 and the report-handler suite pass on the WOD_LX1.

- [x] **Commits** — `feat(android): parse bridge object payloads from JSON, nulls kept`; `feat(ios): parse bridge object payloads from JSON, NSNull kept`; `fix(bridge): carry event params and report patches as JSON text`; `test(e2e): a null summary, description and attribute clear in the bundle`. Full report: `.superpowers/sdd/2026-09-16-implementation-plan/task-4.5-report.md`.

---

### Phase 4 review gate

Spawn a reviewer subagent. It must independently:
- run `yarn test`, `yarn mutate:src`, the JVM tests, the Support XCTests and `check-rn-compat.sh 0.81`;
- confirm by reading the code that no path other than `forwardLog` reaches `wrapperLog`;
- confirm that no out-of-domain value can reach either native `event`/`trace` method without passing `src/data/validate.ts`;
- **rerun** 4.3, 4.4 and 4.5's `clear` case rather than trust the reported output.

Address its findings, and re-review until the reviewer is satisfied.

---

## Phase 5 — Attributes & identity

**Ships:**
- `setAttribute`, `getAttribute`, `getAllAttributes`, `clearAttribute` and `clearAllAttributes`;
- `setUserIdentifier`, `getUserIdentifier` and `clearUserIdentifier`.

### Rulings (controller, 2026-09-29)

- **Ruling:** Phase 5 starts after Phase 4's gate.
- **Ruling (Task 4.5):** attribute maps, and any object payload with nullable members, cross the bridge as JSON text (`src/bridge/json.ts`, parsed by `BridgeJson` / `BGSRNJSONObject`), never as `UnsafeObject`: iOS drops `null` members of an object argument.
- **Ruling:** Android takes `Serializable` and iOS takes `id`. JS defines the value domain the bridge accepts and rejects the rest before crossing. Every accepted type has a round-trip test.
- **Ruling (controller, after the Phase 4 gate):** one numeric bound for every number that reaches a bundle — attributes, event params and trace values: finite and `|v| < 2^63` (`9223372036854775808`, exclusive), exported as `BUNDLE_NUMBER_LIMIT` from `src/data/validate.ts`. Android's JSON writer writes any integral value (every float `≥ 2^24` is integral) through `longValue()`, so `≥ 2^63` silently becomes `9223372036854775807`. `FLOAT32_MAX` is superseded: it is larger, so the old bound let the clamp through. Tasks 4.2's validator gains this bound in Task 5.1's first commit.
- **Ruling:** tests never rely on the SDK's internal log. Until Android 7.3.0 and the next iOS beta, `setUserIdentifier`/`setAttribute` values are written verbatim to Android's SDK-internal log (fixed in `bugsee-android#186`). Device tests therefore use **synthetic, non-sensitive values only**, and assert nothing, either way, about `log.internal`.

### Planner decisions (reviewable)

- **The domain is the intersection of both SDKs:** `string | number | boolean`.
  - Android also takes `Set<String>`; iOS takes any property-list object. Neither is common to both, so neither is accepted.
  - Numbers must be finite with `|v| < 2^63` (`BUNDLE_NUMBER_LIMIT`, see the ruling above; ~~`FLOAT32_MAX`~~ superseded). Android also stores a fractional or large double as a 32-bit float, so a value above `2^24` may read back rounded — documented, like `0.1`.
  - Strings are limited to `≤ 1024` UTF-16 units, Android's per-value limit.
- **`setAttribute` returns `Promise<void>` and verifies on the native side.** Neither SDK reports a dropped value truthfully:
  - Android's public `setAttribute` is `void`, and `BugseeAttributes.put`'s `false` is discarded.
  - iOS returns `YES` even when it drops a value for size.
  - So each bridge reads the attribute back immediately and rejects with `E_ATTRIBUTE_REJECTED` if the SDK did not keep the value. This is how iOS's byte-based size limit, which JS cannot compute, becomes observable.
- **Android integral numbers cross as `Long`.** A value that is integral with `|v| ≤ 2^53−1` is sent as `Long`; anything else as `Double`. Without this, Android's float storage rounds `9007199254740991` to `9007199254740992`.
- **Reads return what the report will carry.** On Android, `getAttribute` and `getAllAttributes` both read `Bugsee.getAllAttributes()`, the persisted copy the report is built from, where a fractional value is a `Float`. `Bugsee.getAttribute` reads the in-memory copy, which still holds the original `Double`. A `Float` is widened with `doubleValue()`, the same widening the SDK's JSON writer applies. So `0.1` reads back as `0.10000000149011612` on Android, exactly as `manifest.json` shows it, and as `0.1` on iOS. This is documented on `setAttribute`.
- **An empty identifier clears.** iOS treats `''` as clear; Android stores `''` and omits it from `request.json`. JS maps `setUserIdentifier('')` to `clearUserIdentifier()`, and `getUserIdentifier()` maps `null` and `''` to `undefined` on both platforms.
- **Identity stays synchronous (`void`) and is not read back.** No size limit applies, and the bundle's `request.json` `email` is the device check. Attribute methods are all `Promise`-returning, so their ordering and rejection are uniform.

### Verified facts (2026-09-29)

**Android `234dcddfc`:**
- `Bugsee.setAttribute(String, Serializable)` → `BugseeAttributes.put`. It accepts:
  - `String` (length ≤ 1024);
  - `Integer`, `Long`, `Float`, `Boolean`;
  - `Double` (`< Float.MAX_VALUE`, stored as `float`);
  - `Set<String>`.
- The total of name and value lengths must stay ≤ 25 KB.
- A rejected value is silently dropped. A `null` value removes the attribute.
- `getAttribute` reads memory; `getAllAttributes` and the report's `manifest.json` `attrs` read the persisted preferences.
- `setUserIdentifier` stores the string as given (`""` included). `request.json` carries it as `email` only when non-empty.

**iOS `74af69ee8`:**
- `+setAttribute:withValue:` archives the value with `NSKeyedArchiver`. It ignores the value when the archive exceeds `CUSTOM_ATTRIBUTE_SIZE_LIMIT` 1124 bytes, or the whole set exceeds 25700 bytes — **returning `YES` either way**.
- **Corrected by controller ruling (2026-09-29, after Task 5.3):** the archive math predicts an effective per-value limit for a plain ASCII string of about **838 characters**, not 1024 — `NSKeyedArchiver archivedDataWithRootObject:requiringSecureCoding:NO` costs `length + 286` bytes for a bare ASCII `NSString` on current iOS Foundation (measured identically on iOS 18.5 and iOS 26.5 simulators: 800 chars → 1086 bytes, 900 → 1186, 1024 → 1310), so an 800-character string fits under 1124 bytes and a 900-character one should not. Non-ASCII text costs more per character (`NSKeyedArchiver` widens to UTF-16), so it allows fewer characters still.
- **Corrected again by controller ruling (2026-09-29, after Task 5.5):** observed on the published `7.0.0-beta3` binary: 800 characters is kept and 1024 is dropped, exactly as the archive math predicts at the ends — but a 900-character value was **kept** on device, contradicting the archive math's ~838-character crossover, even though the SDK source's own check (`BGSBugseeEnvironment setAttributeForKey:value:`) does ignore any value whose archive exceeds 1124 bytes, and the archive-math unit tests independently confirm 900 characters archives over that limit. The iOS SDK team has been asked why; the `e2e_900` row is removed from the table below rather than asserted either way, since it sits in this ambiguous zone. Android's per-value limit stays 1024 UTF-16 units regardless of script, so a string in the 800–1024 range that Android accepts can still be rejected on iOS with `E_ATTRIBUTE_REJECTED` — `e2e_long` (1024 characters) pins this; don't assume every string in that range behaves the same on iOS.
- Attributes are stored in `NSUserDefaults`.
- `+setUserIdentifier:` clears on nil, empty or non-string, and stores in the **Keychain**, which on a physical device survives an app reinstall.

**Report placement:** attributes land in `manifest.json` `attrs`, and the identifier in `request.json` `email`.

### Constants

| Name | Value |
|---|---|
| `ATTRIBUTE_STRING_MAX_LENGTH` | `1024` (UTF-16 units, inclusive) |
| `BUNDLE_NUMBER_LIMIT` | `9223372036854775808` = `2^63` (exclusive, on `Math.abs`; shared with event params and traces; supersedes `ATTRIBUTE_NUMBER_LIMIT`/`FLOAT32_MAX`) |
| `MAX_SAFE_LONG` (Android) | `9007199254740991` |

| Error code | Meaning |
|---|---|
| `E_ATTRIBUTE_BAD_ARGUMENT` | JS rejected the name or value before crossing. |
| `E_ATTRIBUTE_REJECTED` | The SDK did not keep the value: it was over a size limit, or dropped for any other reason. Detected by native read-back. |

---

### Task 5.1 — Attributes and identity: JS API, validation, spec, stubs

**Files:**
- Create: `src/attributes/validate.ts`, `src/attributes/errors.ts`, `src/attributes/__tests__/attributes.test.ts`, `src/attributes/__tests__/identity.test.ts`
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`
- Modify (stubs only): `android/BugseeModule.java`, `ios/BugseeModule.mm`

**TurboModule additions (exact):**

```ts
setAttributeString(name: string, value: string): Promise<void>;
setAttributeNumber(name: string, value: number): Promise<void>;
setAttributeBoolean(name: string, value: boolean): Promise<void>;
getAttribute(name: string): Promise<UnsafeObject>;   // {} when absent, else { value }
getAllAttributes(): Promise<UnsafeObject>;           // {} when none
clearAttribute(name: string): Promise<void>;
clearAllAttributes(): Promise<void>;
setUserIdentifier(identifier: string): void;         // never ''; JS maps '' to clear
getUserIdentifier(): Promise<UnsafeObject>;          // {} when absent, else { value }
clearUserIdentifier(): void;
```

**Public JS API (exact):**

```ts
// src/attributes/errors.ts
export const AttributeErrorCode = {
  BadArgument: 'E_ATTRIBUTE_BAD_ARGUMENT',
  Rejected: 'E_ATTRIBUTE_REJECTED',
} as const;
export class BugseeAttributeError extends Error {
  readonly code: (typeof AttributeErrorCode)[keyof typeof AttributeErrorCode];
}
// src/attributes/validate.ts
export type AttributeValue = string | number | boolean;
export type AttributeReadValue = string | number | boolean | string[]; // string[]: a Set<String> native code set on Android
export const ATTRIBUTE_STRING_MAX_LENGTH = 1024;
// the numeric bound is BUNDLE_NUMBER_LIMIT, imported from src/data/validate.ts
// facade
setAttribute(name: string, value: AttributeValue): Promise<void>;
getAttribute(name: string): Promise<AttributeReadValue | undefined>;
getAllAttributes(): Promise<Record<string, AttributeReadValue>>;
clearAttribute(name: string): Promise<void>;
clearAllAttributes(): Promise<void>;
setUserIdentifier(identifier: string): void;     // TypeError on non-string; '' clears
getUserIdentifier(): Promise<string | undefined>;
clearUserIdentifier(): void;
```

- Validation failures in the promise methods **reject** with `BugseeAttributeError` code `E_ATTRIBUTE_BAD_ARGUMENT`, without crossing. They never throw synchronously.
- A native rejection with code `E_ATTRIBUTE_REJECTED` surfaces as `BugseeAttributeError` with that code.
- A non-string or empty `name` is `E_ATTRIBUTE_BAD_ARGUMENT`.
- Export `AttributeErrorCode`, `BugseeAttributeError`, `AttributeValue` and `AttributeReadValue` from `src/index.ts`.
- **Document on `setAttribute`:** attributes persist across launches; Android stores fractional numbers as 32-bit floats (so `0.1` reads back as `0.10000000149011612`, as the report carries it); iOS drops a value whose archived size exceeds about 1.1 KB. In practice a string of up to ~800 ASCII characters is safe on both platforms; Android accepts up to 1024 UTF-16 units. Don't state an exact iOS cutoff (Task 5.5 found the SDK's own observed drop threshold does not match its archive math's predicted crossover).

**Stubs:** every promise method resolves `{}` or `undefined`, and the void methods are no-ops. Each stub is commented `Task 5.2` or `Task 5.3`.

- [ ] **Red**
  - `attributes.test.ts`:
    - `a string goes to setAttributeString`;
    - `a number goes to setAttributeNumber`;
    - `a boolean goes to setAttributeBoolean`;
    - `rejects NaN, Infinity and -Infinity with E_ATTRIBUTE_BAD_ARGUMENT before crossing`;
    - `rejects ±2^63 and accepts ±9223372036854774784` (the largest double below 2^63);
    - `accepts ±9007199254740991`;
    - `accepts a 1024-unit string and rejects 1025`;
    - `counts UTF-16 units, not code points` (512 emoji = 1024 units accepted; 513 rejected);
    - `rejects null, undefined, an array, an object and a bigint`;
    - `rejects an empty or non-string name`;
    - `a native E_ATTRIBUTE_REJECTED surfaces as BugseeAttributeError`;
    - `getAttribute unwraps {value} and maps {} to undefined`;
    - `getAllAttributes maps a native {} to {}`;
    - `clearAttribute validates the name`;
    - `AttributeErrorCode values are exactly the two stable strings`.
  - `identity.test.ts`:
    - `setUserIdentifier forwards a non-empty string`;
    - `setUserIdentifier('') clears instead`;
    - `setUserIdentifier rejects a non-string with TypeError before crossing`;
    - `getUserIdentifier maps {} and {value: ''} to undefined`;
    - `clearUserIdentifier forwards`.
  - Run → FAIL.
- [ ] **Green** — the modules, the mock and the stubs. `ios-spec-coverage`, `check-rn-compat.sh 0.81` and both example builds green.
- [ ] **Mutate**
  - (1) Make the number bound `<=` instead of `<`. `rejects ±2^63` must fail.
  - (2) Forward `''` to `setUserIdentifier`. `setUserIdentifier('') clears instead` must fail.
  - (3) Measure strings with `[...value].length`. `counts UTF-16 units` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(attributes): attributes and user identity, validated in JS, bridge stubbed`.

---

### Task 5.2 — Attributes and identity: Android bridge

**Files:**
- Create: `android/AttributeBridge.java`, `androidTest/AttributeBridgeTest.java`
- Modify: `android/BugseeModule.java` (replace the 5.1 stubs)

**Interface (plain Java, JVM-testable):**

```java
final class AttributeBridge {
    static final long MAX_SAFE_LONG = 9_007_199_254_740_991L;
    interface Sdk {                                          // prod adapter: Bugsee.*
        void set(String name, Serializable value);
        @Nullable Object getInMemory(String name);           // Bugsee.getAttribute
        @Nullable Map<String, Serializable> getPersisted();  // Bugsee.getAllAttributes
    }
    static Serializable numberValue(double v);   // integral && |v| <= MAX_SAFE_LONG -> Long (-0.0 -> 0L); else Double
    static boolean setAndVerify(Sdk sdk, String name, Serializable value);  // set, then getInMemory(name).equals(value)
    static Map<String, Object> readable(@Nullable Map<String, Serializable> persisted);
        // String, Boolean as-is; Float -> (double) f.floatValue() widened; other Number -> doubleValue();
        // Set<?> -> List<String> of its String elements; anything else dropped (logged once at BugseeRN)
    static @Nullable Object readOne(Sdk sdk, String name);  // readable(getPersisted()).get(name)
    static @Nullable String identifier(@Nullable String raw);  // null or "" -> null
}
```

**Module:**
- `setAttribute*` → `setAndVerify`. It resolves on `true` and rejects `E_ATTRIBUTE_REJECTED` (message names the attribute) on `false`.
- `getAttribute` resolves a `WritableMap` with a `value` key (`putString`/`putBoolean`/`putDouble`/`putArray`) or empty.
- `getAllAttributes` converts `readable(...)` into a `WritableMap`.
- `clearAttribute` → `Bugsee.clearAttribute(name)`, then resolve. `clearAllAttributes` → `Bugsee.clearAllAttributes()`, then resolve.
- `setUserIdentifier` → `Bugsee.setUserIdentifier(id)`. `getUserIdentifier` resolves `{ value }` only when `identifier(...)` is non-null. `clearUserIdentifier` → `Bugsee.clearUserIdentifier()`.
- Any `RuntimeException` in a promise method rejects `E_ATTRIBUTE_REJECTED`.

- [ ] **Red** — `AttributeBridgeTest`:
  - `integralNumbersBecomeLong` (`42.0`, `-7.0`, `2147483648.0` and `9007199254740991.0` become the matching `Long`);
  - `negativeZeroBecomesLongZero`;
  - `fractionalNumbersStayDouble` (`1.5`);
  - `integralBeyondTheSafeRangeStaysDouble` (`2^60`);
  - `verifiedWhenTheSdkKeepsTheValue`;
  - `rejectedWhenTheSdkDropsTheValue` (the fake ignores `set`);
  - `rejectedWhenTheSdkKeepsAnOlderValue`;
  - `readableWidensAFloatExactlyAsTheReportWritesIt` (`0.1f` → `0.10000000149011612`, which is `Double.toString((double) 0.1f)`);
  - `readableKeepsALongIntegral`;
  - `readableTurnsAStringSetIntoAList`;
  - `readableDropsUnknownTypes`;
  - `readOneReadsThePersistedCopyNotTheMemoryCopy` (memory `Double 0.1`, persisted `Float 0.1f` → the widened value);
  - `emptyIdentifierReadsAsAbsent`.
  - Run → FAIL.
- [ ] **Green** — the class and the module. The Android example builds.
- [ ] **Mutate**
  - (1) Send every number as `Double`. `integralNumbersBecomeLong` must fail.
  - (2) Skip the verification (return `true`). `rejectedWhenTheSdkDropsTheValue` must fail.
  - (3) Make `readOne` read `getInMemory`. `readOneReadsThePersistedCopyNotTheMemoryCopy` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(android): attributes by value with read-back verification, and identity`.

---

### Task 5.3 — Attributes and identity: iOS bridge

**Files:**
- Create: `support/BGSRNAttributes.m`, `support/include/BGSRNAttributes.h`, `supportTests/BGSRNAttributesTests.m`
- Modify: `ios/BugseeModule.mm` (replace the stubs; both import branches)

**Interface.** The Support package links no SDK, so the SDK arrives as blocks:

```objc
FOUNDATION_EXPORT const NSInteger BGSRNAttributeArchiveLimit;   // 1124, mirrors CUSTOM_ATTRIBUTE_SIZE_LIMIT
@interface BGSRNAttributes : NSObject
+ (BOOL)setValue:(id)value forKey:(NSString *)key
          setter:(BOOL (^)(NSString *key, id value))setter
          getter:(id _Nullable (^)(NSString *key))getter;       // YES only if getter(key) isEqual: value afterwards
+ (NSDictionary<NSString *, id> *)readable:(nullable NSDictionary *)raw;  // NSString; NSNumber (CFBoolean kept); NSArray of NSString; else dropped
+ (nullable NSString *)identifier:(nullable NSString *)raw;              // nil/@"" -> nil
@end
```

**Module (each inside `BGSRNRunOnMain`):**
- `setAttributeString` passes the `NSString`.
- `setAttributeNumber` passes `@(value)`: iOS stores a double exactly, so no integral conversion is needed.
- `setAttributeBoolean` passes `BGSRNBoolNumber(value)` (Task 4.2).
- Each uses `setter = ^(k, v){ return [Bugsee setAttribute:k withValue:v]; }` and `getter = ^(k){ return [Bugsee getAttribute:k]; }`. `NO` rejects `E_ATTRIBUTE_REJECTED`.
- `getAttribute`/`getAllAttributes` go through `readable:`.
- The clear methods call `clearAttribute:`/`clearAllAttributes`.
- `setUserIdentifier:`, `getUserIdentifier` (through `identifier:`) and `clearUserIdentifier` call their SDK counterparts.

- [ ] **Red** — `BGSRNAttributesTests`:
  - `testVerifiedWhenTheStoreKeepsTheValue`;
  - `testRejectedWhenTheSetterSaysYesButTheStoreDroppedIt` (iOS's size path);
  - `testRejectedWhenTheStoreKeepsAnOlderValue`;
  - `testReadableKeepsBooleansAsCFBooleans`;
  - `testReadableTurnsAStringArrayIntoAnArray`;
  - `testReadableDropsUnknownTypes` (`NSDate`, `NSData`);
  - `testEmptyIdentifierReadsAsAbsent`;
  - `testAn800CharacterAsciiStringFitsTheArchiveLimit`;
  - `testA900CharacterAsciiStringExceedsTheArchiveLimit`;
  - `testA1024CharacterAsciiStringExceedsTheArchiveLimit`.

  The last three pin, with `NSKeyedArchiver archivedDataWithRootObject:requiringSecureCoding:NO`, the fact Task 5.5 depends on. If any fails, stop and report; do not change 5.5's expectations inside this task. Run → FAIL.

  **Correction (controller ruling, 2026-09-29):** Task 5.3's first pass used `testA900CharacterAsciiStringFitsTheArchiveLimit` and found it FAILS on current iOS Foundation (measured 1186 bytes at 900 characters, over the 1124-byte limit) -- the crossover is nearer 838 characters. The test names and lengths above are the corrected ones; see the Phase 5 verified facts above and the Task 5.4/5.5 table below, both updated to match.
- [ ] **Green** — the class and the module. The iOS example builds on both delivery paths.
- [ ] **Mutate**
  - (1) Return `YES` from `setValue:…` without reading back. `testRejectedWhenTheSetterSaysYesButTheStoreDroppedIt` must fail.
  - (2) Map booleans through `@((int)b)` in `readable:`. `testReadableKeepsBooleansAsCFBooleans` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(ios): attributes with read-back verification, and identity`.

---

### Task 5.4 — Device verification, Android: attributes and identity round-trip, in the report

**Files:** create `scenarios/attributes.ts` (scenarios `attributes` and `attributes-persist`) and `e2e/attributes.test.ts`; modify `App.tsx`.

**Scenario `attributes`** (after `Launched`; every step awaited in order, and every result logged as `BUGSEE_E2E attr <label> <json>`):
1. **Precondition:** `clearAllAttributes()` and `clearUserIdentifier()`, then log `getAllAttributes()` and `getUserIdentifier()`. The test asserts `{}` and `undefined`. Identity is persistent (and on iOS lives in the Keychain), so a stale value from an earlier run would otherwise pass.
2. Set each row of the table below. Log `resolved` or the rejection `code`, then `getAttribute(name)` with its `typeof`.
3. `clearAttribute('e2e_neg')`, then log `getAttribute('e2e_neg')`.
4. Log `getAllAttributes()`.
5. `setUserIdentifier('e2e-user-<n>')` and log the get. `setUserIdentifier('')` and log the get. `setUserIdentifier('e2e-user-<n>')` again.
6. `Bugsee.upload('attrs-<n>', '')`.

| name | value sent | Android: set / read back | iOS: set / read back |
|---|---|---|---|
| `e2e_str` | `'blue-<n>'` | resolves / `'blue-<n>'` | resolves / `'blue-<n>'` |
| `e2e_empty` | `''` | resolves / `''` | resolves / `''` |
| `e2e_int` | `42` | resolves / `42` | resolves / `42` |
| `e2e_neg` | `-7` | resolves / `-7` | resolves / `-7` |
| `e2e_int64` | `2147483648` | resolves / `2147483648` | resolves / `2147483648` |
| `e2e_safe` | `9007199254740991` | resolves / `9007199254740991` | resolves / `9007199254740991` |
| `e2e_half` | `1.5` | resolves / `1.5` | resolves / `1.5` |
| `e2e_tenth` | `0.1` | resolves / `0.10000000149011612` | resolves / `0.1` |
| `e2e_true` | `true` | resolves / `true` (boolean) | resolves / `true` (boolean) |
| `e2e_false` | `false` | resolves / `false` (boolean) | resolves / `false` (boolean) |
| `e2e_mid` | `'m'.repeat(800)` | resolves / same | resolves / same |
| `e2e_long` | `'x'.repeat(1024)` | resolves / same | rejects `E_ATTRIBUTE_REJECTED` / `undefined` |
| `e2e_too_long` | `'x'.repeat(1025)` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` |
| `e2e_huge` | `3.5e38` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` |
| `e2e_over_long` | `1e19` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` | rejects `E_ATTRIBUTE_BAD_ARGUMENT` |

**Correction (controller ruling, 2026-09-29, after Task 5.5):** the table no longer has a 900-character row. Task 5.5 found the published `7.0.0-beta3` binary *keeps* a 900-character ASCII string, contradicting both the archive math's ~838-character predicted crossover and the SDK source's own archive-size check (`BGSBugseeEnvironment setAttributeForKey:value:`, which does reject an archive over 1124 bytes, and a 900-character string's archive independently measures over that limit). That 800-1024 band is ambiguous on the real device; the iOS SDK team has been asked why. `e2e_mid` (800: both platforms keep it) and `e2e_long` (1024: Android keeps it, iOS rejects it) still pin the two ends the SDK source's math and the device agree on.

**Scenario `attributes-persist`** (a fresh process, the next run): log `getAllAttributes()` and `getUserIdentifier()`; then `clearAllAttributes()` and `clearUserIdentifier()`; then log both again.

**Cases (`e2e/attributes.test.ts`):**
1. `every accepted type reads back as the report will carry it` — the platform's column of the table, compared with `===` and `typeof`.
2. `a cleared attribute is gone` — `e2e_neg` reads `undefined` and is absent from `getAllAttributes`.
3. `the retained report carries the attributes and the identifier`
   - `manifest.json` `attrs` has every resolved row except `e2e_neg`, with the platform's read-back value and JSON type. On Android, `e2e_tenth` is the JSON number `0.10000000149011612`.
   - `request.json` `email` is `e2e-user-<n>`.
   - **Correction (controller ruling, 2026-09-29, after Task 5.5):** confirmed an iOS SDK regression, fixed upstream in https://github.com/bugsee/bugsee-cocoa/pull/164 (base `nextgen`; no separate issue). Root cause: nextgen lacked Android's `initializeReport`, so global attributes and the identifier were never copied into a new report (`BGSManifestCreator.userAttributes` is legacy and unused on this path). So a live `Bugsee.upload()` report's `manifest.attrs`/`request.json` `email` never carry the global attributes or identifier on iOS 7.0.0-beta3, even though `getAttribute`/`getAllAttributes`/`getUserIdentifier` all read them back correctly beforehand. This case's `manifest.attrs`/`email` assertions run as `it.failing` on iOS only (a normal `it` on Android) until fixed. A bundle's existence and identity (`request.summary === \`attrs-<n>\``) are asserted separately, in a plain `it` that is never `.failing`, so a harness regression cannot be swallowed as the known SDK bug -- see Task 5.5's report for the raw evidence.
4. `an empty identifier clears it` — the get after `setUserIdentifier('')` is `undefined`.
5. `attributes and identity survive a restart, and clearing them sticks`
   - The `attributes-persist` run's first log equals case 1's final `getAllAttributes()` and identifier.
   - Its second log is `{}` and `undefined`.

Use no real user data anywhere. The Android SDK logs these values to its internal log (`bugsee-android#186`); they are synthetic.

- [ ] **Red/Green** — all five cases pass on the WOD_LX1.
- [ ] **Mutate** — temporarily make Android send every number as `Double`. Case 1 must fail on `e2e_safe` (`9007199254740992`). Revert and record.
- [ ] **Commit** — `test(e2e): attributes and identity round-trip on Android`.

---

### Task 5.5 — Device verification, iOS (simulator)

The Task 5.4 cases apply unchanged, using the iOS column of the table.
- **The precondition matters more here:** the Keychain survives app reinstalls on a physical device, and survives until the device is erased on a simulator.
- The iOS `e2e_long` rejection is SDK behaviour, pinned by `testA1024CharacterAsciiStringExceedsTheArchiveLimit` (`testAn800CharacterAsciiStringFitsTheArchiveLimit` is the matching `e2e_mid` acceptance). These tests pin the archive math of the mirrored `BGSRNAttributeArchiveLimit` constant, not the SDK's observed on-device behaviour -- see the `e2e_900` correction above.
- Case 3's `manifest.attrs`/`email` assertions are `it.failing` on iOS (see the case-3 correction above) -- confirm they are failing for the right reason (an empty `manifest.attrs`, no `email` key) before treating the suite as green.

- [ ] **Red/Green** — all five cases pass on the simulator, including the iOS `it.failing` case (which passes because its assertions correctly fail).
- [ ] **Mutate** — temporarily return `YES` from `BGSRNAttributes setValue:…` without reading back. The `e2e_long` row must fail (confirm from the raw `set:`/`get:` markers if an earlier row in the same loop already fails first). Revert and record.
- [ ] **Commit** — `test(e2e): attributes and identity round-trip on iOS`.

**Hardware pass: add to Task 3.H** — Task 5.5 on a physical iPhone, including case 5 across a real process restart. Clear the Keychain identity first and last. Re-check case 3's `manifest.attrs`/`email` (the `it.failing` case) on hardware and again after the next iOS beta; remove `.failing` once the RN pin moves to an iOS beta containing https://github.com/bugsee/bugsee-cocoa/pull/164.

---

### Task 5.T — Phase 5 pre-merge fixes from the gate (done)

Added by controller ruling: the Phase 5 gate passed, marking three items "fix before merge". Commits `52e5a0c`..`ca33c5f`. `src/attributes/validate.ts` and `src/data/validate.ts`'s number-rejection messages no longer echo the rejected value — a magnitude near `2^63` rounds under `String`/template-literal conversion (`1e19` printed as `10000000000000000000`, and `2^63` itself as `9223372036854776000`), so every such message now names the path and prints the bound as `BUNDLE_NUMBER_LIMIT_DECIMAL`, a new `BigInt`-derived exact decimal string, instead. Android's `AttributeBridgeTest` gained `Boolean` coverage for `setAndVerify` and `readable` (previously untested, though already correct — confirmed by mutation: deleting `readable`'s `|| value instanceof Boolean` now fails a test), and iOS's `BGSRNAttributesTests` gained a plain-number case proving `@(42)`/`@(1.5)` verify and read back as `NSNumber`, not silently taking the `CFBoolean` identity path. `NativeBugsee.ts`'s stale claim that Android's `getAttribute` reads the in-memory copy is corrected to the persisted copy (`AttributeBridge.readOne`), matching the code and the Phase 5 ruling.

- [x] No number-rejection message in `src/attributes/` or `src/data/validate.ts`'s event/trace paths echoes the rejected value; the pinned-message tests are updated and a `1e19` case pins the no-echo rule.
- [x] Android `AttributeBridgeTest` and iOS `BGSRNAttributesTests` cover the `Boolean`/plain-number gaps the gate found.
- [x] `NativeBugsee.ts`'s `getAttribute` doc names the persisted copy, not the in-memory one.

---

### Phase 5 review gate

The reviewer must independently:
- run all unit, JVM, XCTest and mutation suites;
- confirm by reading the code that every accepted JS type has a round-trip case on both platforms (unit, and device case 1);
- confirm that no path reports success for a value the SDK dropped;
- confirm that no test reads `log.internal`;
- **rerun** 5.4 and 5.5.

---

## Phase 6 — Privacy

**Ships:**
- `startBlackout`, `endBlackout`, `isBlackout` and `captureViewHierarchy`;
- `<BugseeSecure>`, which replaces 6.x `toggleProtected`;
- the `vh` data request, answered by a JS view tree;
- `Bugsee.wrap(Root)`, the root anchor the view tree needs.

### Rulings (controller, 2026-09-29)

- **Ruling:** Phase 6 starts after Phase 5's gate.
- **Ruling:** `<BugseeSecure>` registers secure rectangles through the existing 3.3 store (`setSecureRectangles` → `SecureRectangleStore` / `BGSRNSecureRectangles`) and disposes of them on unmount.
- **Ruling:** the `vh` data request is implemented. The JS view tree is sent within the 500 ms budget, with privacy per spec: no text content, and no free-text labels on nodes marked secure. `bounds` are `[x, y, w, h]` in **screen** coordinates in each platform's unit: Android pixels, through the same display-offset conversion as B1; iOS points.
- **Ruling:** a blackout device test defines what is observable in a bundle and asserts it: the video, the screenshot, the view tree and the `capture` trace.
- **Ruling:** anything the simulator cannot show becomes an explicit gated case on the hardware-pass list (Task 3.H), never an either-path assertion.

### Planner decisions (reviewable)

- **Root discovery is explicit: `Bugsee.wrap(Root)`.**
  - React Native offers no public way to enumerate mounted roots. `AppRegistry.setWrapperComponentProvider` holds a single provider and has no getter, so taking it would silently drop an app's own provider. The DevTools global hook is the only other channel, and it belongs to React DevTools.
  - `wrap` renders the app's root beside a zero-size anchor `View`. From the anchor's host instance, the walk reaches the React fiber root.
  - An app that does not wrap gets `null` for every `vh` request, answered at once natively, which the spec allows ("null means nothing to contribute").
  - `wrap` is new public API not listed in design §10.1. It is chosen so later root-level features (Phase 7's boundary, Phase 9's touch breadcrumbs) can share one integration point.
- **React internals are confined to one file, `src/viewtree/fiber.ts`.**
  - It reads `__internalInstanceHandle` on a host public instance, and fiber fields (`tag`, `type`, `elementType`, `child`, `sibling`, `return`, `memoizedProps`, `stateNode`).
  - It calls `getPublicInstanceFromInternalInstanceHandle` and `measureInWindow` through `react-native/Libraries/ReactNative/RendererProxy`.
  - Verified on RN 0.81.6 and 0.87.1 (below). `check-rn-compat.sh` gains greps that fail CI when a matrix version drops any of them.
  - If the probe fails at runtime, the view tree is disabled and every request answers `null`, logged once.
- **Bounds conversion reuses B1's split.**
  - JS measures with `measureInWindow`, which is synchronous under Fabric, and scales by `secureRectangleScale()` (`PixelRatio.get()` on Android, `1` on iOS).
  - Native supplies the React root's display origin in the request event: on Android, `ReactRootOriginTracker`'s last published origin; on iOS, the key window's origin in `window.screen.coordinateSpace`.
  - JS adds the origin. Android rounds to integer pixels; iOS keeps points to 2 decimals.
- **`<BugseeSecure>` re-measures every 100 ms while mounted, with one shared timer for all instances.**
  - `onLayout` does not fire when an ancestor scrolls, so a rectangle measured only on layout goes stale and leaks the region while it moves.
  - 100 ms is well under the SDK's 2–3 pulls a second.
  - A measurement that throws keeps the last rectangle (fails closed).
  - Design §6.2 also prefers `addSecureView(nativeView)` where a component resolves to a real view. The ruling above chose the rectangle path; the residual exposure during fast scrolls (at most one re-measure interval plus the SDK's own pull lag) is recorded here for the controller. Two further residual exposures, from the 6.2 review:
    - **M5:** the first frames before the first successful measurement are unpublished. The mount measurement runs in a layout effect, so on Fabric it lands before the first paint; a measurement that fails leaves the region uncovered until one succeeds.
    - **M2 (theoretical):** the registry deduplicates on what it last sent across the bridge, not on what native accepted. If native drops a publish after the bridge call returned (it logs and keeps the previous set), an identical later union is not re-sent. JS only ever sends well-formed lists, so no current path reaches this.
    - The dedupe's one coupling with native, the Android origin refresh that rode on every JS publish, is replaced by a refresh driven from the SDK's own pull (I1, `SecureRectanglePulls`).
- **`setSecureRectangles` and `<BugseeSecure>` share one JS registry.** It keys each owner's rectangles (`manual:<display>` for `setSecureRectangles`, one token per component instance) and publishes the per-display union. It crosses the bridge only when the union changes, and the first publish always crosses. A component unmounting therefore never clears a manual set, and the reverse holds too.
- **Blackout is forwarded as the SDKs implement it, and the Android pre-launch gap is documented rather than patched.** Android's `startBlackout` is a no-op before launch (`Log.w` only); iOS honours it, failing closed. Device case 5 pins both behaviours, so a change in either SDK is caught. This is recorded for the controller as a candidate SDK issue; implementers do not file it.

### Verified facts (2026-09-29)

**Data requests today:**
- Both wrappers answer every data request with `null`, synchronously: `BugseeReactNativeWrapper.requestData` → `callback.onResult(null)`; `BugseeModule.mm` `requestDataWithType:callback:` → `[callback onResult:nil]`.

**Android `234dcddfc`:**
- `DataRequestTypes.VIEW_HIERARCHY = "vh"` and `VIEW_HIERARCHY_TIMEOUT_MS = 500`.
- `requestData` is called on main, once per display per non-best-effort pass. It carries no display id.
- A pass runs on snapshot creation (not terminating) and on `Bugsee.captureViewHierarchy()`, and never for a display under blackout.
- The #118 fix is in (`BugseeCaptureDataProviderViewHierarchy.onBeforeSnapshotCreated`): off main, the snapshot **waits** for the reply up to 500 + 250 ms. On main it does not wait, and an async reply lands in the next report.
- `startBlackout`/`endBlackout` are no-ops before launch. Each dispatches `BlackoutStarted`/`BlackoutEnded`.
- While blacked out, `ScreenCaptureScreenshot` returns a black frame and video frames are black (`processAndSendEmptyFrame`).
- The `capture` system trace carries `{state: "blackout" | "active" | "partial_blackout", displays?}`.
- Secure regions are painted `Color.BLACK`.

**iOS `74af69ee8`:**
- `requestDataWithType:callback:` is called on main. The snapshot waits 1000 ms for the main-thread walk plus up to 500 + 250 ms for the reply.
- After 3 consecutive timeouts the budget drops to 50 ms until the next start or an in-time reply.
- `startBlackout` is not gated on launch.
- While blacked out: the report screenshot is `blackReportScreenshot` (solid black), video frames are black placeholders, and no view-hierarchy pass runs.
- The `capture` trace behaves as on Android.
- `hideViewColor` is black.

**RN internals:**
- 0.81.6 (`npm pack`) and 0.87.1 (installed):
  - `RendererProxy` exports `getPublicInstanceFromInternalInstanceHandle`.
  - Both public-instance classes (`ReactFabricHostComponent`, `ReactNativeElement`) set `__internalInstanceHandle`.
  - Fabric's `measureInWindow` (`UIManagerBinding.cpp`, `NativeDOM.cpp`) invokes its callback **synchronously**, from the current shadow-tree revision.
- React 19.1 and 19.2 fiber tags: FunctionComponent 0, ClassComponent 1, HostRoot 3, HostPortal 4, HostComponent 5, HostText 6, Fragment 7, Mode 8, ContextConsumer 9, ContextProvider 10, ForwardRef 11, Profiler 12, Suspense 13, Memo 14, SimpleMemo 15, Offscreen 22, LegacyHidden 23.

**Specs:**
- The viewer does not yet parse `managed` as the SDKs write it (`wrapper-data-requests` open item 2). The payload will not render in the dashboard until the viewer changes. This does not block us; it is recorded.
- `wrapper-data-requests` says `bounds` are "physical screen pixels" while also requiring "the same coordinate space as the native tree". On iOS, the native tree is in points. The ruling and workbook 6.6 (the unit of each platform's native tree) decide: iOS uses points. A specs correction is for the controller to raise.

**Tooling:**
- `ffmpeg` and `ffprobe` are at `/opt/homebrew/bin`.
- The `jest` root config runs `ts-jest` in a node environment, and nothing in `src/` is `.tsx` yet.
- `stryker.src.json` mutates `src/**/*.ts` only.

### Constants

| Name | Value | Where | Why |
|---|---|---|---|
| `SECURE_REMEASURE_MS` | `100` | `src/secure/measureLoop.ts` | Well under the SDK's ~350 ms pull interval. |
| `VH_DATA_TYPE` | `'vh'` | JS, Android, iOS | `DataRequestTypes.VIEW_HIERARCHY`; the Android test pins the equality. |
| `DATA_REQUEST_DEADLINE_MS` | `450` | Android `DataRequestBridge`, iOS `BGSRNDataRequestDeadlineMs` | Below the SDK's 500 ms; the Android test pins `< VIEW_HIERARCHY_TIMEOUT_MS`. |
| `VH_WALK_BUDGET_MS` | `250` | `src/viewtree/walk.ts` | Leaves at least 200 ms for JS-thread queueing and two bridge hops. |
| `VH_MAX_NODES` | `2000` | walk | Bounds CPU and payload size. |
| `VH_MAX_DEPTH` | `64` | walk | Android's own native walk cap. |
| `VH_TAG_MAX_LENGTH` | `99` | walk | Android emits `tag` only when shorter than 100 characters. |
| `VH_IOS_DECIMALS` | `2` | walk | Points, rounded for a compact payload. |
| `VH_FIBER_VISIT_BUDGET` | `VH_MAX_NODES * 8` (16 000) | walk (internal, not exported) | Bounds total fibers *visited* (not just emitted), so a wide fan-out or long transparent chain under a frozen clock still stops even though the iterative walk can no longer overflow the stack. Added during Task 6.3's review round 1 (I6); flagged there as a real cap a large screen could hit before `VH_MAX_NODES` (2000) does. |
| `VH_ANCHOR_NATIVE_ID` | `'__bugsee_view_tree_anchor'` | `src/viewtree/anchor.tsx` | Lets the walk skip the anchor. |
| `LUMA_DARK_MAX` / `LUMA_BRIGHT_MIN` | `24` / `150` | `e2e/media.ts` | Limited-range black is Y≈16, white is Y≈235. |
| `BLACKOUT_MIN_DARK_S` | `1.5` | `e2e/media.ts` | The shortest dark run that counts as the blackout. |

**Log lines** (Android `Log.i("BugseeRN", …)`, iOS `NSLog(@"BugseeRN …")`); the device tests match these:
- `data request <id> type=<type> origin=<x>,<y>`
- `data request <id> completed by=<js|deadline|no-js|no-origin|unknown-type|detach|sink-threw> bytes=<n|null> ms=<elapsed>`

Here `<id>` is `dr-<counter>` and `ms` is measured from the moment `requestData` was entered.

### The `vh` payload (exact)

A single JSON object, the synthetic root. Keys appear in this order: `id`, `class_name`, `bounds`, `options`, `subitems`, `truncated`. Absent keys are omitted, never `null`.

| key | type | presence | meaning |
|---|---|---|---|
| `id` | string | always | Preorder index within this snapshot: `"0"` is the root. Never a React `key` (keys are free text). |
| `class_name` | string | always | Root `"ReactNative"`. Surface `"ReactSurface"`. Host: the host type (`fiber.type`, e.g. `"RCTView"`). Composite: `type.displayName`, else `type.name`, else `"Anonymous"`; ForwardRef and Memo unwrap to the inner component's name. |
| `bounds` | number[4] | always | `[x, y, w, h]`, screen coordinates. Android: integer display pixels, `Math.round(v·scale) + origin`. iOS: points, rounded to 2 decimals, plus the origin. A composite, surface or root takes the union of its emitted children. |
| `options.kind` | string | always | `"root"`, `"surface"`, `"composite"` or `"host"`. |
| `options.secure` | `true` | when true | This node or an ancestor is a `<BugseeSecure>`. |
| `options.tag` | string | host nodes, not secure, `testID` a string of length ≤ 99 | The `testID`, like Android's `options.tag`. |
| `options.native_id` | string | same rule, for `nativeID` | |
| `subitems` | node[] | when non-empty | Emitted children. |
| `truncated` | `true` | when true | The walk stopped here with children unvisited (depth, node cap or budget). The root also carries it when any node does. |

**Never emitted:**
- `HostText` fibers (text content) and any other prop — the walk reads `testID` and `nativeID` only, pinned by a test;
- a hidden `Offscreen` or `LegacyHidden` subtree;
- a subtree with no measurable host node;
- the `Bugsee.wrap` component and its anchor.

**Flattened (their children are promoted):** HostRoot, HostPortal, Fragment, Mode, ContextConsumer, ContextProvider, Profiler, Suspense and any unknown tag.

```json
{"id":"0","class_name":"ReactNative","bounds":[0,0,1080,2340],"options":{"kind":"root"},
 "subitems":[{"id":"1","class_name":"ReactSurface","bounds":[0,0,1080,2340],"options":{"kind":"surface"},
  "subitems":[{"id":"2","class_name":"App","bounds":[0,0,1080,2340],"options":{"kind":"composite"},
   "subitems":[{"id":"3","class_name":"RCTView","bounds":[0,0,1080,2340],"options":{"kind":"host","tag":"home"}},
    {"id":"4","class_name":"BugseeSecure","bounds":[79,788,394,158],"options":{"kind":"composite","secure":true},
     "subitems":[{"id":"5","class_name":"RCTView","bounds":[79,788,394,158],"options":{"kind":"host","secure":true}}]}]}]}]}
```

**Sources.**
- The node table in `bugsee/specs` `sdk/wrapper-data-requests` §Payload (`class_name`, `bounds`, `id`, `subitems`, `options`), which describes what the viewer reads (`RecordingViewTreeNode`).
- The Android view-node names from `sdk/reporting/platforms/android.md` (`options.tag`, `options.secure`, node-level `truncated`).
- The privacy rules from `sdk/reporting/bundle/viewtree.md` §Privacy.
- The spec's open item 5 says this table is "as observed" and to be confirmed with the viewer owners once a second producer exists. That confirmation is for the controller.

---

### Task 6.1 — Blackout and `captureViewHierarchy`: facade and both bridges

**Files:**
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`, `android/BugseeModule.java`, `ios/BugseeModule.mm`
- Create: `src/__tests__/blackout.test.ts`

**TurboModule additions (exact):**

```ts
startBlackout(): void;
endBlackout(): void;
isBlackout(): Promise<boolean>;
captureViewHierarchy(): void;
```

The facade methods have the same names and signatures. Document on `startBlackout`:
- it suppresses the video (black frames), the report screenshot (black), touches and the view hierarchy, while logs, network, events and traces continue (design §4.1);
- **Android ignores it before `launch()`**, while iOS honours it; call it after `launch()` resolves when it must hold on both;
- `isBlackout()` verifies.

On Android, the methods call `Bugsee.startBlackout()`, `endBlackout()`, `isBlackout()` and `captureViewHierarchy()`. On iOS, the same calls run inside `BGSRNRunOnMain`, and `isBlackout` resolves `@([Bugsee isBlackout])` there.

- [ ] **Red** — `blackout.test.ts`:
  - `startBlackout forwards`;
  - `endBlackout forwards`;
  - `isBlackout resolves what native reports` (true and false);
  - `captureViewHierarchy forwards`;
  - `startBlackout never calls endBlackout` (call counts).
  - Run → FAIL.
- [ ] **Green** — as specified; spec coverage and both builds green.
- [ ] **Mutate** — make the facade's `startBlackout` call `endBlackout`. `startBlackout forwards` must fail. Revert and record.
- [ ] **Commit** — `feat(privacy): blackout and captureViewHierarchy on both platforms`.

---

### Task 6.2 — `<BugseeSecure>` and the shared secure-rectangle registry

**Files:**
- Create: `src/secure/registry.ts`, `src/secure/measureLoop.ts`, `src/secure/BugseeSecure.tsx`
- Create tests: `src/secure/__tests__/registry.test.ts`, `src/secure/__tests__/measureLoop.test.ts`, `src/secure/__tests__/BugseeSecure.test.tsx`
- Modify: `src/index.ts` (`setSecureRectangles` goes through the registry; export `BugseeSecure` and `BugseeSecureProps`)
- Tooling: root `package.json` devDependencies `react@19.2.3`, `react-test-renderer@19.2.3` and `@types/react@^19.2.0` (the versions `examples/bare` resolves); `tsconfig.base.json` `"jsx": "react-jsx"`; `stryker.src.json` `mutate` adds `packages/react-native/src/**/*.tsx`; `scripts/check-rn-compat.sh` typechecks `tscheck/**/*.tsx` too and installs `@types/react@19`

**Interfaces (exact):**

```ts
// src/secure/registry.ts
export type SecureOwner = object | `manual:${number}`;
export function setOwnerRectangles(owner: SecureOwner, display: number, rectangles: readonly SecureRectangle[]): void;
export function clearOwner(owner: SecureOwner): void;
// publishes, per affected display, flattenSecureRectangles(union in owner-insertion order, secureRectangleScale())
// via NativeBugsee.setSecureRectangles, only when the flat list differs from the last one published for that display.
// Validation (flattenSecureRectangles) runs BEFORE the owner's entry changes: an invalid call changes nothing.

// src/secure/measureLoop.ts
export const SECURE_REMEASURE_MS = 100;
export function addMeasurer(measure: () => void): () => void;  // one shared setInterval while >= 1 measurer

// src/secure/BugseeSecure.tsx
export interface BugseeSecureProps extends ViewProps { enabled?: boolean; children?: React.ReactNode; }
export function BugseeSecure(props: BugseeSecureProps): React.ReactElement;
```

`BugseeSecure` is a plain function component: no `memo`, no `forwardRef`. The view-tree walk identifies it by identity. It behaves as follows:
- It renders `<View {...rest} ref={ref} collapsable={false} onLayout={…}>`, calling the caller's `onLayout` too.
- While `enabled` (default `true`) and mounted, it measures on mount, on layout and on every loop tick, with `ref.current.measureInWindow((x, y, width, height) => setOwnerRectangles(token, 0, [{ x, y, width, height }]))`.
- If `measureInWindow` throws, the last rectangle stands and the error is logged once (`console.warn('[Bugsee] BugseeSecure could not measure', e)`).
- On unmount, or on `enabled` becoming `false`, it calls `clearOwner(token)` and removes its measurer.

`Bugsee.setSecureRectangles(rects, display)` keeps its signature and validation, and becomes `setOwnerRectangles(\`manual:${display}\`, display, rects)`.

- [ ] **Red**
  - `registry.test.ts`:
    - `a manual set and a component region coexist on display 0`;
    - `clearing an owner republishes the rest`;
    - `an unchanged union does not cross the bridge again`;
    - `the first publish always crosses, even when empty`;
    - `a manual set on display 2 leaves display 0 alone`;
    - `an invalid rectangle changes nothing and publishes nothing`.
  - `measureLoop.test.ts` (fake timers):
    - `one interval serves every measurer`;
    - `the interval stops when the last measurer leaves`;
    - `ticks every 100 ms`.
  - `BugseeSecure.test.tsx` (react-test-renderer; `react-native` mocked with `View: 'View'`, `PixelRatio.get = () => 2`, `Platform.OS = 'android'`; `createNodeMock` returns `{ measureInWindow }`):
    - `registers its measured rectangle on mount, scaled for Android`;
    - `re-measures on every tick while mounted`;
    - `removes its rectangle on unmount`;
    - `enabled={false} removes its rectangle and stops measuring`;
    - `a throwing measureInWindow keeps the last rectangle`;
    - `calls the caller's onLayout`;
    - `renders a non-collapsable View with the caller's props`.
  - The existing `secure/__tests__/facade.test.ts` stays green unchanged.
  - Run → FAIL.
- [ ] **Green** — the modules and the tooling. `yarn test`, `yarn mutate:src` (now including `.tsx`) and `check-rn-compat.sh 0.81` green.
- [ ] **Mutate**
  - (1) Skip `clearOwner` in the unmount cleanup. `removes its rectangle on unmount` must fail.
  - (2) Measure only on layout (no loop). `re-measures on every tick while mounted` must fail.
  - (3) Clear the owner when `measureInWindow` throws. `a throwing measureInWindow keeps the last rectangle` must fail.
  - (4) Replace the owner map with a single slot. `a manual set and a component region coexist` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(privacy): <BugseeSecure>, measured continuously, disposed on unmount`.

---

### Task 6.3 — The view-tree walk (JS, pure) and the internals guard

**Files:**
- Create: `src/viewtree/fiber.ts`, `src/viewtree/walk.ts`
- Create tests: `src/viewtree/__tests__/walk.test.ts`, `src/viewtree/__tests__/fiber.test.ts`, `src/viewtree/__tests__/fakeFibers.ts` (a builder for fake fiber trees)
- Modify: `scripts/check-rn-compat.sh`, adding the internals greps below

**Interfaces (exact):**

```ts
// src/viewtree/fiber.ts -- the ONLY module that reads React or RN internals
export const FiberTag = { FunctionComponent: 0, ClassComponent: 1, HostRoot: 3, HostPortal: 4,
  HostComponent: 5, HostText: 6, Fragment: 7, Mode: 8, ContextConsumer: 9, ContextProvider: 10,
  ForwardRef: 11, Profiler: 12, Suspense: 13, Memo: 14, SimpleMemo: 15, Offscreen: 22, LegacyHidden: 23 } as const;
export interface FiberLike { tag: number; type: unknown; elementType?: unknown; child: FiberLike | null;
  sibling: FiberLike | null; return: FiberLike | null; memoizedProps: unknown; stateNode: unknown; }
export interface WindowRect { x: number; y: number; width: number; height: number; }
/** __internalInstanceHandle -> walk .return to HostRoot -> its stateNode (the FiberRoot); null if any step is missing. */
export function fiberRootOf(publicInstance: unknown): { current: FiberLike } | null;
/** RendererProxy.getPublicInstanceFromInternalInstanceHandle(fiber).measureInWindow(cb);
 *  null unless the callback ran synchronously with four finite numbers. Never throws. */
export function measureHostFiber(fiber: FiberLike): WindowRect | null;

// src/viewtree/walk.ts -- pure; no import of react or react-native
export const VH_WALK_BUDGET_MS = 250, VH_MAX_NODES = 2000, VH_MAX_DEPTH = 64, VH_TAG_MAX_LENGTH = 99, VH_IOS_DECIMALS = 2;
export interface ManagedNode { id: string; class_name: string; bounds: [number, number, number, number];
  options: { kind: 'root' | 'surface' | 'composite' | 'host'; secure?: true; tag?: string; native_id?: string };
  subitems?: ManagedNode[]; truncated?: true; }
export interface WalkEnv {
  measure(fiber: FiberLike): WindowRect | null;
  isSecureBoundary(fiber: FiberLike): boolean;   // type/elementType === BugseeSecure
  isWrapper(fiber: FiberLike): boolean;          // the Bugsee.wrap component or the anchor
  platform: 'android' | 'ios';
  scale: number; originX: number; originY: number;
  now(): number;                                 // ms; budget measured from the first call
}
export function buildViewTree(roots: readonly { current: FiberLike }[], env: WalkEnv): ManagedNode | null; // null when nothing emitted
```

**Internals guard (`check-rn-compat.sh`, per matrix version)** — fail with a named message unless:
- `Libraries/ReactNative/RendererImplementation.js` or `RendererProxy.js` exports `getPublicInstanceFromInternalInstanceHandle`;
- `Libraries/ReactNative/ReactFabricPublicInstance/ReactFabricHostComponent.js` and `src/private/webapis/dom/nodes/ReactNativeElement.js` both assign `__internalInstanceHandle`;
- `ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp` in the `measureInWindow` branch calls `callbackFunction.call(` (synchronous).

- [ ] **Red**
  - `walk.test.ts`:
    - `emits a ReactNative root with one ReactSurface per fiber root`;
    - `a host node's class_name is its host type`;
    - `a composite's class_name is displayName, then name, then Anonymous`;
    - `ForwardRef and Memo unwrap to the inner name`;
    - `fragments, providers, modes and portals are flattened into their parent`;
    - `HostText is never emitted`;
    - `no prop other than testID and nativeID is ever read` (`memoizedProps` is a `Proxy` recording key reads);
    - `testID becomes options.tag and nativeID options.native_id`;
    - `a testID of 100 characters is withheld`;
    - `everything under BugseeSecure is secure and carries no tag or native_id`;
    - `a composite's bounds are the union of its emitted children`;
    - `a subtree with no measurable host is dropped`;
    - `a hidden Offscreen subtree is dropped`;
    - `the wrap component and the anchor are not emitted`;
    - `Android bounds are rounded pixels plus the origin` (scale `2.625`, origin `(0, 63)`, window rect `{10.2, 20.4, 100.1, 50.3}` → `[27, 117, 263, 132]`);
    - `iOS bounds are points to two decimals plus the origin`;
    - `stops at 2000 nodes and marks truncated on the node and the root`;
    - `stops at depth 64 and marks that node truncated`;
    - `stops when the 250 ms budget runs out and marks the root truncated` (fake `now`);
    - `ids are preorder and unique`;
    - `keys serialise in the documented order` (compares `JSON.stringify` with a literal);
    - `returns null when nothing is emitted`.
  - `fiber.test.ts`:
    - `fiberRootOf walks __internalInstanceHandle up to the HostRoot's FiberRoot`;
    - `fiberRootOf is null without __internalInstanceHandle`;
    - `fiberRootOf is null when the chain never reaches a HostRoot`;
    - `measureHostFiber returns the rect a synchronous callback delivers`;
    - `measureHostFiber is null when the callback does not run synchronously`;
    - `measureHostFiber is null when the renderer throws` (`RendererProxy` mocked).
  - Run → FAIL.
- [ ] **Green** — both modules. The guard passes for 0.81 and 0.87 locally (`./scripts/check-rn-compat.sh 0.81`, `… 0.87`).
- [ ] **Mutate**
  - (1) Emit HostText as a node with `class_name: 'RCTRawText'`. `HostText is never emitted` must fail.
  - (2) Stop propagating `secure` to descendants. `everything under BugseeSecure is secure` must fail.
  - (3) Drop the origin. `Android bounds are rounded pixels plus the origin` must fail.
  - (4) Remove the budget check. `stops when the 250 ms budget runs out` must fail.
  - (5) Delete one grep from the guard, and point the guard at a copy of 0.87 with `__internalInstanceHandle` renamed. The guard must fail (run by hand; record it).
  - Revert and record.
- [ ] **Commit** — `feat(viewtree): a privacy-safe managed view tree from the fiber tree`.

---

### Task 6.4 — The `vh` request in JS: `Bugsee.wrap`, the dispatcher, spec and stubs

**Files:**
- Create: `src/viewtree/anchor.tsx`, `src/viewtree/requests.ts`
- Create tests: `src/viewtree/__tests__/requests.test.ts`, `src/viewtree/__tests__/anchor.test.tsx`
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`, `examples/bare/index.js` (`AppRegistry.registerComponent(appName, () => Bugsee.wrap(App))`), `scripts/__tests__/example-wiring.test.ts`
- Modify (stubs): `android/BugseeModule.java`, `ios/BugseeModule.mm`

**TurboModule additions (exact):**

```ts
readonly onDataRequest: EventEmitter<{
  requestId: string;   // 'dr-<n>', native-minted, never reused in a process
  type: string;        // only 'vh' today; native answers any other type itself
  originX: number;     // the React root's display origin: Android display px, iOS points
  originY: number;
}>;
replyDataRequest(requestId: string, payload: string | null): void;
setViewTreeEnabled(enabled: boolean): void;
```

**JS (exact):**

```ts
// src/viewtree/anchor.tsx
export const VH_ANCHOR_NATIVE_ID = '__bugsee_view_tree_anchor';
export function wrap<P extends object>(Root: React.ComponentType<P>): React.ComponentType<P>;
// renders <><Root {...props} /><View ref nativeID={VH_ANCHOR_NATIVE_ID} collapsable={false}
//   pointerEvents="none" style={{ position: 'absolute', width: 0, height: 0 }} /></>;
// displayName `BugseeRoot(${name})`; mount -> registerAnchor(instance); unmount -> unregisterAnchor(instance)
// src/viewtree/requests.ts
export const VH_DATA_TYPE = 'vh';
export function registerAnchor(instance: unknown): void;   // 0 -> 1: subscribe once (stays subscribed), setViewTreeEnabled(true)
export function unregisterAnchor(instance: unknown): void; // 1 -> 0: setViewTreeEnabled(false)
// on onDataRequest: payload = type === 'vh' ? JSON.stringify(buildViewTree(roots deduped by identity, env)) : null;
// any throw -> payload null, console.warn once; ALWAYS replyDataRequest(requestId, payload) exactly once, synchronously.
// facade: Bugsee.wrap = wrap
```

**Stubs:**
- `setViewTreeEnabled` and `replyDataRequest` are no-ops, commented `Task 6.5` on Android and `Task 6.6` on iOS.
- The wrappers keep answering `null`, and nothing emits `onDataRequest` yet.
- `event-emitter-wiring.test.ts` stays green; the spec now declares two emitters.

- [ ] **Red**
  - `requests.test.ts` (native mock, `buildViewTree` spied):
    - `a vh request replies the tree as JSON`;
    - `a non-vh type replies null`;
    - `no anchor mounted replies null`;
    - `a throwing walk replies null and warns once`;
    - `every request is replied to exactly once`;
    - `the origin in the request reaches the walk env`;
    - `the first anchor enables the view tree and the last disables it`;
    - `subscribes to onDataRequest once across many anchors`;
    - `two anchors in one surface walk that root once`.
  - `anchor.test.tsx`:
    - `wrap renders the root with its props`;
    - `wrap's anchor is zero-size, absolute, non-collapsable, pointerEvents none`;
    - `mounting registers and unmounting unregisters the anchor`;
    - `displayName names the wrapped root`.
  - `example-wiring.test.ts`: `the example registers Bugsee.wrap(App)`.
  - Run → FAIL.
- [ ] **Green** — the modules, the mock (`onDataRequest` subscribe, `emitDataRequest(event)`, and `jest.fn`s for `replyDataRequest` and `setViewTreeEnabled`), the stubs and the example. All gates green.
- [ ] **Mutate**
  - (1) Skip the reply when the walk throws. `every request is replied to exactly once` must fail.
  - (2) Never call `setViewTreeEnabled(false)`. `the last disables it` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(viewtree): Bugsee.wrap and the vh request in JS, bridge stubbed`.

---

### Task 6.5 — The `vh` request, Android bridge

**Files:**
- Create: `android/DataRequestBridge.java`, `androidTest/DataRequestBridgeTest.java`
- Modify:
  - `android/BugseeReactNativeWrapper.java`: `requestData` → `DataRequestBridge.shared().request(dataType, callback::onResult)`;
  - `android/ReactRootOriginTracker.java`: add `@UiThread @Nullable int[] currentOrigin()`;
  - `androidTest/ReactRootOriginTrackerTest.java`;
  - `android/BugseeModule.java`: attach and detach, emit, and the two methods.

**Interface (plain Java, JVM-testable; mirrors `ReportHandlerBridge`):**

```java
final class DataRequestBridge {
    static final String VIEW_HIERARCHY = "vh";
    static final long DEADLINE_MS = 450;
    interface Sink { void onDataRequest(String requestId, String type, int originX, int originY); }
    interface OriginSource { @Nullable int[] currentOrigin(); }        // called on the requesting (main) thread
    interface Reply { void onResult(@Nullable String data); }
    interface Scheduler { Cancellable schedule(Runnable task, long delayMs); }   // prod: one daemon thread "BugseeRN-DataRequestDeadline"
    interface Cancellable { void cancel(); }
    interface Clock { long nowMs(); }
    static DataRequestBridge shared();
    DataRequestBridge(Scheduler scheduler, Clock clock);   // package-private, for tests
    void setViewTreeEnabled(boolean enabled);
    void attach(Sink sink, OriginSource origin);
    void detach(Sink stale);                 // identity-checked; completes all outstanding with null (by=detach); disables the view tree
    void request(String type, Reply reply);  // never throws; order below
    boolean complete(String requestId, @Nullable String payload);  // true only for the call that delivered
}
```

**`request` order (each step is a test):**
1. A type other than `"vh"` → reply `null` synchronously (`by=unknown-type`).
2. No sink, or the view tree disabled → `null` synchronously (`by=no-js`).
3. `origin.currentOrigin()` is `null` → `null` synchronously (`by=no-origin`).
4. Otherwise:
   - mint `"dr-" + counter` and store `{reply, AtomicBoolean done, startMs}`;
   - arm `DEADLINE_MS` → `complete(id, null)` (`by=deadline`);
   - call the sink. A throwing sink completes with `null` (`by=sink-threw`).

`complete`:
- runs once behind the `AtomicBoolean`;
- cancels the timer and removes the entry;
- runs `reply.onResult` inside `try/catch (Throwable)`;
- logs the `completed` line.

**`ReactRootOriginTracker.currentOrigin()`:**
- calls `refresh()`;
- returns a copy of the `{x, y}` it last passed to `store.setOrigin`, kept in a field it writes there;
- returns `null` if no origin was ever published.

**Module:**
- The constructor calls `DataRequestBridge.shared().attach(this::emitRequest, originTracker::currentOrigin)`, and `invalidate()` detaches.
- `emitRequest` builds the map and calls `emitOnDataRequest`.
- `replyDataRequest(id, payload)` → `complete`.
- `setViewTreeEnabled(b)` → the bridge.

- [ ] **Red**
  - `DataRequestBridgeTest`:
    - `theTypeMatchesTheSdkConstant` (`DataRequestTypes.VIEW_HIERARCHY`);
    - `theDeadlineIsBelowTheSdkBudget` (`< DataRequestTypes.VIEW_HIERARCHY_TIMEOUT_MS`);
    - `anUnknownTypeRepliesNullSynchronously`;
    - `noSinkRepliesNullSynchronously`;
    - `aDisabledViewTreeRepliesNullSynchronously`;
    - `noOriginRepliesNullSynchronously`;
    - `theSinkGetsTheOrigin`;
    - `completeDeliversThePayloadExactlyOnce`;
    - `aSecondCompleteIsANoOp`;
    - `theDeadlineRepliesNull` (manual scheduler);
    - `completingCancelsTheDeadline`;
    - `aThrowingSinkRepliesNull`;
    - `aThrowingReplyDoesNotEscape`;
    - `detachRepliesNullToEverythingOutstandingAndDisables`;
    - `detachingAStaleSinkLeavesTheCurrentOne`;
    - `eachRequestGetsAFreshId`.
  - `ReactRootOriginTrackerTest`:
    - `currentOriginIsTheLastPublishedOrigin`;
    - `currentOriginIsNullBeforeAnyRootIsFound`.
  - Run → FAIL.
- [ ] **Green** — as specified. The example builds.
- [ ] **Mutate**
  - (1) Drop the `AtomicBoolean`. `completeDeliversThePayloadExactlyOnce` must fail.
  - (2) Set `DEADLINE_MS = 600`. `theDeadlineIsBelowTheSdkBudget` must fail.
  - (3) Emit even when disabled. `aDisabledViewTreeRepliesNullSynchronously` must fail.
  - Revert and record.
- [ ] **Commit** — `feat(android): answer the vh data request from JS, within the budget`.

---

### Task 6.6 — The `vh` request, iOS bridge

**Files:**
- Create: `support/BGSRNDataRequestBridge.m`, `support/include/BGSRNDataRequestBridge.h`, `supportTests/BGSRNDataRequestBridgeTests.m`
- Modify: `ios/BugseeModule.mm`
  - The category's `requestDataWithType:callback:` becomes `[BGSRNDataRequestBridge.shared requestType:dataType reply:^(NSString *d){ [callback onResult:d]; }]`.
  - The module attaches in `attachToBridges` and detaches in `invalidate`.
  - It gains `replyDataRequest:payload:` and `setViewTreeEnabled:`.
  - Both import branches are updated.

**Interface (mirrors 6.5):**

```objc
FOUNDATION_EXPORT NSString *const BGSRNDataRequestTypeViewHierarchy;   // @"vh"
FOUNDATION_EXPORT const int64_t BGSRNDataRequestDeadlineMs;            // 450
@interface BGSRNDataRequestBridge : NSObject
@property (class, readonly) BGSRNDataRequestBridge *shared;
- (instancetype)initWithScheduler:(id (^)(dispatch_block_t task, int64_t delayMs))schedule
                           cancel:(void (^)(id token))cancel
                            clock:(int64_t (^)(void))nowMs;
@property (atomic) BOOL viewTreeEnabled;
- (void)attach:(id)sink block:(void (^)(NSDictionary *request))block origin:(NSValue *_Nullable (^)(void))origin; // CGPoint
- (void)detach:(id)sink;
- (void)requestType:(NSString *)type reply:(void (^)(NSString *_Nullable data))reply;
- (BOOL)complete:(NSString *)requestId payload:(nullable NSString *)payload;
@end
```

- The registry is guarded by `os_unfair_lock`, and the reply always runs outside the lock.
- The module's `origin` block runs on main, where the SDK calls `requestData`. It takes the key window of the foreground-active `UIWindowScene` and returns `[NSValue valueWithCGPoint:[window convertPoint:CGPointZero toCoordinateSpace:window.screen.coordinateSpace]]`, or `nil` without one.
- The request-order rules and the log lines are the same as in 6.5.

- [ ] **Red** — `BGSRNDataRequestBridgeTests`, mirroring 6.5's names:
  - `testDeadlineIsBelowTheSdkBudget` (`< 500`);
  - `testAnUnknownTypeRepliesNilSynchronously`;
  - `testNoSinkRepliesNilSynchronously`;
  - `testADisabledViewTreeRepliesNilSynchronously`;
  - `testNoOriginRepliesNilSynchronously`;
  - `testTheSinkGetsTheOrigin`;
  - `testCompleteDeliversThePayloadExactlyOnce`;
  - `testTheDeadlineRepliesNil`;
  - `testCompletingCancelsTheDeadline`;
  - `testDetachRepliesNilToEverythingOutstandingAndDisables`;
  - `testEachRequestGetsAFreshId`.
  - Run → FAIL.
- [ ] **Green** — as specified. The iOS example builds on both delivery paths.
- [ ] **Mutate**
  - (1) Drop the once-guard. `testCompleteDeliversThePayloadExactlyOnce` must fail.
  - (2) Call `reply` while holding the lock, and add a test-only reply that re-enters `complete:`. It must deadlock the test run, which the XCTest timeout reports as a failure.
  - Revert and record.
- [ ] **Commit** — `feat(ios): answer the vh data request from JS, within the budget`.

---

### Task 6.7 — E2E media helpers (pure, unit-tested)

**Files:** create `e2e/media.ts` and `scripts/__tests__/e2e-media.test.ts`; modify `e2e/bundles.ts` (`PulledBundle` gains `binaries: ReadonlyMap<string, string[]>`, the absolute paths of every non-JSON manifest file keyed by `type`, e.g. `video`, `screenshot`).

**Interfaces (exact):**

```ts
export const LUMA_DARK_MAX = 24, LUMA_BRIGHT_MIN = 150, BLACKOUT_MIN_DARK_S = 1.5;
export async function probeCodec(file: string): Promise<string | undefined>;
  // ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 <file>
export async function frameLumas(file: string): Promise<Array<{ t: number; luma: number }>>;
  // ffmpeg -v info -i <file> -vf "crop=iw/2:ih/2,scale=32:32,format=gray,showinfo" -f rawvideo -
  // 1024-byte frames on stdout (mean = luma), pts_time from showinfo on stderr, zipped in order
export async function regionLuma(file: string, region: { x: number; y: number; w: number; h: number }): Promise<number>;
  // ffmpeg -v error -i <file> -vf "crop=w:h:x:y,scale=16:16,format=gray" -frames:v 1 -f rawvideo -
export async function imageSize(file: string): Promise<{ width: number; height: number }>;
export type Shade = 'bright' | 'dark' | 'other';
export function shadeOf(luma: number): Shade;
export function blackoutPattern(frames: Array<{ t: number; luma: number }>):
  { ok: true; darkSeconds: number } | { ok: false; reason: string };
  // ok iff: a bright frame, then a contiguous dark run of >= 1.5 s (by t), then a bright frame; 'other' breaks a run
```

- [ ] **Red** — `e2e-media.test.ts` (pure functions only; no ffmpeg in `yarn test`):
  - `shadeOf splits at 24 and 150`;
  - `blackoutPattern accepts bright, a dark run of at least 1.5 s, bright`;
  - `rejects a dark run shorter than 1.5 s`;
  - `rejects dark with nothing bright before it`;
  - `rejects a video that never recovers`;
  - `an other frame breaks a dark run`;
  - `reports the dark run's length`.
  - Run → FAIL.
- [ ] **Green** — as specified. By hand, run `probeCodec` and `frameLumas` once on any pulled Android bundle video and record the output in the commit.
- [ ] **Mutate** — make `blackoutPattern` ignore the trailing bright requirement. `rejects a video that never recovers` must fail. Revert and record.
- [ ] **Commit** — `test(e2e): decode bundle video and screenshots for pixel assertions`.

---

### Task 6.8 — Device verification, Android: blackout, `<BugseeSecure>`, and the view tree

**Files:**
- Create: `scenarios/privacy.tsx` (scenarios `blackout`, `blackout-prelaunch`, `secure-component` and `view-tree`)
- Create: `e2e/blackout.test.ts`, `e2e/secure-component.test.ts`, `e2e/view-tree.test.ts`
- Modify: `App.tsx`

**The white stage (shared by every privacy scenario).** A full-screen `#FFFFFF` view, with a 40×40 `#000000` square animated left↔right across the top 15% of the screen (`Animated.loop`, `useNativeDriver: true`). Two reasons:
- iOS captures adaptively and Android skips unchanged frames, so frames need to keep flowing;
- the square sits outside every centre crop and region used below.

**Scenario `blackout`** (after `Launched` and 3000 ms on the stage):
1. `startBlackout()`, then log `BUGSEE_E2E blackout started t=<Date.now()> isBlackout=<await isBlackout()>`.
2. Wait 2000 ms; `captureViewHierarchy()`; wait 500 ms.
3. `upload('blackout-during-<n>', '')`, then log `… uploaded-during t=<ms>`.
4. Wait 2000 ms; `endBlackout()`; log `… ended t=<ms> isBlackout=<…>`.
5. Wait 3000 ms; `upload('blackout-after-<n>', '')`.

A lifecycle subscription logs `BUGSEE_E2E blackout lifecycle <name>` for `BlackoutStarted` and `BlackoutEnded`.

**Scenario `blackout-prelaunch`:**
1. `startBlackout()` **before** `launch()`, then log `… prelaunch-called`.
2. After `Launched`, log `… prelaunch isBlackout=<…>`.
3. `endBlackout()`, then log `… prelaunch-cleared isBlackout=<…>`.

**Scenario `secure-component`**, on the stage, inside a `ScrollView` whose content is 3× the screen height:
- `<BugseeSecure accessible accessibilityLabel="bugsee-secure-component" style={{ position: 'absolute', top: 260, left: 60, width: 180, height: 90, backgroundColor: '#FFFFFF' }} />`. It is white on white, so a dark region can only be the SDK's mask.
- Steps:
  1. After 1500 ms, log `… rect x= y= w= h= screen=<Dimensions screen w>x<h> ratio=<PixelRatio>`, then `upload('secure-mounted-<n>', '')`.
  2. `scrollTo({ y: 100, animated: false })`; wait 1500 ms; log the new rect; `upload('secure-scrolled-<n>', '')`. The new position (top 160) stays clear of the animated band.
  3. Unmount the component; wait 1500 ms; `upload('secure-unmounted-<n>', '')`.

**Scenario `view-tree`**, on the stage, a component named `BugseeE2EViewTreeProbe` rendering:
- `<View testID="vh-open-<n>" accessible accessibilityLabel="vh-open-probe" collapsable={false} style={{ position: 'absolute', top: 300, left: 30, width: 150, height: 60 }}><Text>secret-text-<n></Text></View>`
- `<BugseeSecure testID="vh-secure-<n>" style={{ position: 'absolute', top: 400, left: 30, width: 150, height: 60 }}><View testID="vh-inner-<n>" nativeID="vh-native-<n>" collapsable={false} style={{ flex: 1 }} /></BugseeSecure>`
- `<TextInput defaultValue="typed-<n>" style={{ position: 'absolute', top: 500, left: 30, width: 150, height: 40 }} />`

After 1000 ms: log the probe's `measureInWindow` rect; `captureViewHierarchy()`; wait 1000 ms; `upload('vh-<n>', '')`.

**Ground truth.** On Android, the screenshot mapping uses `uiautomator dump` bounds (display pixels, as in B1) and `adb shell wm size` (the physical display size). A rectangle in display pixels maps to screenshot pixels by `screenshot.width / displayWidth`. **Precondition, asserted:** every report checked below has at least one `screenshot` entry, and `probeCodec` answers for it. The bundle `video` must be `h264`. If any of these fails, the test fails, and the task stops and reports: it must not skip.

**Cases.**

`e2e/blackout.test.ts`:
1. `isBlackout and the lifecycle report the blackout`
   - `started … isBlackout=true` and `ended … isBlackout=false`.
   - `lifecycle BlackoutStarted` appears after `started`, and `lifecycle BlackoutEnded` after `ended`.
2. `a report taken during blackout has a black screenshot and no view tree`
   - In bundle `blackout-during-<n>`, every `screenshot` has centre-crop luma `≤ 24`.
   - No `viewtree` entry has a `timestamp` in `[startedT, uploadedDuringT + 1000]`.
   - No `BugseeRN data request` line appears between the `started` and `ended` markers. The example is wrapped, so the view tree is live: the SDK did not ask.
3. `the capture trace brackets the blackout` — in bundle `blackout-after-<n>`, `traces.system` has an entry `name = capture` with `value.state = 'blackout'` whose `timestamp ∈ [startedT − 1000, startedT + 1000]`, and a later `capture` entry with `state = 'active'` whose `timestamp ∈ [endedT − 1000, endedT + 1000]`.
4. `the video is black for the blackout and only for it`
   - In bundle `blackout-after-<n>`, `blackoutPattern(await frameLumas(video))` is `ok`.
   - `|darkSeconds − (endedT − startedT)/1000| ≤ 1.0`.
5. `a blackout started before launch` — `prelaunch isBlackout=false` on **Android**, where the SDK drops the pre-launch call (see Planner decisions), and `prelaunch-cleared isBlackout=false`.

`e2e/secure-component.test.ts`:
1. `the component's region is masked in the report`
   - In `secure-mounted-<n>`, the region's inner 60% has luma `≤ 24`.
   - A same-size control region starting 40 px below its bottom edge has luma `≥ 150`.
   - The served rectangle (`BugseeRN secure published … served=`, with `log.tag.BugseeRN` set to `DEBUG` as in B1) covers the uiautomator bounds of `bugsee-secure-component` within 1 px per edge.
2. `the mask follows a scroll` — in `secure-scrolled-<n>`, the region at the **new** bounds is dark, and the region at the **old** bounds (now white content) is bright.
3. `unmounting disposes the mask`
   - In `secure-unmounted-<n>`, the region at the last bounds is bright.
   - The last `served=` line reports count `0`.

`e2e/view-tree.test.ts`:
1. `the SDK asks and JS answers within budget` — after `Launched`, at least 2 `data request dr-<k> type=vh` lines. Each is followed by `completed by=js … ms=<m>` with `m < 450`, and no `by=deadline` appears.
2. `the managed tree is in the report it was asked for` — every `viewtree` entry in `vh-<n>` carries both `native` and a non-empty string `managed`, and there are at least 2 of them: the explicit capture and the snapshot.
3. `the managed tree has the documented shape`. `JSON.parse(managed)` gives:
   - the root `id "0"`, `class_name "ReactNative"`, `options.kind "root"`;
   - a `ReactSurface` child;
   - a composite node `BugseeE2EViewTreeProbe`;
   - a host node with `options.tag = 'vh-open-<n>'`;
   - a composite `BugseeSecure` with `options.secure` true, as is every descendant's;
   - unique `id`s.
4. `nothing private is in the payload`
   - The raw `managed` string contains none of `secret-text-<n>`, `typed-<n>`, `vh-secure-<n>`, `vh-inner-<n>`, `vh-native-<n>` or `vh-open-probe`.
   - No node's `class_name` is `RCTRawText`.
5. `bounds are display pixels on screen` — the `vh-open-<n>` node's `[x, y, w, h]` matches the uiautomator bounds of `vh-open-probe` within 1 px per edge.

**Edge-to-edge.** Run `view-tree` case 5 and `secure-component` case 1 twice:
- with the example's default `edgeToEdgeEnabled=true`;
- rebuilt with `edgeToEdgeEnabled=false` in `examples/bare/android/gradle.properties` (reverted afterwards).

B1 showed that only the second exposes a missing origin. Record both runs.

- [ ] **Red** — write the tests and scenarios. Run once before wiring `App.tsx` → FAIL at the first marker.
- [ ] **Green** — all the cases pass on the WOD_LX1, in both edge-to-edge settings where required.
- [ ] **Mutate**
  - (1) Set `DataRequestBridge.DEADLINE_MS = 5`. `view-tree` cases 1 and 2 must fail.
  - (2) Under `edgeToEdgeEnabled=false`, drop the origin in `walk.ts`. `view-tree` case 5 must fail.
  - (3) Make `BugseeSecure` skip its measure loop. `secure-component` case 2 must fail.
  - Revert and record.
- [ ] **Commit** — `test(e2e): blackout, <BugseeSecure> and the view tree on Android`. The body records the banner, both edge-to-edge runs, the video codec, `darkSeconds`, and the request timings.

---

### Task 6.9 — Device verification, iOS (simulator)

**Files:** the three tests from 6.8, running under `E2E_PLATFORM=ios`.

**Step 0 — establish what the simulator produces, once, before writing any iOS assertion.**
- Run `blackout` and `secure-component` once and pull the bundles.
- Record in this task's "As run":
  - whether each report carries a `screenshot` entry and a `video` entry;
  - what `probeCodec` answers for each.
- If any is missing or undecodable, **stop and report** to the controller. The controller then rules which cases become gated (`E2E_IOS_MEDIA=1`) and joins the Task 3.H list. The implementer does not decide gating, and no case may accept "either".

**iOS differences, stated per case (single-path):**
- `blackout` case 5: `prelaunch isBlackout=true`. iOS honours a pre-launch blackout.
- `secure-component` ground truth: there is no uiautomator. The region comes from the scenario's logged JS rectangle (points) mapped by `screenshot.width / Dimensions.screen.width`. The simulator window is full-screen, so window points equal screen points. The served-rectangle check (case 1's third assertion) is Android-only, because iOS logs no served buffer.
- `view-tree` case 5: the `vh-open-<n>` node's bounds equal the logged `measureInWindow` rectangle to within `0.01`, plus the origin, which is `(0, 0)` on the full-screen simulator window. The non-zero-origin arithmetic is covered by Task 6.3's unit tests only.
- `view-tree` case 1: the log lines come from `NSLog` via the simulator console stream, as in 3.4f.

- [ ] **Step 0** — as above. Record the result.
- [ ] **Red/Green** — the cases pass on the simulator, as ruled after Step 0.
- [ ] **Mutate** — set `BGSRNDataRequestDeadlineMs` to `5`. `view-tree` cases 1 and 2 must fail. Revert and record.
- [ ] **Commit** — `test(e2e): blackout, <BugseeSecure> and the view tree on iOS`.

**Hardware pass: add to Task 3.H:**
- Task 6.9 whole on a physical iPhone;
- `view-tree` case 5 on an iPad in Stage Manager or Split View, where the window origin is not `(0, 0)`;
- any case the controller gates after Step 0.

---

### Phase 6 review gate

The reviewer must independently:
- run every unit, JVM, XCTest and mutation suite, and `check-rn-compat.sh` for 0.81 and 0.87;
- confirm by reading the code that:
  - every `requestData` call is answered exactly once on every path (unknown type, no JS, disabled, no origin, JS reply, deadline, sink throws, detach/reload) on both platforms;
  - no deadline reaches the SDK's 500 ms;
  - the walk reads no prop other than `testID` and `nativeID`;
  - a `<BugseeSecure>` rectangle cannot outlive its component;
  - `setSecureRectangles` and `<BugseeSecure>` cannot clear each other;
- **rerun** 6.8 (both edge-to-edge settings) and 6.9;
- compare the `vh` JSON the device produced with the table in "The `vh` payload" above.

Record, for the controller, the three items this phase leaves open:
- the viewer does not parse `managed` (specs open item 2);
- the specs' "physical pixels" wording for iOS;
- Android's pre-launch blackout gap.

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
- **`bugsee/bugsee-android#186`** — `setUserIdentifier`/`setAttribute` values written verbatim to the SDK-internal log; fixed there, shipping with Android 7.3.0 (and the next iOS beta). Phase 5's device tests use synthetic values and assert nothing about `log.internal`.
- **To raise (controller; implementers never file these):**
  - `bugsee/specs` `sdk/wrapper-data-requests` says `vh` bounds are "physical screen pixels" but also "the native tree's coordinate space", which is points on iOS; Phase 6 follows the latter (workbook 6.6).
  - That spec's open item 2 (the viewer does not parse `managed`) means the RN view tree will not render in the dashboard until the viewer changes.
  - Android's `startBlackout` is a no-op before launch, while iOS honours it (fails closed); Phase 6 case `blackout` 5 pins both behaviours.

## Out of scope

tvOS, visionOS and Mac Catalyst. The xcframework ships those slices, but the manifest declares `.iOS` only and no example app covers them.
