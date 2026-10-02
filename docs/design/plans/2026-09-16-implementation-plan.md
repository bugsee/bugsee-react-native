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

When a task's review passes, check its boxes here in the same session. If a device run changes a prediction, write the ruling under that task. Do not leave the boxes stale.

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

### Progress

Updated 2026-10-02. Tasks 8.1–8.3a are on `main` at `6499cb8`. Task 8.3a cases 1–5 and 7–11 passed on the WOD_LX1; case 6 and its Green checkbox stay open because the send control has no stable `resource-id`. Task 8.3b passed on the iOS 26.5 simulator and on the iPhone XS, with case 3 `it.failing` on `source.type` `unknown` and case 6 skipped. Older unchecked boxes in Phases 1–6 were not backfilled in this pass.

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

- [x] Regenerate `option-keys.json` (and the `shared`/`android`-only/`iOS`-only split it derives) from the `7.3.0` Android sources and the pinned iOS `7.0.0-beta3` sources.
- [x] Expose any option `7.3.0` added that Android carries and this wrapper does not yet surface as a first-class accessor — at minimum, confirm none of the new keys are silently dropped the way `19a034a` fixed for deprecated-but-registered options.
- [x] `option-manifest-parity.test.ts` and `option-keys.test.ts` stay green against the regenerated fixture.
- [x] **Commit** — `build(options): regenerate option-keys.json against 7.3.0`.

**As run (2026-09-29).**
- **Sources:** regenerated from Android `v7.3.0` (`beb390dc0`) and iOS `7.0.0-beta3` (`0d9c9d0a3`).
- **Key surface against the 7.2.0 fixture:** shared goes from 47 to 48, iOS-only from 22 to 21, Android-only from 27 to 30. Nothing was removed.
  - **Moved:** `config.max-data-size`, from iOS-only to shared. Both SDKs read it in megabytes; the defaults are iOS 50 and Android 150.
  - **Added, Android-only:** `config.max-pending-reports`, `config.max-pending-report-age`, and `detect.exit.bg_low_memory_as_error` (#190).
  - These four keys are exactly what `v7.2.0..v7.3.0` added to `Options.java`.
- **Surfaced:**
  - `maxDataSize` moves from `IOSLaunchOptions` to `BugseeLaunchOptions`.
  - `AndroidLaunchOptions` gains `detectAndReportExitLowMemoryBackgroundAsError`, `maxPendingReports` and `maxPendingReportAge`.
- **Guard against silently dropped keys:** `option-manifest-parity.test.ts` now requires the key fixture and the manifest to agree in both directions. The only exceptions are the named hidden internals `$$DEBUG`, `$$ENDPOINT` and `$$WRAPPER`.
- **Mutations:**
  - Putting the 7.2.0 fixture back fails 7 tests, including `writes only keys its own platform accepts` for Android.
  - Dropping `bg_low_memory_as_error` from the manifest fails 3 tests.
- **Checks:**
  - `yarn test`: 1177 passed, 1 skipped.
  - `BUGSEE_RELEASE=1 yarn test`: 1178 passed.
  - Lint and typecheck are clean.

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
- [ ] **iOS, Phase 8:** Task 8.3b case 6, gated `E2E_IOS_OPERATOR=1`. The rest of 8.3b ran on KRSFT on 2026-10-02 (10 passed, 1 skipped). The operator did not tap Send.
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
- A void TurboModule method never lets an exception escape: nothing can reject it, so an exception would crash the host. It catches `RuntimeException` on Android (logging at `BugseeRN`); on iOS it guards with `respondsToSelector:` or `isKindOfClass:`, never with `@try`. A Support-package bridge may `@try` around a foreign callout it cannot pre-check (the SDK's reply block, an injected scheduler), as `BGSRNReportHandlerBridge`'s `RunQuietly` does; a void TurboModule method in `BugseeModule.mm` never does.
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
  - Native supplies the React root's display origin in the request event: on Android, `ReactRootOriginTracker`'s last published origin; on iOS, the `frame.origin` (points) of the window hosting the React root, among the windows the SDK's own view-hierarchy walk visits. That is exactly the offset the SDK adds to every native node (`BGSCaptureViewHierarchyEngine.m:334-336`, SDK `0d9c9d0a3`), so the two trees share one space by construction, whatever the window's position on the physical screen (iPad multitasking).
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
- `data request <id> completed by=<js|deadline|no-js|no-origin|unknown-type|detach|sink-threw|failed> bytes=<n|null> ms=<elapsed>`

Here `<id>` is `dr-<counter>` and `ms` is measured from the moment `requestData` was entered. `failed` means the bridge itself threw (reading the origin, or arming the deadline); the SDK still gets exactly one `null`.

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
- While `enabled` (default `true`) and mounted, it measures on mount, on layout and on every loop tick, with `ref.current.measureInWindow((x, y, width, height) => setOwnerRectangles(token, 0, [{ x, y, width, height }]))`. That space is the main React root's window: Android adds that root's display origin. A React Native `<Modal>` is its own window (an Android `Dialog`), so a `<BugseeSecure>` or a `managed` node inside one is not placed on the sheet. Follow-up, not a Phase 6 fix: measure in the view's own window.
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

- [x] **Red**
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
- [x] **Green** — the modules, the mock (`onDataRequest` subscribe, `emitDataRequest(event)`, and `jest.fn`s for `replyDataRequest` and `setViewTreeEnabled`), the stubs and the example. All gates green.
- [x] **Mutate**
  - (1) Skip the reply when the walk throws. `every request is replied to exactly once` must fail.
  - (2) Never call `setViewTreeEnabled(false)`. `the last disables it` must fail.
  - Revert and record.
- [x] **Commit** — `feat(viewtree): Bugsee.wrap and the vh request in JS, bridge stubbed`.

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

- [x] **Red**
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
- [x] **Green** — as specified. The example builds.
- [x] **Mutate**
  - (1) Drop the `AtomicBoolean`. `completeDeliversThePayloadExactlyOnce` must fail.
  - (2) Set `DEADLINE_MS = 600`. `theDeadlineIsBelowTheSdkBudget` must fail.
  - (3) Emit even when disabled. `aDisabledViewTreeRepliesNullSynchronously` must fail.
  - Revert and record.
- [x] **Commit** — `feat(android): answer the vh data request from JS, within the budget`.

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
- (instancetype)initWithScheduler:(id (^)(dispatch_block_t task, int64_t delayMs))schedule
                           cancel:(void (^)(id token))cancel
                            clock:(int64_t (^)(void))nowMs
                              log:(void (^)(NSString *line))log;   // tests pin the log lines
@property (atomic) BOOL viewTreeEnabled;
// The sink returns whether the emit reached JS (BGSRNGuardedEmit); NO answers nil at once, by=sink-threw.
- (void)attach:(id)sink block:(BOOL (^)(NSDictionary *request))block origin:(NSValue *_Nullable (^)(void))origin; // CGPoint
- (void)detach:(id)sink;
- (void)requestType:(NSString *)type reply:(void (^)(NSString *_Nullable data))reply;
- (BOOL)complete:(NSString *)requestId payload:(nullable NSString *)payload;
@property (nonatomic, readonly) NSUInteger outstanding;   // tests: every terminal path returns it to 0
@end
```

- The registry is guarded by `os_unfair_lock`, and the reply always runs outside the lock.
- The module's `origin` block runs on main, where the SDK calls `requestData`. It picks the key window the way the SDK does (`BGSTrackerApplication.m:219-264`) and the windows the SDK walks for it (`:185-210`, `:295-320`), finds the one hosting the React root (`RCTSurfaceHostingView`, or legacy `RCTRootView`; key window first, breadth-first, bounded), and returns `[NSValue valueWithCGPoint:window.frame.origin]`, or `nil` without one (`support/BGSRNReactWindow.m`, tested with injected windows). Not the window's screen-space position: the SDK adds `frame.origin` (`BGSCaptureViewHierarchyEngine.m:334-336`). Changed in Task 6.6 fix round 1 (review I1).
- The request-order rules and the log lines are the same as in 6.5.

- [x] **Red** — `BGSRNDataRequestBridgeTests`, mirroring 6.5's names:
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
- [x] **Green** — as specified. The iOS example builds on both delivery paths.
- [x] **Mutate**
  - (1) Drop the once-guard. `testCompleteDeliversThePayloadExactlyOnce` must fail.
  - (2) Call `reply` while holding the lock, and add a test-only reply that re-enters `complete:`. It must deadlock the test run, which the XCTest timeout reports as a failure.
    - As built: the reply re-enters from another thread and waits at most 2 s, so the deadlock fails the test instead of hanging the run. A same-thread re-entry would trap in `os_unfair_lock` (a recursive lock is a crash, not a deadlock).
  - Revert and record.
- [x] **Commit** — `feat(ios): answer the vh data request from JS, within the budget`.

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

- [x] **Red** — `e2e-media.test.ts` (pure functions only; no ffmpeg in `yarn test`):
  - `shadeOf splits at 24 and 150`;
  - `blackoutPattern accepts bright, a dark run of at least 1.5 s, bright`;
  - `rejects a dark run shorter than 1.5 s`;
  - `rejects dark with nothing bright before it`;
  - `rejects a video that never recovers`;
  - `an other frame breaks a dark run`;
  - `reports the dark run's length`.
  - Run → FAIL.
- [x] **Green** — as specified. By hand, run `probeCodec` and `frameLumas` once on any pulled Android bundle video and record the output in the commit.
- [x] **Mutate** — make `blackoutPattern` ignore the trailing bright requirement. `rejects a video that never recovers` must fail. Revert and record.
- [x] **Commit** — `test(e2e): decode bundle video and screenshots for pixel assertions`.

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

- [x] **Red** — write the tests and scenarios. Run once before wiring `App.tsx` → FAIL at the first marker. *As run: all three suites failed at their first scenario marker (`started`, `rect phase=mounted`, `rect`).*
- [x] **Green** — all the cases pass on the WOD_LX1, in both edge-to-edge settings where required. *As run: 13/13, three runs of each suite with edge-to-edge on and three of `secure-component` and `view-tree` with it off (`-PedgeToEdgeEnabled=false`, origin 0,51), no flakes. The moving square stops during each post-upload hold: `uiautomator dump` never goes idle while it moves.*
- [x] **Mutate** *As run: (1) cases 1–5 failed (`by=deadline ms=7`, no `managed`); (2) case 5 failed by 51 px; (3) case 2 failed (new bounds 255, old 0). Reverted.*
  - (1) Set `DataRequestBridge.DEADLINE_MS = 5`. `view-tree` cases 1 and 2 must fail.
  - (2) Under `edgeToEdgeEnabled=false`, drop the origin in `walk.ts`. `view-tree` case 5 must fail.
  - (3) Make `BugseeSecure` skip its measure loop. `secure-component` case 2 must fail.
  - Revert and record.
- [x] **Commit** — `test(e2e): blackout, <BugseeSecure> and the view tree on Android`. The body records the banner, both edge-to-edge runs, the video codec, `darkSeconds`, and the request timings.

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
- `blackout` case 5: `prelaunch isBlackout=true`. iOS honours a pre-launch blackout. The wrapper is registered at module init (idempotent; `setWrapperInfo` replaces it), so the listener hears one `BlackoutStarted` before `Launched` and one `BlackoutEnded` after `endBlackout()`. The held-frame check is one-sided: `darkSeconds >= (ended − started) − 0.25s`, because the frame stays up until the next encoded frame (no upper bound — a long hold after `endBlackout` is fine). That floor is the length of the hold. It does not locate the black frame in the video: a later start whose hold runs on past `endBlackout` still meets it. When the SDK entered blackout is the capture trace, on the device clock. Frame `t` is presentation time from the start of the file, and there is no measured offset between those clocks.
- `secure-component` ground truth: there is no uiautomator. The region comes from the scenario's logged JS rectangle (points) mapped by `screenshot.width / Dimensions.screen.width`. The simulator window is full-screen, so window points equal screen points. The served-rectangle check (case 1's third assertion) is Android-only, because iOS logs no served buffer.
- `view-tree` case 5: the `vh-open-<n>` node's bounds equal the logged `measureInWindow` rectangle to within `0.01`, plus the origin, which is `(0, 0)` on the full-screen simulator window. The non-zero-origin arithmetic is covered by Task 6.3's unit tests only.
- `view-tree` case 1: the log lines come from `NSLog` via the simulator console stream, as in 3.4f.

- [x] **Step 0** — as above. Record the result. **As run (iPhone 17 Pro simulator, iOS 26.5, `Bugsee IOS SDK ver:7.0.0-beta3 build:0d9c9d0a-9`):** all five reports (`blackout-during`, `blackout-after`, `secure-mounted`, `secure-scrolled`, `secure-unmounted`) carry one `screenshot` entry (`screenshot_0.jpg`, `probeCodec` → `mjpeg`, 484 or 485×1024, attrs `hpadding`/`vpadding` 0) and one `video` entry (`.mov`, `probeCodec` → `h264`, 416×880). Nothing missing or undecodable, so no stop and no gating. Two iOS media facts found here and handled per case: no letterbox and no `video.aux` (both the screenshot and the video scale by `width / Dimensions.screen.width` from the top-left and cut the bottom, 850 of 874 pt); and a blackout is one black frame *held* until recording resumes, not a run of frames.
- [x] **Red/Green** — the cases pass on the simulator, as ruled after Step 0. **As run:** red first with only the platform plumbing (console log, app stop, no airplane mode): blackout cases 2, 4, 5 failed (the `BugseeRN:` regex, `blackoutPattern` on a held frame, `isBlackout=true`), cases 1 and 3 passed unchanged; secure-component and view-tree failed 5/5 in `beforeAll` (no uiautomator / served line). Green 15/15, 3 runs per suite, no flakes. iOS branches: `bridgeLine` for the `NSLog` lines; `heldBlackout` (dark 4.57–4.64 s against 4.55 s); pre-launch `isBlackout=true`, no `BlackoutStarted`, one `BlackoutEnded`; ground truth from the logged `measureInWindow` rectangles (a `witness` marker added to the scenario, after the upload); `widthFitRegion` for the video; `vh-open` node equal to the rectangle + origin `(0, 0)` exactly; both `vh` requests `by=js` in 1–9 ms. The same three files also passed 3× each on the iPhone XS (iOS 18.7.9); details in the Task 6.9 report.
- [x] **Mutate** — set `BGSRNDataRequestDeadlineMs` to `5`. `view-tree` cases 1 and 2 must fail. Revert and record. **As run:** rebuilt and reinstalled; `dr-1 completed by=deadline bytes=null ms=6` (dr-2 still `by=js` in 1 ms), so case 1 failed on `by`, case 2 on the missing `managed`, and 3–5 through the same missing string. Reverted (`git checkout`, byte-compared, `= 450`), rebuilt, reinstalled.
- [x] **Commit** — `test(e2e): blackout, <BugseeSecure> and the view tree on iOS`.

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

## Phases 7–8 — shared ground

Phase 7 starts after Phase 6's review gate: its root reporter lives in `Bugsee.wrap` (Task 6.4), and its view-tree skip list (Task 6.3's `isWrapper`) gains one component. Phase 8 starts after Phase 7's gate and uses Task 7.6a's example helper module. Each phase ends with its own gate.

**Everything in "Phases 4–6 — shared ground" applies unchanged**: the rule against creating external resources, the paths, the commands, the rules for every native method, the device rules and the meaning of "Hardware pass: add to Task 3.H". What follows only adds to it.

**Paths added.**
- `e2eNative/…` = `examples/e2e-native/…`, the example-only native module of Task 7.6a (workspace package `bugsee-e2e-native`).

**Commands added.**
- Android release build for the gated cases: `(cd examples/bare/android && ./gradlew :app:assembleRelease -PbugseeE2eDebuggable=true -PbugseeE2eMinify=true -PreactNativeArchitectures=arm64-v8a)`, then `adb -s AMRJCP4718402860 install -r examples/bare/android/app/build/outputs/apk/release/app-release.apk`. `bugseeE2eMinify` is added by Task 7.1c.
- iOS Release build on the iPhone: `IOS_CONFIGURATION=Release yarn workspace bugsee-example-bare device:ios` (the variable is added by Task 7.5b; `Debug` stays the default).
- Gated cases run only behind `E2E_RELEASE=1` (a release build is installed) or `E2E_IOS_OPERATOR=1` (a person taps the iPhone when the test says so). Each joins the Task 3.H list.

**Rules added for every native method in these phases.**
- A promise-returning native method settles exactly once on every path, including an SDK callback that never comes (Task 7.1d documents where the iOS SDK does not call back).
- No message, JS or native, echoes a caller's value (Task 5.T's rule, extended). A validation message names the field and the rule; a native log line about an exception or a report prints the handle, a byte count or a code, never the content.
- The exception payload is built in JS only (`src/exceptions/payload.ts`). Both natives forward it verbatim: they never parse, log, truncate or re-encode it.

**Devices, added.**
- An iOS case that needs the SDK's crash reporter (`logException`, `logUnhandledException`, any crash recovery) runs only with `E2E_IOS_TARGET=device`. On the simulator the same file asserts the simulator's documented behaviour instead (Phase 7 verified facts: the simulator slice compiles those entry points out).
- A case that is `it.failing` for a known SDK bug is preceded, in the same run, by a plain `it` that proves the bundle is this run's (its nonce is in the payload or the summary). A harness regression then fails loudly instead of passing as the known bug.

---

## Phase 7 — Exceptions

**Ships:**
- `logException(error, options?)` and `logUnhandledException(error)`;
- the global handlers: `ErrorUtils` and unhandled promise rejections;
- `<ErrorBoundary>`, and a root reporter inside `Bugsee.wrap` for render errors no boundary catches;
- the debug-ID payload (`debug_ids` map plus per-frame `debug_id`);
- an example-only native module with a real, JS-triggerable native crash, and its device test.

### Planner rulings (the design wins over the outline; reviewable, change them here)

- **R1. The payload's message key is `reason`.** Design §9.1 says "message" in prose. The worker (`crash/managed/reactnative.py` `_process_new_format`) reads `reason`, and 6.x sent `reason`.
- **R2. `signature` is kept, as design §9.1 lists it, and it is load-bearing.**
  - Android 7.3.0 parses `signature` out of a JSON reason (`ExceptionSignature.extractFromReason`) into the client signature and into `crash.json` `additional_signature`. iOS writes `additional_signature` the same way (`sdk/reporting/bundle/crash.md`).
  - Without it, every React Native exception on Android shares one client signature: the class name plus the bridge's own Java frames.
  - It is SHA-1 over the chain's names and frame traces (6.x's `concatExceptionsRecursiveForSignature`), without 6.x's `build_id` suffix (R3) and with 7.x's own source cleaning (`cleanSource` steps 3-4 subsume 6.x's `EXCEPTION_SIGNATURE_CLEANUP_REGEXPRS`). It otherwise differs from 6.x only where already documented elsewhere: `name` is `error.name` verbatim rather than a builtin-`instanceof` name (so a `class X extends TypeError` gives `TypeError` in `X`'s name, intended), and an unparsed line no longer contributes a `<unknown> () ()` frame (review M4, M3). Client-signature continuity across a 6.x-to-7.x upgrade is not expected or attempted: 6.x's signature already changed with every app version (it hashed in `appVersion-config-os`) and every bundle (minified line:column), and Android's own client signature separately hashes the bridge's Java frames, which change with the 7.x bridge regardless.
- **R3. `build_id` is not sent.** When it is absent, the worker computes `_construct_build_id` = SHA-1 of `<app version>-release-<platform>`. That is the formula 6.x used in a release build. 7.x symbolicates by debug ID (R5, Phase 13), which the worker tries first.
- **R4. Exception options are exactly `domain`, `labels` and `includeVideo`, flat** (design §9.1: "the wrapper passes all three").
  - 6.x's `mergingRules.skipFrames` is not carried. It indexes the *native* stack, which for a JS exception is the bridge's own frames, and the worker computes a React Native signature from the JS frames without it.
  - `includeVideo` is passed through, although neither 7.x SDK acts on it (verified facts).
  - Android 7.3.0 ignores `labels` (verified facts; "To raise").
- **R5. `debug_ids` is a filename → id map, plus a per-frame `debug_id`** (design §9.2, outline 7.3).
  - `globalThis._bugseeDebugIds` is keyed by the registering script's `Error().stack`, not by filename (`bugsee-cli` `src/inject/mod.rs`).
  - The filename is that stack's **top frame**, parsed by the same parser and normalised by the same function as a crash frame's file, as `@bugsee/core` `debug-id.ts` does.
- **R6. A global-handler error with `isFatal === true` goes to `logUnhandledException`; anything else goes to `logException`.**
  - 6.x reported every global-handler error as unhandled.
  - On iOS, 7.x `logUnhandledException` stores an *overriding* crash report: it surfaces at the next launch, and a later call replaces it. That is wrong for an error the app survives.
  - Unhandled promise rejections stay handled, as in 6.x.
- **R7. JS capture obeys `com.bugsee.option.detect.crash`** (design §10, the `componentState` pattern).
  - The global handlers, the rejection tracker and the root reporter report only when the options given to `launch()`/`relaunch()` do not set it to `false`. The SDK default is `true`.
  - An explicit `logException`/`logUnhandledException` call always forwards.
- **R8. Render errors that no boundary catches are caught by a root reporter inside `Bugsee.wrap`.**
  - On RN 0.81+ they never pass through `ErrorUtils`. React calls `onUncaughtError` → `ExceptionsManager.handleException(error, true)` directly (`src/private/renderer/errorhandling/ErrorHandlers.js`, verified on 0.87.1), so Task 7.2's hook cannot see them.
  - The Phase 6 decision named `wrap` as the one integration point for "Phase 7's boundary".
  - The reporter reports, waits (bounded), then rethrows, so RN's fatal path is unchanged.
  - Recorded side effect: React first hands the caught error to RN's `onCaughtError`, a soft, non-fatal error, before the rethrow's fatal one.
- **R9. A thrown non-`Error` value is never serialised.**
  - 6.x `JSON.stringify`-ed it into the reason, and a thrown response object carries whatever it carries.
  - A string becomes the reason. An object with a string `message` gives that message, plus its `name` if that is a string. Anything else becomes `Non-Error thrown: <typeof>`.
  - The builder reads no property of an error except `name`, `message`, `stack` and `cause`. The only exception is `errors`, read on an `AggregateError` at the entry point. A `Proxy` test pins this.
- **R10. `<ErrorBoundary>` never mutates the caught error.**
  - 6.x overwrote `error.cause` with the component stack.
  - Here the component stack becomes the innermost cause node, named `ErrorBoundary Error` (6.x's name). The error's own `cause` chain is kept above it.
- **R11. There is no Metro symbolication in dev** (6.x called `symbolicateStackTrace`, which is async). The payload is built synchronously, so the fatal path can hand it to native before RN's own handler runs. The backend symbolicates.
- **R12. Outline 7.6's native trigger lives in an example-only module, `bugsee-e2e-native` (Task 7.6a), not in the library.**
  - Shipping a JNI library inside every consumer's app for a test hook is not worth it.
  - `Bugsee.testNativeCrash()` keeps calling the SDKs' own `testCrash`, and its doc now says what that is: a Java `RuntimeException` on Android, an `NSException` on iOS.
  - The same module writes the temp files a file attachment needs (Phase 8), which Task 3.4d could not stage.
- **R13. On Android, a fatal JS error produces two crash reports: ours and RN's own `JavascriptException`.** Android has no counterpart to iOS's overriding report. Phase 7 does not suppress the second one, because that would change the app's crash path. Task 7.5a pins the exact set of bundles. This is an open question for the user, and a "To raise".
- **R14. `AggregateError`** (6.x parity, capped):
  - handled: one report per inner error, for the first 10;
  - unhandled: the aggregate as one report. One incident is one crash, and iOS keeps only one overriding report anyway.

### Verified facts (2026-09-29)

**Android `v7.3.0` (`beb390dc0`):**
- API: `Bugsee.logException(Throwable)`, `logException(Throwable, Map<String, Object>)` and `logUnhandledException(@NonNull Throwable, Map<String, Object>)`.
- `logException` drops the call unless the SDK is running or starting (`Log.w`). `logUnhandledException` drops it the same way (it has a guard added for wrappers).
- `crash.json` `exception.name` is `throwable.getClass().getName()`, and `reason` is `getMessage()` (`ExceptionSerializer`).
  - R8 therefore renaming the class breaks routing. The package ships a keep rule (Task 7.1c).
- Only `domain` and `skipFrames` are read from the options map (`ExceptionSerializer:187`, `ExceptionSignature:83,230`). `labels` and `includeVideo` are documented in the javadoc but read nowhere.
- `logUnhandledException` writes the crash report **synchronously** and does not terminate the process. In 7.3.0 it **also** files an error report: `logExceptionInternal` falls through from the crash branch.
  - The fix is `e1d56ed65`, on branch `fix/unhandled-error-single-report`, which is neither merged nor released.
- `testCrash()` throws `new RuntimeException("Test crash")`.
- The NDK artifact has no public native-crash trigger.

**iOS `7.0.0-beta3` (`0d9c9d0a3`), `Bugsee.h:367,380–381`:**
- API: `+logException:reason:options:completion:` and `+logUnhandledException:reason:completion:`.
- Both bodies sit inside `#if !TARGET_OS_SIMULATOR && !TARGET_OS_MACCATALYST`. **On the simulator they do nothing and never call `completion`.**
- Unless the SDK is `Launched`, `logException` calls `completion` at once and logs nothing.
- A handled exception becomes a live error report: `reportHandledCrashReport:asError:YES labels:loggingOptions.labels`.
- An unhandled exception goes to `BGSCrashManager logUnhandedException:` → PLCrashReporter `createAndStoreOverridingCrashReportWithException:` (custom data `{"ExceptionFromWrapper":true}`), and `completion` runs at once.
  - The report surfaces as a recovered crash at the next launch.
  - With the crash manager off (a debugger attached), it falls back to `logException…asHandled:NO`, a live report.
- `[BugseeExceptionLoggingOptions new].includeVideo` is `NO`. The value is recorded in `crash.json` `exceptionLoggingOptions` (`getDictInfo`) and acted on nowhere.
- The domain is written as `exceptionLoggingOptions.exceptionDomain`, and never as `exception.domain` (`crash.md`).
- `+testCrash` throws an `NSException`.

**Worker (`84013cf`):**
- Routing is a substring test, `'ReactNativeWebException' in name` (`crash/managed/__init__.py:38`, `crash/processors/__init__.py:33`).
- `_try_get_serialized_exception` strips a `^.*ReactNativeWebException:\s*` prefix from `reason`, then parses JSON.
- It reads `name`, `reason`, `frames[]` (`trace`, `traceRaw`, `data`, `debug_id`), `cause`, `platform_os` (default `ios`), `build_id` (with the R3 fallback) and `debug_ids`.
- `_collect_debug_ids` accepts `debug_ids` as a list **or** a map (it takes the values), plus each frame's `debug_id`.
- The signature is recomputed server-side from name, reason and the top user frame. The client's `signature` is not read there (R2 says where it is read).

**`bugsee-cli` (`506e414`):** the injected stub runs `globalThis._bugseeDebugIds[(new Error).stack] = "<uuid>"`, wrapped in `try`/`catch`, and appends `//# debugId=<uuid>`. The paired map gets `debug_id` and `debugId`.

**React Native 0.87.1** (the same files exist in 0.81; `check-rn-compat.sh` pins them, Task 7.2):
- `Libraries/Core/setUpErrorHandling.js` installs `ErrorUtils.setGlobalHandler(handleError)` unless `global.RN$useAlwaysAvailableJSErrorHandling === true`.
- On Hermes, `Libraries/Core/polyfillPromise.js` enables `HermesInternal.enablePromiseRejectionTracker(promiseRejectionTrackingOptions)` **only in `__DEV__`**. A release build tracks no rejections at all unless a library enables it.
- `src/private/renderer/errorhandling/ErrorHandlers.js`: `onUncaughtError` → `ExceptionsManager.handleException(error, true)` and `onCaughtError` → `handleException(error, false)`. Neither passes through `ErrorUtils`.
- In a release build, a fatal error reaches native `reportFatalException`. Android then throws `com.facebook.react.common.JavascriptException`; iOS raises `RCTFatalException`.

**6.x wrapper (`cross/react-native`, read-only):**
- Android sends `new ReactNativeWebException(json)`, a private nested `Throwable`. Handled goes to `logException(ex, opts)`, unhandled to `onUncaughtException(currentThread, ex)`.
- iOS sends `logException:@"ReactNativeWebException" reason:json …`.
- The JSON is `{name, reason, frames, cause?, signature, build_id, platform_os}`, and each frame is `{traceRaw, trace, data: {member, source, line, column}, user?}`.

### Constants

| Name | Value | Where | Why |
|---|---|---|---|
| `REACT_NATIVE_EXCEPTION_NAME` | `'ReactNativeWebException'` | iOS `BGSRNReactNativeExceptionName`; Android simple class name | The backend routes on this exact substring. |
| `EXCEPTION_MAX_FRAMES` | `256` | `src/exceptions/payload.ts` | Per node. Bounds the payload; far above any real JS stack. |
| `EXCEPTION_MAX_CAUSE_DEPTH` | `10` | payload | Android's own nesting cap. |
| `EXCEPTION_MAX_REASON_LENGTH` | `8192` UTF-16 units | payload | Truncated with `…` (U+2026), which is not counted against the cap -- a truncated reason is 8193 units. Never splits a surrogate pair. |
| `EXCEPTION_MAX_NAME_LENGTH` | `256` UTF-16 units | payload | Same surrogate-safe cut as `reason` (review I1: `name` was uncapped). |
| `EXCEPTION_MAX_FIELD_LENGTH` | `1024` UTF-16 units | payload | Caps `traceRaw`, `data.source` and `data.member` (review I1: a hostile stack produced a 76.8 MB payload with these uncapped). |
| `STACK_MAX_INPUT_LENGTH` | `65536` (64 KiB) | `src/exceptions/stack.ts` | Bounds the whole `stack` string before it is split into lines (review C1). |
| `STACK_MAX_LINE_LENGTH` | `2048` (2 KiB) | stack | Bounds each line before any pattern runs on it. Every pattern is also linear in the line's length on its own (review N1 -- fix round 1's claim that the cap alone made a quadratic pattern's cost negligible was wrong: a genuinely quadratic pattern at this cap, multiplied by every line in a 64 KiB stack and every node in a cause chain, measured over a second). |
| `EXCEPTION_MAX_TOTAL_STACK_LENGTH` | `131072` (128 KiB) | `src/exceptions/payload.ts` | Bounds the *sum* of `error.stack`/`componentStack`/`fallbackStack` parsed across one whole cause chain (review N1): each node's own stack is separately capped at `STACK_MAX_INPUT_LENGTH`, but nothing bounded the total across the chain's up to 11 nodes plus `componentStack`, which could still reach 12x one node's own worst case. Shared via one mutable counter; once it is spent, a later node's frames are `[]`. |
| `EXCEPTION_MAX_AGGREGATE` | `10` | `src/exceptions/report.ts` | R14. |
| `EXCEPTION_DOMAIN_MAX_LENGTH` | `256` | `src/exceptions/options.ts` | A domain is a grouping tag, not text. |
| `DEBUG_IDS_MAX` | `64` | `src/exceptions/debugIds.ts` | Map entries sent. One bundle is typical. `payload.ts` does not enforce this itself; it belongs to Task 7.3's `debugIds.ts` (review M7). |
| `UNHANDLED_REPORT_WAIT_MS` | `1500` | report | The most the fatal path waits for native before RN's handler runs. Android writes synchronously; iOS stores the PLCR report synchronously. |
| `ERROR_BOUNDARY_CAUSE_NAME` | `'ErrorBoundary Error'` | payload | R10, 6.x's name. |

**Log lines** (Android `Log.i("BugseeRN", …)`, iOS `NSLog(@"BugseeRN …")`); the device tests match these:
- `exception handled sent bytes=<n>`
- `exception unhandled sent bytes=<n>`
- `exception unhandled completed`

### The payload (exact)

The reason is one JSON object. Keys appear in this order, and absent keys are omitted, never `null`.

| key | type | where | meaning |
|---|---|---|---|
| `name` | string | every node | The error's `name` if it is a non-empty string (whitespace-only counts as non-empty; not trimmed, review M7); else `'Error'`. Capped at `EXCEPTION_MAX_NAME_LENGTH`. |
| `reason` | string | every node | `message`, trimmed and truncated (constants), or R9's description. |
| `frames` | frame[] | every node | Parsed from `stack` with its own `name: message` (or bare `name`, or bare `message` when `name` is `''`) header stripped first, top first; the header is never itself parsed as a frame (review I2 -- it previously was, whenever a message happened to look enough like one). A candidate is accepted only when followed by the end of the string, `\n` or `\r` (review N2 -- a bare `name` prefix match alone let a real frame whose own function name starts with the error's name, e.g. `TypeErrorFactory` for a `TypeError`, lose its own leading text). A bare (no `"@"`) parsed frame whose file contains `": "` is dropped rather than kept, as a second guard for a header a mismatched `name`/`message` could not identify and therefore left unstripped. `[]` when there is no stack. |
| `cause` | node | when present | `error.cause` (any value, R9), to depth 10, stopping at a repeat (`WeakSet`). Then the R10 component-stack node, if any. |
| `signature` | string | root | `sha1Hex(<name><each frame's trace>…)` down the whole chain, lowercase, 40 hex characters. |
| `platform_os` | `'android'` \| `'ios'` | root | `Platform.OS`. |
| `debug_ids` | `{[file]: id}` | root, when non-empty | The R5 map. `payload.ts` sends it as given; the 64-entry cap is Task 7.3's `debugIds.ts` to enforce (review M7). |

A frame has these keys, in order:
- `traceRaw`: the stack line as the engine wrote it, capped at `EXCEPTION_MAX_FIELD_LENGTH`. This keeps a hostile message's own bulk out of the payload (review I1), but a *legitimate* absolute path still reaches the backend verbatim otherwise: an iOS install path (`/private/var/containers/Bundle/Application/<UUID>/…`), an iOS data-container path or an Android `/data/user/0/<pkg>/…` path. That is spec-intended (`traceRaw` is defined as verbatim, matching 6.x) and is recorded here as a privacy note, not a defect (review M5);
- `trace`: `<member> () (<source>[:line][:column])`, 6.x's form;
- `data`: `{member, source, line, column}`. `member` defaults to `'<unknown>'`; `line` and `column` are `null` when unknown. `member` and `source` are each capped at `EXCEPTION_MAX_FIELD_LENGTH`;
- `user`: present when the frame has a file (checked on the frame's own file, not the cleaned `source` -- they agree in practice, since none of `source`'s five steps can remove these substrings, but the wording here is what the code now matches, review M6). It is `true` iff the frame has a line and a column, its file contains none of `node_modules`, `native code` or `(native)`, and it is not React 19's own built-in-component sentinel: `describeBuiltInComponentFrame` (`ReactFabric-dev.js`) writes a built-in host component's frame (`View`, `Text`, ...) as `<anonymous>` with no line/column on an engine whose own stacks say "at" (already excluded, having no line/column at all), or as file `unknown`, line `0`, column `0` on one that does not (JSC) -- `0` is a real number, not absent, so this needs its own check (review N4);
- `debug_id`: present when the frame's file is in the map.

`source` is the frame's file with these removed, in order:
1. a leading `file://`;
2. a leading `address at `;
3. `^.*/[^/]+\.app/` (an iOS app bundle path);
4. `^/var/mobile/Containers/Data/Application/[^/]+/`;
5. `^/data/(data|user/\d+)/[^/]+/` (the Android app data directory, where CodePush keeps bundles).

The **file key** used by R5's join is the same string with steps 1–2 only, so it matches between the registration stack and the crash stack even where step 3–5 would not.

**Known limitation (review N3):** a Hermes `"at NAME (address at FILE:LINE:COL)"` frame whose *name* itself contains `(` is not parsed (produces no frame at all). `stack.ts`'s name groups exclude `(` everywhere, on purpose (review N1/C1): letting a name contain `(` reintroduces the same super-linear scan those reviews removed, since it lets the name and the following file group compete over the same characters. A file containing `(`/`)` (an iOS app bundle such as `"My App (Beta).app"`) is parsed correctly; only the name side of this is unsupported, and no captured fixture (M2) has one.

```json
{"name":"TypeError","reason":"E2E handled 3f9a","frames":[
  {"traceRaw":"    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)",
   "trace":"bugseeE2EThrowSite () (index.android.bundle:1:20417)",
   "data":{"member":"bugseeE2EThrowSite","source":"index.android.bundle","line":1,"column":20417},
   "user":true,"debug_id":"8a1c2f4e-0d3b-5e6f-9a7b-1c2d3e4f5a6b"}],
 "cause":{"name":"RangeError","reason":"inner 3f9a","frames":[]},
 "signature":"0b4a…40 hex…","platform_os":"android",
 "debug_ids":{"index.android.bundle":"8a1c2f4e-0d3b-5e6f-9a7b-1c2d3e4f5a6b"}}
```

**What Phase 13 must produce to match (13.1, 13.5).**
- The `bugsee-cli` stub is present in the JavaScript the device executes. For Hermes, that is the JavaScript `hermesc` compiles, so the stub is in the bytecode.
- The source map uploaded for that bundle is the **composed** map (after `compose-source-maps.js`), and it carries the same UUID as `debug_id`.
- The registration's top frame and the crash frames are in one bundle file, so their file keys are equal. Phase 13 has nothing to add at runtime.
- Task 13.5's end-to-end test asserts that a release build's `payload.debug_ids` value equals the uploaded map's `debug_id`, and that the dashboard frame symbolicates.

### Execution order and parallel streams

| Stream | Tasks, in order | Notes |
|---|---|---|
| A (JS) | 7.1a → 7.1b → 7.3 → 7.2 → 7.4 | 7.1b fixes the spec. 7.3, 7.2 and 7.4 touch only `src/exceptions/**`, `src/index.ts`, `src/viewtree/**` and the scripts guard. |
| B (Android) | after 7.1b: 7.1c | `android/**`, `examples/bare/android/app/build.gradle` |
| C (iOS) | after 7.1b: 7.1d | `ios/**` |
| D (example) | 7.6a from the start, then 7.6b | `examples/e2e-native/**` and the example wiring. 7.6b needs the WOD_LX1. |
| Devices | 7.5a after 7.1c, 7.2, 7.3, 7.4 and 7.6b; then 7.5b after 7.1d and 7.5a | The WOD_LX1 serialises 7.6b and 7.5a. 7.5b reuses 7.5a's files. |

At most three streams run at once, with priority A, then B, then C, then D. Stream D (7.6a) starts beside 7.1a. When 7.1b lands, B starts at once; C starts when D's current task finishes, if three are already running.

---

### Task 7.1a — Stack parsing, SHA-1 and the payload builder (pure JS)

**Depends on:** nothing in Phase 7. Stream A.

**Files:**
- Create: `src/exceptions/stack.ts`, `src/exceptions/sha1.ts`, `src/exceptions/payload.ts`
- Create tests: `src/exceptions/__tests__/stack.test.ts`, `sha1.test.ts`, `payload.test.ts`

**Interfaces (exact):**

```ts
// src/exceptions/stack.ts -- adapted from 6.x's stack-trace-parse.ts (stacktrace-parser, MIT);
// the MIT notice is carried over verbatim in the file header
export interface ParsedFrame { raw: string; file: string | null; methodName: string | null;
  lineNumber: number | null; column: number | null; }
export function parseStack(stack: string): ParsedFrame[];          // Chrome/V8, Hermes, JSC and "in X (at f:l)" lines; others skipped
export function fileKey(file: string): string;                     // steps 1-2 of "The payload (exact)"
export function cleanSource(file: string | null): string;          // steps 1-5; '' for null

// src/exceptions/sha1.ts
export function sha1Hex(text: string): string;                     // UTF-8 bytes of `text`, lowercase hex

// src/exceptions/payload.ts
export const EXCEPTION_MAX_FRAMES = 256, EXCEPTION_MAX_CAUSE_DEPTH = 10,
  EXCEPTION_MAX_REASON_LENGTH = 8192, ERROR_BOUNDARY_CAUSE_NAME = 'ErrorBoundary Error';
export interface ExceptionFrame { traceRaw: string; trace: string;
  data: { member: string; source: string; line: number | null; column: number | null };
  user?: boolean; debug_id?: string; }
export interface ExceptionNode { name: string; reason: string; frames: ExceptionFrame[]; cause?: ExceptionNode; }
export interface ExceptionPayload extends ExceptionNode { signature: string; platform_os: 'android' | 'ios';
  debug_ids?: Record<string, string>; }
export interface PayloadInput {
  error: unknown;
  platformOS: 'android' | 'ios';
  componentStack?: string;                        // R10
  fallbackStack?: string;                         // a stack captured by the caller, used only for a non-Error (Task 7.1b)
  debugIds?: ReadonlyMap<string, string>;         // file key -> id; filled by Task 7.3, empty until then
}
export function buildExceptionPayload(input: PayloadInput): ExceptionPayload;
export function describeThrown(value: unknown): { name: string; reason: string };   // R9
```

`buildExceptionPayload` never throws. A getter that throws while the builder reads `name`, `message`, `stack` or `cause` is caught and treated as absent.

- [x] **Red**
  - `stack.test.ts`:
    - `parses a Hermes release frame (address at)`;
    - `parses a Hermes frame from a Metro URL`;
    - `parses a native frame with no location`;
    - `parses a JSC frame (name@file:line:col)`;
    - `parses a V8 frame (at name (file:line:col))`;
    - `parses a component-stack line (in X (at file:line))`;
    - `skips the "Name: message" header and blank lines`;
    - `fileKey strips file:// and "address at " only`;
    - `cleanSource strips an iOS .app prefix, the iOS data container and the Android data directory`.
  - `sha1.test.ts`:
    - `hashes the empty string` (`da39a3ee5e6b4b0d3255bfef95601890afd80709`);
    - `hashes "abc"` (`a9993e364706816aba3e25717850c26c9cd0d89d`);
    - `hashes a two-block input` (`abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq` → `84983e441c3bd26ebaae4aa1f95129e5e54670f1`);
    - `hashes UTF-8, not UTF-16` (`é` → `bf15be717ac1b080b4f1c456692825891ff5073d`; `😀` → `9c533688a979a858cbd6a43c9f91aba624651f18`).
  - `payload.test.ts`:
    - `keys serialise in the documented order` (compare `JSON.stringify` with a literal, as the `vh` payload test does);
    - `name is the error's own name, and a subclass's custom name is kept`;
    - `an empty or non-string name becomes "Error"`;
    - `reason is the message, trimmed`;
    - `a reason over 8192 units is truncated with an ellipsis, never splitting a surrogate pair`;
    - `frames come from the stack, top first`;
    - `a frame's trace is "member () (source:line:column)" and its data carries member, source, line and column`;
    - `a node_modules or native frame is not user`;
    - `frames beyond 256 are dropped`;
    - `the cause chain nests, and stops at depth 10 and at a repeat`;
    - `a cause that is not an Error is described, never serialised`;
    - `no property other than name, message, stack and cause is read` (the error is a `Proxy` recording reads);
    - `a thrown string is the reason and has no frames`;
    - `a thrown object gives its string message and name and nothing else` (`Proxy`; `{ password: 'pw', message: 'm' }` → reason `m`, and no `pw` in `JSON.stringify(payload)`);
    - `a thrown number, null or undefined is "Non-Error thrown: <typeof>"`;
    - `a non-Error uses fallbackStack for its frames`;
    - `an Error ignores fallbackStack`;
    - `a component stack becomes the innermost cause, named "ErrorBoundary Error"`;
    - `the component stack is appended below the error's own cause, which is not changed`;
    - `the signature is sha1 of the chain's names and traces`;
    - `the signature does not change with the reason`;
    - `platform_os is the one given`;
    - `a throwing getter is treated as absent`.
  - Run → FAIL.
- [x] **Green**
  - The three modules.
  - Every `payload.test.ts` Proxy test passes.
  - `yarn test` and `yarn mutate:src` (≥ 95%) are green.
- [x] **Mutate**
  - (1) Serialise a non-Error object with `JSON.stringify`. `a thrown object gives its string message…` must fail.
  - (2) Drop the cycle guard. `…stops at depth 10 and at a repeat` must fail, or time out.
  - (3) Hash UTF-16 code units. `hashes UTF-8, not UTF-16` must fail.
  - (4) Include the reason in the signature. `the signature does not change with the reason` must fail.
  - Revert and record.
- [x] **Commit** — `feat(exceptions): a privacy-safe JS exception payload, with its signature`.

---

### Task 7.1b — `logException` and `logUnhandledException`: facade, options, spec and stubs

**Depends on:** 7.1a. Stream A. Fixes the spec that Streams B and C implement.

**Files:**
- Create: `src/exceptions/options.ts`, `src/exceptions/report.ts`, `src/exceptions/__tests__/options.test.ts`, `src/exceptions/__tests__/report.test.ts`
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`
- Modify (stubs only): `android/BugseeModule.java`, `ios/BugseeModule.mm` (both import branches if a header is added)

**TurboModule additions (exact):**

```ts
/** A handled JS exception. `payloadJson` is the Task 7.1a payload; `optionsJson` is `{domain?, labels?, includeVideo?}` or null. */
logException(payloadJson: string, optionsJson: string | null): void;
/** An unhandled JS exception. Resolves once the SDK has the report; never rejects. */
logUnhandledException(payloadJson: string): Promise<void>;
```

**Public JS API (exact):**

```ts
// src/exceptions/options.ts
export interface ExceptionOptions {
  /** Groups the issue on the dashboard. Non-empty, at most 256 characters. */
  domain?: string;
  /** Issue labels. Android 7.3.0 ignores them (to raise); iOS applies them. */
  labels?: readonly string[];
  /** Recorded in the report's exception options on iOS; neither 7.x SDK acts on it yet. */
  includeVideo?: boolean;
}
export const EXCEPTION_DOMAIN_MAX_LENGTH = 256;
/** TypeError or RangeError naming the field and never its value; null for undefined or {}. */
export function encodeExceptionOptions(options: ExceptionOptions | undefined): string | null;

// src/exceptions/report.ts
export const UNHANDLED_REPORT_WAIT_MS = 1500;
export const EXCEPTION_MAX_AGGREGATE = 10;
/** true the first time an object is seen (WeakSet); always true for a primitive. */
export function markReported(error: unknown): boolean;
export function reportHandled(error: unknown, options?: ExceptionOptions,
  extras?: { componentStack?: string; fallbackStack?: string }): void;      // never throws; R14 splits an AggregateError
export function reportUnhandled(error: unknown,
  extras?: { componentStack?: string; fallbackStack?: string }): Promise<void>;
  // resolves when native resolves or after UNHANDLED_REPORT_WAIT_MS, whichever is first; never rejects

// src/index.ts, on class Bugsee
/** Reports `error` as a handled error. Before launch() the SDKs drop it. */
logException(error: unknown, options?: ExceptionOptions): void;
/** Reports `error` as a crash; resolves once the SDK has it (at most 1.5 s). iOS surfaces it at the next launch. */
logUnhandledException(error: unknown): Promise<void>;
```

**Behaviour:**
- `logException` validates `options` first. A bad option throws synchronously, and nothing crosses.
- If `error` is not an `Error`, the facade passes `fallbackStack = new Error().stack` with its **first frame dropped**, so the frames start at the caller.
- Both facade methods call `markReported(error)`. An object reported once is never reported again, by any route: a facade call, a global handler, a boundary or the root reporter. Explicit calls also skip a repeat.
- `reportHandled`/`reportUnhandled` build the payload with `platformOS = Platform.OS`, encode it with `JSON.stringify`, and call native.
  - The payload is encoded with `encodeBridgeObject` (Task 4.5), like every other object payload, so a lone surrogate in a message crosses as U+FFFD.
- `testNativeCrash`'s JSDoc becomes: "the SDK's own test crash: a Java `RuntimeException` on Android, an `NSException` on iOS. For a real native (signal) crash, see the example's `bugsee-e2e-native`." (R12)
- Export `ExceptionOptions` from `src/index.ts`.

**Stubs:** Android and iOS `logException` are no-ops, and `logUnhandledException` resolves at once. Each is commented `Task 7.1c` or `Task 7.1d`.

- [x] **Red**
  - `options.test.ts`:
    - `undefined and {} encode to null`;
    - `domain, labels and includeVideo encode in that order`;
    - `rejects an empty domain, a domain over 256 characters and a non-string domain`;
    - `rejects labels that are not an array of strings`;
    - `rejects a non-boolean includeVideo`;
    - `rejects an unknown key, naming it` (`mergingRules`, `skipFrames`);
    - `no message contains the rejected value`.
  - `report.test.ts` (native mock):
    - `a handled error crosses as its payload and options`;
    - `an unhandled error crosses to logUnhandledException`;
    - `an object is reported once, whichever route sees it first`;
    - `a primitive is reported every time`;
    - `a handled AggregateError is split, first 10 only`;
    - `an unhandled AggregateError is one report`;
    - `reportUnhandled resolves when native resolves`;
    - `reportUnhandled resolves after 1500 ms when native never does` (fake timers);
    - `reportUnhandled resolves, and warns once, when native rejects or throws`;
    - `reportHandled never throws, even when native throws`;
    - `a payload with a lone surrogate crosses well-formed`.
  - `src/__tests__/exceptions-facade.test.ts`:
    - `logException validates options before crossing`;
    - `a non-Error logged from a named function has that function as its first frame`;
    - `logUnhandledException returns reportUnhandled's promise`;
    - `ExceptionOptions is exported`.
  - Run → FAIL.
- [x] **Green**
  - The modules, the facade, the mock (`logException` and `logUnhandledException` `jest.fn`s; `logUnhandledException` resolves by default) and the stubs.
  - `ios-spec-coverage`, `check-rn-compat.sh 0.81` and both example builds are green.
- [x] **Mutate**
  - (1) Drop `markReported` from `reportHandled`. `an object is reported once…` must fail.
  - (2) Race against a 5000 ms timer instead. `…after 1500 ms when native never does` must fail.
  - (3) Keep the facade's first frame. `a non-Error logged from a named function…` must fail.
  - Revert and record.
- [x] **Commit** — `feat(exceptions): logException and logUnhandledException, bridge stubbed`.

---

### Task 7.1c — Exceptions: Android bridge, and the keep rule

**Depends on:** 7.1b. Stream B, in parallel with 7.1d and with Stream A's 7.3.

**Files:**
- Create: `android/ReactNativeWebException.java`, `android/ExceptionBridge.java`, `androidTest/ExceptionBridgeTest.java`
- Create: `packages/react-native/android/consumer-rules.pro`
- Modify: `packages/react-native/android/build.gradle` (`defaultConfig { consumerProguardFiles 'consumer-rules.pro' }`), `android/BugseeModule.java` (replace the 7.1b stubs)
- Modify: `examples/bare/android/app/build.gradle` (`def enableProguardInReleaseBuilds = findProperty('bugseeE2eMinify') == 'true'`, with a comment naming Task 7.5a)
- Create: `scripts/__tests__/android-keep-rules.test.ts`

**Interfaces (plain Java, JVM-testable):**

```java
/** The backend routes React Native JS exceptions on this class name (worker: 'ReactNativeWebException' in name).
 *  consumer-rules.pro keeps the name through R8. Never rename or nest it. */
final class ReactNativeWebException extends Throwable {       // Throwable, as 6.x: crash.json exception_type "throwable"
    ReactNativeWebException(@NonNull String payloadJson) { super(payloadJson); }
}
final class ExceptionBridge {
    interface Sdk {                                             // prod adapter: Bugsee.logException / logUnhandledException
        void logException(Throwable t, @Nullable Map<String, Object> options);
        void logUnhandledException(Throwable t, @Nullable Map<String, Object> options);
    }
    /** domain -> String, labels -> List<String>, includeVideo -> Boolean; other keys dropped. null for null text.
     *  Unparseable text, or a wrongly typed value: BridgeJson.BadJson. */
    static @Nullable Map<String, Object> options(@Nullable String optionsJson) throws BridgeJson.BadJson;
    /** Never throws. Bad options are logged (code only) and the exception is still sent, without options. */
    static void logHandled(Sdk sdk, String payloadJson, @Nullable String optionsJson);
    /** Never throws. */
    static void logUnhandled(Sdk sdk, String payloadJson);
}
```

`consumer-rules.pro` (exact):

```
# The Bugsee backend routes React Native exceptions on this class name.
-keepnames class com.bugsee.reactnative.ReactNativeWebException
```

**Module:**
- `logException(payloadJson, optionsJson)` → `ExceptionBridge.logHandled(PROD_SDK, …)`, then logs `exception handled sent bytes=<payload length>`. It catches `RuntimeException`, like every void method.
- `logUnhandledException(payloadJson, promise)` → `ExceptionBridge.logUnhandled(PROD_SDK, …)`, which is synchronous in the SDK. It logs `exception unhandled sent bytes=<n>` and then `exception unhandled completed`, and resolves `null` in a `finally`, so it settles exactly once even if the SDK throws.

- [x] **Red**
  - `ExceptionBridgeTest`:
    - `theClassNameIsTheBackendContract` (`ReactNativeWebException.class.getName()` equals `"com.bugsee.reactnative.ReactNativeWebException"`, and the simple name contains `"ReactNativeWebException"`);
    - `theReasonIsThePayloadVerbatim` (`getMessage()` equals the input, byte for byte, including a non-BMP character);
    - `handledGoesToLogExceptionWithItsOptions`;
    - `unhandledGoesToLogUnhandledExceptionWithoutOptions`;
    - `optionsMapDomainLabelsAndIncludeVideo` (`labels` is a `List<String>`, `includeVideo` a `Boolean`);
    - `unknownOptionKeysAreDropped`;
    - `nullOptionsTextIsNullOptions`;
    - `unparseableOptionsStillSendTheException`;
    - `aWronglyTypedLabelIsABadJson`;
    - `aThrowingSdkDoesNotEscape` (both paths).
  - `android-keep-rules.test.ts`:
    - `consumer-rules.pro keeps ReactNativeWebException by name`;
    - `the library's build.gradle declares consumer-rules.pro`;
    - `ReactNativeWebException is a top-level class in com.bugsee.reactnative` (not nested; the file and the package line are read).
  - Run → FAIL.
- [x] **Green**
  - As specified.
  - `./gradlew :bugsee-android-bridge:testDebugUnitTest` and the example `assembleDebug` are green.
  - `assembleRelease -PbugseeE2eMinify=true` builds, and `apkanalyzer dex packages` (or `unzip -p … classes*.dex | strings`) of the release APK shows `com/bugsee/reactnative/ReactNativeWebException`. Record the command and its output.
- [x] **Mutate**
  - (1) Delete the keep line. The keep-rules test must fail. By hand, the minified APK must no longer contain the name. Record it.
  - (2) Pass `getLocalizedMessage` through a wrapper that trims the payload. `theReasonIsThePayloadVerbatim` must fail.
  - (3) Drop the `finally` resolve and let a throwing SDK escape. `aThrowingSdkDoesNotEscape` must fail.
  - Revert and record.
- [x] **Commit** — `feat(android): report JS exceptions as ReactNativeWebException, kept through R8`.

---

### Task 7.1d — Exceptions: iOS bridge

**Depends on:** 7.1b. Stream C, in parallel with 7.1c.

**Files:**
- Create: `support/BGSRNExceptions.m`, `support/include/BGSRNExceptions.h`, `supportTests/BGSRNExceptionsTests.m`
- Create: `support/BGSRNSettleOnce.m`, `support/include/BGSRNSettleOnce.h`, `supportTests/BGSRNSettleOnceTests.m`
- Modify: `ios/BugseeModule.mm` (replace the stubs; both import branches)

**Interface:**

```objc
FOUNDATION_EXPORT NSString *const BGSRNReactNativeExceptionName;   // @"ReactNativeWebException" -- the backend routes on it
@interface BGSRNExceptions : NSObject
/// `{domain?, labels?, includeVideo?}` as SDK options: domain -> exceptionDomain; includeVideo defaults to YES
/// (the SDK's own object defaults to NO). nil for nil text. Unparseable text or a wrongly typed value -> nil and *error.
+ (nullable BugseeExceptionLoggingOptions *)loggingOptionsFromJSON:(nullable NSString *)json
                                                             error:(NSError **)error;
@end

FOUNDATION_EXPORT const int64_t BGSRNUnhandledCompletionDeadlineMs;   // 1500, = UNHANDLED_REPORT_WAIT_MS
/// Runs `settle` exactly once: when the returned block is first called, or after `deadlineMs` on `queue`,
/// whichever comes first. The once-flag is atomic: the SDK may call back on any thread.
FOUNDATION_EXPORT dispatch_block_t BGSRNSettleOnce(int64_t deadlineMs, dispatch_queue_t queue, dispatch_block_t settle);
```

**Module (inside `BGSRNRunOnMain`):**
- `logException:optionsJson:` → `[Bugsee logException:BGSRNReactNativeExceptionName reason:payloadJson options:opts completion:nil]`.
  - Unparseable options are logged, and the exception is sent with `nil` options.
  - Then it logs `BugseeRN exception handled sent bytes=<n>`.
- `logUnhandledException:resolve:reject:` → `[Bugsee logUnhandledException:BGSRNReactNativeExceptionName reason:payloadJson completion:done]`.
  - The call is preceded by `exception unhandled sent bytes=<n>`.
  - `done = BGSRNSettleOnce(BGSRNUnhandledCompletionDeadlineMs, main, ^{ log "exception unhandled completed"; resolve(nil); })`.
  - A comment states why the deadline exists: on the simulator the SDK never calls this completion (verified facts), and a promise must still settle.

- [x] **Red** — `BGSRNSettleOnceTests`: `testSettlesOnceWhenCalled`; `testSettlesAtTheDeadlineWhenNeverCalled`; `testACallAfterTheDeadlineDoesNothing`; `testTwoConcurrentCallsSettleOnce` (two threads). `BGSRNExceptionsTests`:
  - `testTheNameIsTheBackendContract`;
  - `testDomainBecomesExceptionDomain`;
  - `testIncludeVideoDefaultsToYes`;
  - `testIncludeVideoFalseIsKept`;
  - `testLabelsAreKept`;
  - `testNilJsonIsNilOptions`;
  - `testUnparseableJsonIsAnError`;
  - `testANonStringLabelIsAnError`;
  - `testUnknownKeysAreIgnored`.
  - Run → FAIL.
- [x] **Green** — as specified. The iOS example builds on both delivery paths.
- [x] **Mutate**
  - (1) Remove the `includeVideo = YES` default. `testIncludeVideoDefaultsToYes` must fail.
  - (2) Change the name constant's value. `testTheNameIsTheBackendContract` must fail.
  - (3) Make the once-flag a plain `BOOL`. `testTwoConcurrentCallsSettleOnce` must fail, or be flaky; if it is only flaky, the test is wrong and gets a barrier that makes the race deterministic.
  - Revert and record.
- [x] **Commit** — `feat(ios): report JS exceptions as ReactNativeWebException`.

---

### Task 7.3 — Debug IDs: read `_bugseeDebugIds` and join them to frames

**Depends on:** 7.1b. Stream A, in parallel with 7.1c and 7.1d.

**Files:**
- Create: `src/exceptions/debugIds.ts`, `src/exceptions/__tests__/debugIds.test.ts`
- Modify: `src/exceptions/payload.ts` (the join), `src/exceptions/report.ts` (the call site: `debugIds: currentDebugIds()`), `payload.test.ts`

**Interfaces (exact):**

```ts
export const DEBUG_IDS_MAX = 64;
/** globalThis._bugseeDebugIds (stack string -> id), read defensively; each key's TOP frame's fileKey -> id.
 *  Non-object global, non-string ids, unparseable stacks and entries past 64 are skipped. Never throws. */
export function readDebugIdMap(globalObject: unknown): Map<string, string>;
/** readDebugIdMap(globalThis), recomputed only when the registration object's key count changes. */
export function currentDebugIds(): ReadonlyMap<string, string>;
```

In `buildExceptionPayload`:
- a frame whose `fileKey(file)` is in `debugIds` gets `debug_id`;
- the root gets `debug_ids` as a plain object of the **whole** map, entries in insertion order, when it is non-empty;
- no key when it is empty.

- [x] **Red**
  - `debugIds.test.ts`:
    - `an absent or non-object registration is an empty map`;
    - `a Hermes registration stack keys its id by the top frame's file`;
    - `a Metro-URL registration keys by the URL`;
    - `a non-string id is skipped`;
    - `an unparseable stack is skipped`;
    - `stops at 64 entries`;
    - `currentDebugIds recomputes when a bundle registers later`;
    - `never throws on a hostile registration object` (a `Proxy` whose `ownKeys` throws).
  - `payload.test.ts` additions:
    - `a frame in a registered file carries its debug_id`;
    - `a frame in another file carries none`;
    - `debug_ids is the whole map, as an object`;
    - `no debug_ids key when nothing is registered`;
    - `the join key is the same for a registration stack and a crash stack from one bundle` (both Hermes `address at` lines, one with `file://`).
  - Run → FAIL.
- [x] **Green** — as specified. `yarn test` and `yarn mutate:src` are green.
- [x] **Mutate**
  - (1) Key by the whole stack string instead of the top frame's file. `a Hermes registration stack keys…` must fail.
  - (2) Send `debug_ids` as an array of ids. `debug_ids is the whole map, as an object` must fail.
  - (3) Join on `cleanSource` instead of `fileKey`. `the join key is the same…` must fail, because the iOS `.app` case diverges.
  - Revert and record.
- [x] **Commit** — `feat(exceptions): attach source-map debug IDs to JS frames`.

---

### Task 7.2 — Global handlers: `ErrorUtils` and unhandled rejections

**Depends on:** 7.3, which is in `report.ts`. Stream A.

**Files:**
- Create: `src/exceptions/handlers.ts`, `src/exceptions/__tests__/handlers.test.ts`
- Modify: `src/index.ts` (`launch`, `relaunch`, `attach`), `scripts/check-rn-compat.sh` (the guard below), `src/__tests__/` facade tests as needed

**Interfaces (exact):**

```ts
export interface ErrorUtilsLike { getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void; }
export interface RejectionOptions { allRejections: true;
  onUnhandled(id: number, rejection: unknown): void; onHandled(id: number): void; }
export interface HandlerEnv {
  errorUtils(): ErrorUtilsLike | undefined;                        // global.ErrorUtils
  enableHermesTracker(): ((options: RejectionOptions) => void) | undefined;   // global.HermesInternal?.enablePromiseRejectionTracker, when hasPromise()
  enablePromiseLibraryTracker(): ((options: RejectionOptions) => void) | undefined; // require('promise/setimmediate/rejection-tracking').enable
  rnDevRejectionOptions(): Partial<RejectionOptions> | undefined;  // require('react-native/Libraries/promiseRejectionTrackingOptions').default
  isDev: boolean;                                                  // __DEV__
}
/** Idempotent per JS runtime. */
export function installExceptionHandlers(env?: HandlerEnv): void;
/** R7: false only when the launch options set com.bugsee.option.detect.crash to false. */
export function setExceptionCaptureEnabled(enabled: boolean): void;
```

**Behaviour:**
- `launch(token, options)` and `relaunch(options)` call `installExceptionHandlers()`, then `setExceptionCaptureEnabled(options['com.bugsee.option.detect.crash'] !== false)`.
- `attach()` installs, then reads `getLaunchOptions()` for the same key.
- **ErrorUtils.** `previous = getGlobalHandler()`, then `setGlobalHandler(onError)`. `onError(error, isFatal)`:
  - capture enabled and `markReported(error)`:
    - `isFatal === true` → `reportUnhandled(error)`, and **then** `previous(error, isFatal)` once it settles (at most 1.5 s);
    - otherwise → `reportHandled(error)`, then `previous(error, isFatal)` synchronously;
  - capture disabled or already reported → `previous(error, isFatal)` synchronously;
  - `previous` runs exactly once on every path, even when reporting throws. A throw in our code is caught and warned once.
- **Rejections.**
  - With Hermes (`HermesInternal.hasPromise()`), call `enablePromiseRejectionTracker(options)`. Otherwise call the `promise` library's `enable(options)`.
  - `options.onUnhandled(id, rejection)`: if capture is enabled and `markReported(rejection)`, then `reportHandled(rejection)`. Then, in dev only, call RN's own `onUnhandled(id, rejection)`, so LogBox still shows it.
  - `onHandled(id)`: in dev only, RN's `onHandled(id)`.
  - Document on `launch()`: the last caller of `enablePromiseRejectionTracker` wins; Hermes has no getter. Another SDK that installs a tracker after `launch()` replaces ours.
- **No `ErrorUtils`** (`RN$useAlwaysAvailableJSErrorHandling`): install the rejection tracker only, and warn once: `[Bugsee] ErrorUtils is unavailable; uncaught JS errors are not reported`.

**Internals guard (`check-rn-compat.sh`, per matrix version).** Fail with a named message unless:
- `Libraries/Core/setUpErrorHandling.js` calls `ErrorUtils.setGlobalHandler(`;
- `Libraries/Core/polyfillPromise.js` calls `enablePromiseRejectionTracker`;
- `Libraries/promiseRejectionTrackingOptions.js` exists and defines `onUnhandled`;
- `react-native/package.json` depends on `promise`;
- `src/private/renderer/errorhandling/ErrorHandlers.js` has `onUncaughtError` calling `handleException(error, true)`. This is R8's premise: if it stops being true, Task 7.4's root reporter must be revisited.

- [x] **Red** — `handlers.test.ts` (fake `ErrorUtils`, a fake Hermes tracker, fake timers):
  - `installs once however often launch runs`;
  - `a fatal error is reported as unhandled, then the previous handler runs with the same arguments`;
  - `the previous handler waits for the report, at most 1500 ms`;
  - `the previous handler runs even when reporting throws`;
  - `a non-fatal error is reported as handled and the previous handler runs synchronously`;
  - `an error already reported is not reported again, and the previous handler still runs`;
  - `detect.crash false: nothing is reported, and the previous handler still runs`;
  - `relaunch can turn capture back on`;
  - `with Hermes, an unhandled rejection is reported as handled`;
  - `in dev, RN's own rejection handlers still run`;
  - `in release, no RN rejection handlers are called`;
  - `without Hermes, the promise library's tracker gets the same options`;
  - `onHandled reports nothing`;
  - `without ErrorUtils, only the rejection tracker is installed, with one warning`.
  - Run → FAIL.
- [x] **Green**
  - As specified.
  - The guard passes for 0.81 and 0.87 (`./scripts/check-rn-compat.sh 0.81`, `… 0.87`).
  - `yarn test` and `yarn mutate:src` are green.
- [x] **Mutate**
  - (1) Call `previous` before the report settles. `the previous handler waits for the report…` must fail.
  - (2) Report a non-fatal error as unhandled. `a non-fatal error is reported as handled…` must fail.
  - (3) Skip the dev chain. `in dev, RN's own rejection handlers still run` must fail.
  - (4) Point the guard at a copy of 0.87 whose `ErrorHandlers.js` calls `handleException(error, false)`. The guard must fail (run by hand; record it).
  - Revert and record.
- [x] **Commit** — `feat(exceptions): report uncaught JS errors and unhandled rejections`.

---

### Task 7.4 — `<ErrorBoundary>` and the root reporter in `Bugsee.wrap`

**Depends on:** 7.2, and Phase 6's Task 6.4 (`wrap`) and Task 6.3 (`isWrapper`). Stream A.

**Files:**
- Create: `src/exceptions/ErrorBoundary.tsx`, `src/exceptions/RootErrorReporter.tsx`
- Create tests: `src/exceptions/__tests__/ErrorBoundary.test.tsx`, `src/exceptions/__tests__/RootErrorReporter.test.tsx`
- Modify: `src/viewtree/anchor.tsx` (`wrap` renders `<RootErrorReporter><Root {...props} /></RootErrorReporter>` beside the anchor), `src/viewtree/requests.ts` (`isWrapper` also matches `RootErrorReporter`), `src/viewtree/__tests__/walk.test.ts`, `src/index.ts` (export `ErrorBoundary` and its prop types)

**Interfaces (exact):**

```tsx
export interface ErrorBoundaryFallbackProps { error: unknown; componentStack: string | undefined; resetError(): void; }
export interface ErrorBoundaryProps {
  children?: React.ReactNode;
  fallback?: React.ReactElement | ((props: ErrorBoundaryFallbackProps) => React.ReactNode);
  onError?(error: unknown, componentStack: string | undefined): void;
  onReset?(error: unknown, componentStack: string | undefined): void;
  options?: ExceptionOptions;                       // passed to the handled report
}
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, { error: unknown; componentStack?: string; caught: boolean }> {}
// RootErrorReporter: internal, NOT exported from src/index.ts
export class RootErrorReporter extends React.Component<{ children?: React.ReactNode },
  { phase: 'ok' | 'reporting' | 'rethrow'; error: unknown }> {}
```

**`ErrorBoundary`:**
- `getDerivedStateFromError` → `caught: true`.
- `componentDidCatch(error, info)`:
  - `markReported(error)`, then `reportHandled(error, props.options, { componentStack: info.componentStack ?? undefined })`;
  - then `props.onError?.(…)`.
- It renders `fallback` (the element, or the function called with `resetError`), or `null` when there is none. `resetError` calls `onReset` and clears the state.
- Children are a `ReactNode` only. 6.x's function-as-children form is not carried.

**`RootErrorReporter` (R8):**
- `getDerivedStateFromError` → `{ phase: 'reporting', error }`, and it renders `null`.
- `componentDidCatch(error, info)`:
  - if capture is enabled (R7) and `markReported(error)`: `reportUnhandled(error, { componentStack })`, then `.finally(() => setState({ phase: 'rethrow' }))`;
  - otherwise `setState({ phase: 'rethrow' })` at once.
- In the `rethrow` phase, `render()` throws `state.error`. React finds no boundary above, so its `onUncaughtError` runs RN's fatal path.
- Document in the file header the soft-then-fatal sequence R8 records.

- [x] **Red**
  - `ErrorBoundary.test.tsx` (react-test-renderer; native mock):
    - `a render error below it is reported as handled, with its component stack`;
    - `renders the fallback element`;
    - `calls a fallback function with the error, the component stack and resetError`;
    - `renders null without a fallback`;
    - `onError gets the error and the component stack`;
    - `resetError calls onReset and renders the children again`;
    - `the caught error is not mutated` (its `cause` is unchanged);
    - `options reach the report`;
    - `an error reported once is not reported again by the boundary`.
  - `RootErrorReporter.test.tsx`:
    - `a render error below wrap is reported as unhandled, then rethrown`;
    - `renders nothing while the report is in flight`;
    - `rethrows after 1500 ms when native never answers`;
    - `an error the app's own boundary catches is never seen by the root`;
    - `with detect.crash false it rethrows without reporting`;
    - `an error already reported is rethrown without a second report`.
  - `walk.test.ts`: `the root reporter is not emitted, and its children are`.
  - Run → FAIL.
- [x] **Green** — as specified. `yarn test` and `yarn mutate:src` (with `.tsx`) are green.
- [x] **Mutate**
  - (1) Report from `RootErrorReporter` without rethrowing. `…is reported as unhandled, then rethrown` must fail.
  - (2) Assign `error.cause = …` in `ErrorBoundary`. `the caught error is not mutated` must fail.
  - (3) Drop `RootErrorReporter` from `isWrapper`. The walk test must fail.
  - Revert and record.
- [x] **Commit** — `feat(exceptions): ErrorBoundary, and a root reporter for uncaught render errors`.

---

### Task 7.6a — `bugsee-e2e-native`: an example-only native module (native crash, temp files)

**Depends on:** nothing in Phase 7. Stream D; it can start first.

**Files (all new unless stated):**
- `e2eNative/package.json`:
  - `"name": "bugsee-e2e-native"`, `"private": true`, `"main": "src/index.ts"`;
  - `"codegenConfig": { "name": "BugseeE2ENativeSpec", "type": "modules", "jsSrcsDir": "src", "android": { "javaPackageName": "com.bugsee.e2enative" }, "ios": { "modulesProvider": { "BugseeE2E": "BugseeE2EModule" } } }`.
- `e2eNative/react-native.config.js`:
  - `dependency.platforms.android` = `{ sourceDir: './android', packageImportPath: 'import com.bugsee.e2enative.BugseeE2EPackage;', packageInstance: 'new BugseeE2EPackage()' }`;
  - `ios` = `{ podspecPath: './BugseeE2ENative.podspec' }`.
- `e2eNative/src/NativeBugseeE2E.ts`, `e2eNative/src/index.ts`
- `e2eNative/android/build.gradle` (`com.android.library`, `com.facebook.react`, `externalNativeBuild { cmake { path 'src/main/cpp/CMakeLists.txt' } }`, `minSdk rootProject.ext.minSdkVersion`), `android/src/main/AndroidManifest.xml`
- `e2eNative/android/src/main/java/com/bugsee/e2enative/BugseeE2EModule.java`, `BugseeE2EPackage.java` (`BaseReactPackage`)
- `e2eNative/android/src/main/cpp/CMakeLists.txt`, `e2eNative/android/src/main/cpp/bugsee_e2e_native.cpp`
- `e2eNative/BugseeE2ENative.podspec` (`install_modules_dependencies(s)`), `e2eNative/ios/BugseeE2EModule.h`, `e2eNative/ios/BugseeE2EModule.mm`
- Modify: `examples/bare/package.json` (`"bugsee-e2e-native": "workspace:*"`)
- Create: `examples/bare/scenarios/native.ts` (scenario `e2e-native-smoke`), `examples/bare/e2e/e2e-native.test.ts`
- Modify: `examples/bare/App.tsx`, `scripts/__tests__/example-wiring.test.ts`

> **As built (Task 7.6a):**
> - `e2eNative/` is `examples/e2e-native/`: the root `workspaces` glob is `examples/*`, so this is where a workspace package resolves.
> - The module also ships `ios/Package.swift` and `ios/react-native-spm-prefix.h`. CI's `ios (spm)` job needs them: on SwiftPM, React Native refuses an autolinked dependency that has no `Package.swift`. `example-wiring.test.ts` pins the manifest.

**Spec and JS (exact):**

```ts
// e2eNative/src/NativeBugseeE2E.ts -- TurboModuleRegistry.getEnforcing<Spec>('BugseeE2E')
crashNative(kind: string): void;                               // Android: 'segv' | 'abort'. iOS: logs "Android-only" and returns.
writeTempFile(name: string, contents: string): Promise<string>; // UTF-8 into the app's cache dir; resolves the absolute path
fileExists(path: string): Promise<boolean>;
// e2eNative/src/index.ts
export type NativeCrashKind = 'segv' | 'abort';
export function crashNative(kind: NativeCrashKind): void;      // TypeError for any other kind, before crossing
export function writeTempFile(name: string, contents: string): Promise<string>;  // name: /^[\w.-]{1,64}$/, else TypeError
export function fileExists(path: string): Promise<boolean>;
```

**Native:**
- Android `crashNative` calls `nativeCrash(0 | 1)`, a JNI function:
  - `0`: `*(volatile int *) nullptr = 0x42;` (SIGSEGV);
  - `1`: `abort()` (SIGABRT).
- `System.loadLibrary("bugsee_e2e_native")` runs in a static block. The CMake target is `bugsee_e2e_native`, compiled with `-O0`, so the volatile store survives.
- `writeTempFile` writes to `getReactApplicationContext().getCacheDir()`; iOS writes to `NSTemporaryDirectory()`.

**Scenario `e2e-native-smoke`:**
- After `Launched`, `writeTempFile('smoke-<n>.txt', 'smoke <n>')`, then log `BUGSEE_E2E native tmp path=<p> exists=<fileExists(p)>`.
- `crashNative('bogus' as never)` inside `try`; log `BUGSEE_E2E native bad-kind code=<error name>`.

**Cases (`e2e/e2e-native.test.ts`, both platforms, debug build):**
1. `writeTempFile returns an absolute path that exists` — the path starts with `/` and `exists=true`.
2. `an unknown crash kind is rejected in JS` — `bad-kind code=TypeError`, and the process is still alive 2 s later.

- [x] **Red**
  - `example-wiring.test.ts`:
    - `bugsee-e2e-native is a dependency of the bare example only` (no `packages/*/package.json` names it);
    - `no library source imports bugsee-e2e-native`.
  - Write the device test. Run it before wiring → FAIL at the first marker.
- [x] **Green**
  - `yarn install`.
  - The Android example `assembleDebug` links `libbugsee_e2e_native.so` (it is listed in the APK's `lib/arm64-v8a/`).
  - `pod install` picks up `BugseeE2ENative`, and the iOS example builds on the CocoaPods path.
  - Both cases pass on the WOD_LX1 and on the simulator.
- [x] **Mutate** — make `writeTempFile` resolve the bare file name. Case 1 must fail. Revert and record.
- [x] **Commit** — `test(example): bugsee-e2e-native, a native crash and temp files for the device tests`.

---

### Task 7.6b — Device verification, Android: a real native crash reaches a report

**Depends on:** 7.6a. Stream D. It runs on the WOD_LX1 before 7.5a.

**Files:** create `e2e/native-crash.test.ts`; extend `scenarios/native.ts` (scenarios `native-crash-segv`, `native-crash-abort` and `native-crash-observe`); modify `App.tsx`.

**Scenarios:**
- `native-crash-<kind>`:
  - register a report handler before `launch()`, whose `onAfterReportCreated` logs `BUGSEE_E2E native after type=<type>`;
  - after `Launched`, log `BUGSEE_E2E native crashing kind=<kind>`, then `crashNative(kind)`.
- `native-crash-observe`: the same handler, and nothing else.

**Retention:** as 3.4d: airplane mode, bundles cleared and the clear asserted.

**Cases (debug build; each kind is one run plus one relaunch):**
1. `crashNative('segv') kills the process with SIGSEGV` — logcat has `Fatal signal 11 (SIGSEGV)` after the `crashing kind=segv` marker, and `pidOf()` is empty within 10 s.
2. `the relaunch recovers it as a native crash` — relaunch with `native-crash-observe`. Exactly one bundle whose request `type` is `crash`, with:
   - `crash.json` `ndkCrash === true`;
   - `exception_type === 'native'`;
   - `signal.name === 'SIGSEGV'` and `signal.number === 11`.
3. `the NDK relaunch recovers on the bounded path, not JS` — the relaunch log has `report handler - completed by=recovery` (NDK early recovery on `bugsee-report-handler-bounded`; Task 3.4d's Java recovery was the live `BugseeReportHandlerThread`, this one is not), and `BUGSEE_E2E native after type=crash` is absent for that run.
4. `crashNative('abort') is SIGABRT` — cases 1–2 again with `kind=abort`: `Fatal signal 6 (SIGABRT)`, and `signal.name === 'SIGABRT'`.

- [x] **Red/Green** — all four cases pass on the WOD_LX1.
- [x] **Mutate** — make `crashNative` throw a Java `RuntimeException` instead. Case 2 must fail on `ndkCrash`. Revert and record.
- [x] **Commit** — `test(e2e): a native crash from JS reaches an Android report`. The body records the banner, both signals, and each bundle's `signal` object.

Task 3.4d's external `adb shell run-as … kill -11 <pid>` stays in place. This task gives the NDK path its own coverage and leaves 3.4d alone.

---

### Task 7.5a — Device verification, Android: exceptions end to end

**Depends on:** 7.1c, 7.2, 7.3, 7.4, 7.6b (the device).

**Files:**
- Create: `scenarios/exceptions.tsx` (scenarios `exc-handled`, `exc-rejection`, `exc-fatal`, `exc-boundary`, `exc-root`, `exc-prelaunch` and `exc-observe`), `e2e/exceptions.test.ts`
- Modify: `App.tsx`, `e2e/bundles.ts` (add `crashOf(bundle): Record<string, unknown> | undefined`, the parsed `crash` capture), `scripts/__tests__/e2e-capture-files.test.ts` (`crashOf parses the crash capture`)

**Shared scenario pieces.** Every value carries the run's nonce `<n>`.
- `ID = '8a1c2f4e-0d3b-5e6f-9a7b-' + <n>.padStart(12, '0').slice(-12)`.
- Before the first throw, the scenario registers `globalThis._bugseeDebugIds = { [new Error().stack!]: ID }` from inside a function in `scenarios/exceptions.tsx`. Its top frame is in the same bundle as every throw site, which simulates Phase 13's stub.
- `function bugseeE2EThrowSite(n: string): never`:
  - `const e = new TypeError(\`E2E handled ${n}\`)`;
  - `(e as any).cause = new RangeError(\`inner ${n}\`)`;
  - `(e as any).secretToken = \`tok-${n}\``;
  - `throw e`.
- Before `launch()`, an app-level handler is installed: `ErrorUtils.setGlobalHandler((e, f) => { log('BUGSEE_E2E exc app-handler fatal=' + f); rnDefault(e, f); })`, where `rnDefault` is RN's handler read first. It proves the chain.

**Scenarios:**
- `exc-handled`:
  - catch `bugseeE2EThrowSite(n)`, then `Bugsee.logException(e, { domain: \`e2e-${n}\`, labels: ['e2e', \`lbl-${n}\`], includeVideo: true })`;
  - `Bugsee.logException({ password: \`pw-${n}\`, message: \`obj-${n}\` })`;
  - marker `BUGSEE_E2E exc handled-sent nonce=<n>`.
- `exc-rejection`: `Promise.reject(new Error(\`E2E rejection ${n}\`))`, never handled; marker after 3 s.
- `exc-fatal`: `setTimeout(() => { throw new Error(\`E2E fatal ${n}\`); }, 0)`.
- `exc-boundary`:
  - `<ErrorBoundary fallback={<BoundaryFallback n={n} />} onError={() => log('BUGSEE_E2E exc boundary-onError')}><BugseeE2EThrower n={n} /></ErrorBoundary>`;
  - `BugseeE2EThrower` throws `new Error(\`E2E boundary ${n}\`)` in render;
  - `BoundaryFallback`'s effect logs `BUGSEE_E2E exc boundary-fallback`.
- `exc-root`: renders `BugseeE2EThrower` with no app boundary. The example root is `Bugsee.wrap(App)`, from Task 6.4.
- `exc-prelaunch`: `Bugsee.logException(new Error(\`pre-${n}\`))` **before** `launch()`, then the marker `BUGSEE_E2E exc prelaunch-sent nonce=<n>`.
- `exc-observe`: the relaunch for a gated case. It launches and does nothing else.

**The payload of a bundle** is `JSON.parse(crashOf(b).exception.reason)`, after asserting that the reason starts with `{`: there is no prefix to strip, on either platform.

**Cases (`e2e/exceptions.test.ts`, debug build, one run per scenario):**
1. `a handled exception is an error report named ReactNativeWebException` (plain `it`, the identity check):
   - exactly one bundle whose payload `reason` is `E2E handled <n>`;
   - `request.type === 'error'` and `crash.json` `handled === true`;
   - `exception.name === 'com.bugsee.reactnative.ReactNativeWebException'`.
2. `the reason is the JS payload`:
   - `name === 'TypeError'`;
   - `frames[0].data.member === 'bugseeE2EThrowSite'`;
   - `signature` matches `/^[0-9a-f]{40}$/`;
   - `platform_os === 'android'`;
   - `cause` is `{ name: 'RangeError', reason: 'inner <n>' }`.
3. `debug IDs travel as a map and on each frame of the bundle`:
   - `debug_ids` deep-equals `{ [K]: ID }`, where `K` is `frames[0]`'s file key;
   - every frame with that file key has `debug_id === ID`.
4. `the payload carries nothing else of the error`:
   - no bundle's raw `crash` capture contains `tok-<n>` or `pw-<n>`;
   - the object bundle's payload `reason === 'obj-<n>'` and its `name === 'Error'`.
5. `the domain reaches the report` — `crash.json` `exception.domain === 'e2e-<n>'`.
6. `the client signature carries the JS signature` — `exception.additional_signature === payload.signature`.
7. `labels reach the report` — **`it.failing` on Android** (7.3.0 ignores them; "To raise"): `request.labels ⊇ ['lbl-<n>']`.
8. `an unhandled rejection is one error report` — exactly one bundle with payload `reason === 'E2E rejection <n>'` and `request.type === 'error'`.
9. `a fatal JS error is reported as a crash, then RN's handler runs`:
   - a bundle with payload `reason === 'E2E fatal <n>'` and `request.type === 'crash'`;
   - the log order is `BugseeRN exception unhandled sent`, then `… unhandled completed`, then `BUGSEE_E2E exc app-handler fatal=true`;
   - the process is alive 3 s later (debug: red box).
10. `the fatal error files no second report for the incident` — **`it.failing` on Android** (7.3.0 also files an error report, `e1d56ed65`): no bundle other than case 9's contains `E2E fatal <n>`.
11. `a boundary catches, reports as handled and renders the fallback`:
    - one bundle with `reason === 'E2E boundary <n>'` and `request.type === 'error'`;
    - its innermost cause is named `ErrorBoundary Error` and has a frame whose `member` is `BugseeE2EThrower`;
    - the `boundary-onError` and `boundary-fallback` markers appear.
12. `a render error with no boundary is reported once, as a crash, by the root reporter`:
    - exactly one bundle with `reason === 'E2E boundary <n>'` (from `exc-root`) and `request.type === 'crash'`;
    - `exception unhandled sent` precedes RN's red-box log line (`ReactNativeJS` `E` level with the message).
13. `nothing reported before launch reaches a bundle` — the `prelaunch-sent` marker precedes `Launched` (the experiment ran), and no bundle contains `pre-<n>`.

**Gated `E2E_RELEASE=1`** (the release build from the shared ground, which is also minified):
- `exc-fatal` kills the process: logcat has `FATAL EXCEPTION` and `com.facebook.react.common.JavascriptException`, and `pidOf()` is empty.
- Relaunch `exc-observe`. Then:
  - R1 `ours survives R8` — a crash bundle whose `exception.name === 'com.bugsee.reactnative.ReactNativeWebException'` and payload `reason === 'E2E fatal <n>'`;
  - R2 `RN's own crash is the second report` — exactly one crash bundle whose `exception.name` contains `JavascriptException` and whose raw reason contains `E2E fatal <n>`. This pins R13;
  - R3 = case 10's `it.failing`, on this build too.

- [x] **Red** — write the test and the scenarios. Run once before wiring `App.tsx` → FAIL at the first marker.
- [x] **Green**
  - Cases 1–13 pass on the WOD_LX1, with the two documented `it.failing` cases failing for the right reason (record the labels array and the extra error bundle).
  - The gated R1–R3 pass on the release build.
- [x] **Mutate**
  - (1) Delete the keep rule and rebuild the release APK. R1 must fail on `exception.name`.
  - (2) Skip `previous` in the global handler. Case 9 must fail: there is no `app-handler` marker.
  - (3) Send `debug_ids` as a list. Case 3 must fail.
  - (4) Make `RootErrorReporter` swallow instead of rethrow. Case 12's red-box line must be missing.
  - Revert and record.
- [x] **Commit** — `test(e2e): JS exceptions in Android bundles, handled, unhandled and from render`. The body records the banner, one payload verbatim (its nonce values are synthetic), and the full list of bundles R1–R3 produced.

**If a prediction is wrong**, stop and report rather than loosening the assertion. The predictions are: case 12's red box, and R2's `JavascriptException` bundle. The controller rules on the change.

**Ruling (2026-10-01, WOD_LX1, Android SDK 7.3.0 `beb390dc0`).** Case 12's red box was present. R2's second Bugsee crash was not: the release run retains one `com.bugsee.reactnative.ReactNativeWebException` bundle, logcat still shows `JavascriptException`, and the process dies. R2 and R3 are plain assertions of that single bundle. Debug case 10 stays `it.failing`. Do not raise a double-report. Mutation 1 (delete the keep rule) did not rename the class: this example's R8 renames nothing. The keep rule stays. The keep-rules unit test is the lock.

---

### Task 7.5b — Device verification, iOS: the simulator's documented behaviour, and the iPhone

**Depends on:** 7.1d and 7.5a (the same files).

**Files:** `e2e/exceptions.test.ts` runs under `E2E_PLATFORM=ios`; modify `examples/bare/scripts/run-ios.sh` (`IOS_CONFIGURATION`, default `Debug`, which selects `-configuration` and the `APP` path `ios/build/Build/Products/${IOS_CONFIGURATION}-iphoneos/BareExample.app`); `scripts/__tests__/` gains `run-ios-configuration.test.ts` (`the embed check follows IOS_CONFIGURATION`).

**On the simulator (`E2E_IOS_TARGET=simulator`)** the SDK compiles `logException`/`logUnhandledException` out (verified facts). One case replaces cases 1–13:
- `the simulator slice reports no JS exception` — run `exc-handled`, then:
  - the `BugseeRN exception handled sent` line appears, which proves the call reached the SDK;
  - 15 s later there are zero bundles.
- The file header says why. This pins the SDK's behaviour, so the day it changes, the test fails.

**On the iPhone (`E2E_IOS_TARGET=device`, Debug build, `DEAD_ENDPOINT` retention).** Cases 1–13 apply with these iOS values, each stated:
- Case 1: `exception.name === 'ReactNativeWebException'`, and `crash.json` has `managed === true` and `type === 'ios'`.
- Case 2: `platform_os === 'ios'`.
- Case 5: `exceptionLoggingOptions.exceptionDomain === 'e2e-<n>'`, and `exceptionLoggingOptions.includeVideo === true`.
- Case 7: a plain `it`. iOS applies labels.
- Cases 9 and 12: the unhandled report is **stored, not sent**. After the markers, `terminateIosApp()`, then relaunch `exc-observe`. Exactly one recovered bundle with `request.type === 'crash'` and payload `reason === 'E2E fatal <n>'` (or `E2E boundary <n>` for case 12).
- Case 10: a plain `it` on iOS. There is no second report in the Debug build.

**Gated `E2E_RELEASE=1` on the iPhone** (`IOS_CONFIGURATION=Release`): `exc-fatal` kills the process (the console stream ends). Relaunch `exc-observe`. **Exactly one** crash bundle for the incident, named `ReactNativeWebException`: the overriding report replaces `RCTFatalException`'s. If a second, `RCTFatalException` bundle arrives, stop and report.

- [x] **Red/Green** — the simulator case passes on the iOS 26.5 simulator. Cases 1–13 pass on the iPhone XS.
- [x] **Mutate** — make `BGSRNReactNativeExceptionName` `@"ReactNativeException"`. Case 1 must fail on the iPhone. Revert and record.
- [x] **Commit** — `test(e2e): JS exceptions in iOS bundles, on the iPhone` (`5667fa5`), then `test(e2e): pin iOS unhandled recovery as failing on beta3` (`fb9449b`).

**Ruling (2026-10-01, KRSFT, iOS SDK 7.0.0-beta3 `0d9c9d0a-9`).** The live list is empty before terminate. `terminateIosApp()` then `exc-observe` recovers zero bundles. Release dies and also recovers zero bundles, with no `RCTFatalException`. beta3 claims `live_report.plcrash` and does not claim `override_report.plcrash`. The harness must not copy one onto the other. The one-crash assertions for cases 9 and 12 and the Release gate are `it.failing`. Case 1's name mutation failed as required and was reverted.

**Hardware pass: add to Task 3.H:**
- Task 7.5b whole on the iPhone, including the gated Release case;
- Task 7.5a's gated `E2E_RELEASE=1` cases on the WOD_LX1.

---

### Phase 7 review gate

Spawn a reviewer subagent. It must independently:
- run `yarn test`, `yarn mutate:src`, the JVM tests, the Support XCTests, and `check-rn-compat.sh` for 0.81 and 0.87;
- confirm by reading the code that:
  - no path serialises a thrown non-Error value, and the payload builder reads no error property beyond `name`, `message`, `stack`, `cause` (and `errors` at the entry);
  - every route (facade, `ErrorUtils`, rejections, `<ErrorBoundary>`, root reporter) goes through `markReported`, so no error object is reported twice;
  - the previous global handler runs exactly once on every path, fatal or not, enabled or not, reporting or throwing;
  - `logUnhandledException` settles on every native path, and JS never waits past `UNHANDLED_REPORT_WAIT_MS`;
  - neither native parses, logs or truncates the payload;
  - `consumer-rules.pro` ships in the AAR (unzip the built AAR and read `proguard.txt`);
- **rerun** 7.5a (with the gated release cases), 7.6b, and 7.5b on the simulator.

Record, for the controller:
- R13 (the second Android crash report per fatal JS error);
- the four SDK gaps this phase adds to "To raise".

- [x] **Gate (2026-10-01, `fb9449b`).** Passed. `yarn test` 1609, mutation 95.15, JVM 207, XCTest 183 on simulator `6FA9B3E8`, compat 0.81.6 and 0.87.1. WOD_LX1 `AMRJCP4718402860`: 7.5a debug and release, 7.6b 4/4. Simulator 7.5b: handled-sent line, then zero bundles. R13 stays the ruling above. `includeVideo` is documented and not pinned by a test.

---

## Phase 8 — Reporting

**Ships:**
- `upload(summary, description, severity?, labels?)`, the severity and labels forms beside Task 3.4c's two-argument one. There is no `includeVideo`, and a fifth argument throws;
- `showReportDialog(summary?, description?, severity?, labels?)`;
- `createReport()`, a report the app fills and then uploads;
- attachments through the report handler (Phase 3's `addFileAttachment`/`addDataAttachment`), now proven on device for files, copied and moved;
- device proof, from retained bundles, that each of these files the issue it should.

### Planner rulings (reviewable; change them here)

- **P1. `upload` stays positional, as both SDKs are:** `upload(summary, description, severity?, labels?)`.
  - 6.x's fifth parameter, `includeVideo`, is gone in 7.x (design §10.1 "Removed"). Passing a fifth argument throws `TypeError` (`arguments.length > 4`), so a 6.x call site fails loudly instead of losing its flag.
  - A type-level test (`// @ts-expect-error`) pins the signature.
- **P2. `showReportDialog(summary?, description?, severity?, labels?)` is positional too.** 6.x took the first three; both 7.x SDKs add labels.
- **P3. One native method each; "not given" crosses as a sentinel, and the SDK default is resolved natively.**
  - The spec's `upload` changes to `(summary, description, severity: number, labels: string[] | null)`, where `0` means the SDK's default.
  - Android passes a `null` severity: the SDK applies its default.
  - iOS resolves `0` to the launch option `com.bugsee.option.reporting.defaults.bug-priority`, or to `High` (3) when that is missing. The alternative, the SDK's own two-argument selector, cannot carry labels.
  - `showReportDialog` crosses the same way. iOS's dialog path already skips a `0` severity (`if (level)`, verified).
- **P4. `createReport()` resolves `BugseeCreatedReport | null`,** and has its own registry and its own `createdReport*` spec methods, not the handler's `report*` ones.
  - iOS hands out a `BugseeExtendedReport`, not a `BGSReportContract`.
  - A created report has no deadline, and on iOS no id or type.
  - `null` means the SDK made none (not launched).
- **P5. One created report is outstanding per JS runtime.** A second `createReport()` before the first is uploaded rejects with the new stable code `E_REPORT_CREATE_BUSY`.
  - Why: iOS beta3's `BugseeExtendedReport` keeps its attributes in a file-scope global, so a second created report wipes the first's attributes (verified; "To raise").
  - One at a time also bounds what native holds.
  - A created report is released by `upload()` and by a JS reload (module `invalidate`).
  - Neither SDK has a discard. Android drops an un-submitted created report at the next launch's recovery (verified). What iOS does with one is not asserted anywhere.
  - Lift the rule when the SDK is fixed.
- **P6. The handler's timing around a created report differs per platform. It is documented and pinned, not normalised.**
  - Android runs `onBeforeReportCreated` inside `createReport`, before the promise resolves, and `onAfterReportCreated` at upload.
  - iOS runs both at upload, **after** it copies the created report's fields over (`applyExtendedReport`). A handler's `setLabels` there replaces the app's labels.
- **P7. iOS created-report attachments: at most 3, each of at most 3 MiB.** The SDK drops the rest silently at upload. The bridge enforces both limits when the attachment is added and rejects with `E_REPORT_ATTACHMENT_REJECTED`, the Phase 5 "no silent drop" rule.
  - iOS created reports have no `move` and no `mimeType` (`BugseeAttachment` has neither). JS accepts `mimeType`, and iOS ignores it, which is documented.
  - Android uses `Report.addAttachment`, capped at 1000.
- **P8. "Attachments via the ReportHandler" means Phase 3's `BugseeReport.addFileAttachment`/`addDataAttachment`. No new attachment API is added.** Phase 8 adds the device proof for file attachments, copy and move, which Task 3.4d could not stage because JS cannot create a file. `bugsee-e2e-native`'s `writeTempFile` (Task 7.6a) creates the file.
- **P9. Submitting the report dialog.**
  - The pre-fill is proven on both platforms through the wrapper's `onBeforeReportCreated`, which both SDKs run **before** the dialog opens (verified), plus the `BeforeReportShown` lifecycle event.
  - The submitted bundle is proven on Android with a `uiautomator` tap.
  - On the iPhone, a person taps Send in a gated case (`E2E_IOS_OPERATOR=1`) on the Task 3.H list: this machine has no XCUITest target, idb or maestro for the harness to tap with.
- **P10. The trigger type differs.** iOS `uploadWithSummary:…` files `source.type = "unknown"` (`BGSReportingTriggerTypeUnknown`), while Android files `code_upload`. The device test asserts `code_upload` on both platforms, with the iOS case `it.failing` ("To raise").

### Verified facts (2026-09-29)

**Android `v7.3.0`:**
- `showReportDialog()`, `(summary, description)`, `(…, IssueSeverity)` and `(…, IssueSeverity, ArrayList<String> labels)` all take nullable arguments.
- `upload(summary, description)`, `(…, IssueSeverity)` and `(…, IssueSeverity, List<String> labels)` also take nullable arguments.
- `createReport(ReportCreationListener)` → `onCreated(@Nullable Report)`, delivered on main.
  - It runs `onBeforeReportCreated` before the listener (`createAndPrepareBugReport`).
  - Its request is persisted so that a report never submitted is discarded by the next launch's recovery.
- `upload(Report)` and `upload(Report, Callback1<Boolean>)` run `onAfter`, bounded, and call back after processing is scheduled.
- `Report` is the same interface the handler gets, so `ReportOps` works on it unchanged.
- The dialog and `upload` are no-ops before launch (`Log.w`).
- The trigger types are `DialogFromCode` (`code_dialog`) and `Upload` (`code_upload`).

**iOS `7.0.0-beta3` (`0d9c9d0a3`):**
- `showReportDialog`; `…WithSummary:description:`, `…:severity:` and `…:severity:labels:`. The summary and description are `nonnull`.
  - The dialog path creates the report, seeds only the fields given (`if (summ)`, `if (level)`, `if (labels)`), runs the wrapper's `onBeforeReportCreated`, then presents the dialog.
- `uploadWithSummary:description:` (the default priority) and `…:severity:` / `…:severity:labels:` use `TriggerTypeUnknown`.
- `createReportWithCompletion:` → `BugseeExtendedReport`, or `nil` when not `Launched` or when the request fails to open. A report is delivered on main, although the header says otherwise.
- `uploadReport:completion:`:
  - copies the fields over (`applyExtendedReport`: it clears the labels, attributes and attachments, then copies them);
  - runs the wrapper's before and after handlers;
  - calls `completion` on main once the report is persisted and scheduled.
- A created report's attachments are capped at 3 (`ATTACHMENTS_LIMIT`) and 3 MiB each (`MAX_SIZE_ATTACHMENT`); empty data is dropped.
- A handler report holds up to 1000 attachments (`kBGSMaxReportAttachments`).
- `BugseeExtendedReport` stores `internalAttributes` and `screenshotInitialized` in **file-scope globals**, and `-init` resets them.
- `showReportDialog*` and `upload*` are no-ops unless the SDK is `Launched`.

**Bundle:** `request.json` carries `type`, `summary`, `description`, `labels`, `severity` and `source.type`. A manifest `attachment` entry is `{name, mimeType, fileName}` (`sdk/reporting/bundle/request.md`, `manifest.md`).

### Constants

| Name | Value | Where |
|---|---|---|
| `ReportErrorCode.CreateBusy` | `'E_REPORT_CREATE_BUSY'` | `src/report/errors.ts`; both natives |
| `BGSRNCreatedReportAttachmentMaxCount` | `3` | iOS Support (mirrors `ATTACHMENTS_LIMIT`) |
| `BGSRNCreatedReportAttachmentMaxBytes` | `3145728` | iOS Support (mirrors `MAX_SIZE_ATTACHMENT`) |
| `BGSRNDefaultBugPriorityFallback` | `3` (`BugseeSeverityHigh`) | iOS Support |
| `ANDROID_REPORT_SEND_RESOURCE_ID` | pinned by Task 8.3a Step 0 | `e2e/report-dialog.ts` |

**Log lines** (`BugseeRN`):
- `created report <handle> created`
- `created report - busy`
- `created report - none`
- `created report <handle> uploaded ok=<b>`

### Execution order and parallel streams

8.1 → 8.2a → (8.2b ∥ 8.2c) → 8.3a → 8.3b.

8.1 and 8.2a both change `NativeBugsee.ts`, `index.ts`, the mock and both module files, so they are sequential. 8.2b (`android/**`) and 8.2c (`ios/**`) run in parallel. The two device tasks share their test files, so 8.3b follows 8.3a.

---

### Task 8.1 — `upload` with severity and labels, and `showReportDialog`

**Depends on:** Phase 7's gate.

**Files:**
- Modify: `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`, `src/__tests__/upload.test.ts`
- Create: `src/__tests__/report-dialog.test.ts`, `src/report/fields.ts` (the shared validation)
- Create: `android/ReportArgs.java`, `androidTest/ReportArgsTest.java`; modify `android/BugseeModule.java`
- Create: `support/BGSRNReportArgs.m`, `support/include/BGSRNReportArgs.h`, `supportTests/BGSRNReportArgsTests.m`; modify `ios/BugseeModule.mm` (both import branches)

**TurboModule (exact):**

```ts
// changed (was: upload(summary: string, description: string): void)
upload(summary: string, description: string, severity: number, labels: string[] | null): void;  // severity 0 = SDK default
// added
showReportDialog(summary: string | null, description: string | null, severity: number, labels: string[] | null): void;
```

**Public JS API (exact):**

```ts
// src/report/fields.ts
/** 0 for undefined; RangeError unless an integer 1..5. */
export function severityArgument(severity: unknown, method: string): number;
/** null for undefined; TypeError unless an array of strings; a fresh copy. */
export function labelsArgument(labels: unknown, method: string): string[] | null;
// src/index.ts, on class Bugsee
upload(summary: string, description: string, severity?: IssueSeverity, labels?: readonly string[]): void;
showReportDialog(summary?: string, description?: string, severity?: IssueSeverity, labels?: readonly string[]): void;
```

- `upload` throws `TypeError` when `arguments.length > 4`, with the message `Bugsee.upload takes at most four arguments; 7.x has no includeVideo`. The summary and description checks stay as they are.
- `showReportDialog`'s summary and description are `undefined` or a string (`TypeError` otherwise), and cross as `null` when absent.
- Errors never echo a value.
- Both methods document that they do nothing before `launch()`, and that the dialog runs `onBeforeReportCreated` before it opens.

**Android:**

```java
final class ReportArgs {
    static @Nullable IssueSeverity severity(int wire);                 // 0 -> null; 1..5 -> IssueSeverity.fromIntValue(n); else null, logged
    static @Nullable ArrayList<String> labels(@Nullable List<?> wire);  // null -> null; non-strings dropped
}
```

- `upload` → `Bugsee.upload(summary, description, ReportArgs.severity((int) severity), ReportArgs.labels(labels == null ? null : labels.toArrayList()))`.
- `showReportDialog` → `UiThreadUtil.runOnUiThread(() -> Bugsee.showReportDialog(summary, description, sev, labels))`.
- Both catch `RuntimeException`.

**iOS:**

```objc
FOUNDATION_EXPORT const NSInteger BGSRNDefaultBugPriorityFallback;     // 3
/// requested if 1..5; else launchOptions[BugseeOptionReportingDefaultBugPriority] if 1..5; else 3.
FOUNDATION_EXPORT NSInteger BGSRNUploadSeverity(NSInteger requested, NSDictionary *_Nullable launchOptions);
/// nil for nil; the NSString elements otherwise.
FOUNDATION_EXPORT NSArray<NSString *> *_Nullable BGSRNStringArray(NSArray *_Nullable raw);
```

Both methods run inside `BGSRNRunOnMain`.
- `upload:description:severity:labels:` → `[Bugsee uploadWithSummary:… description:… severity:(BugseeSeverityLevel)BGSRNUploadSeverity(severity, [Bugsee getLaunchOptions]) labels:BGSRNStringArray(labels)]`.
- `showReportDialog:…` → `[Bugsee showReportDialog]` when every argument is absent (`nil`, `nil`, `0`, `nil`). Otherwise → `showReportDialogWithSummary:summary description:description severity:(BugseeSeverityLevel)severity labels:BGSRNStringArray(labels)`. An omitted summary or description stays `nil`. beta3 writes the field only when the pointer is non-nil, and `@""` would pre-fill an empty string.

- [x] **Red**
  - `upload.test.ts`:
    - `the two-argument form crosses severity 0 and null labels`;
    - `severity crosses by value`;
    - `labels cross as a copy`;
    - `rejects severity 0, 6, 2.5 and a string before crossing` (`RangeError`/`TypeError`);
    - `rejects labels that are not strings before crossing`;
    - `a fifth argument throws TypeError and crosses nothing`;
    - `upload has no fifth parameter` (a `// @ts-expect-error` call that must fail to typecheck);
    - `no message contains the rejected value`.
  - `report-dialog.test.ts`:
    - `no arguments crosses null, null, 0, null`;
    - `every argument crosses in order`;
    - `a non-string summary or description throws before crossing`;
    - `severity and labels are validated as upload's`.
  - `ReportArgsTest`:
    - `zeroIsTheSdkDefault`;
    - `severityIsByValueNotOrdinal` (4 → `Critical`, 1 → `VeryLow`);
    - `outOfRangeIsTheDefault`;
    - `labelsBecomeAnArrayList`;
    - `nullLabelsStayNull`;
    - `nonStringLabelsAreDropped`.
  - `BGSRNReportArgsTests`:
    - `testARequestedSeverityWins`;
    - `testZeroTakesTheLaunchOption`;
    - `testZeroWithoutTheOptionIsHigh`;
    - `testAnOutOfRangeOptionIsHigh`;
    - `testStringArrayKeepsStrings`;
    - `testStringArrayOfNilIsNil`.
  - Run → FAIL.
- [x] **Green**
  - As specified.
  - `ios-spec-coverage`, `check-rn-compat.sh 0.81` (its java-signatures step sees the changed `upload`), both example builds and every existing `upload` call site (scenarios) are green. The existing call sites still compile unchanged.
- [x] **Mutate**
  - (1) Map the Android severity with `IssueSeverity.values()[n]`. `severityIsByValueNotOrdinal` must fail.
  - (2) Drop the `arguments.length` guard. `a fifth argument throws…` must fail.
  - (3) Make `BGSRNUploadSeverity` return `requested` unconditionally. `testZeroTakesTheLaunchOption` must fail.
  - Revert and record.
- [x] **Commit** — `feat(report): upload with severity and labels, and showReportDialog` (`c437703`). Reviewed: no findings. No device e2e in this task.

---

### Task 8.2a — `createReport`: JS API, types, spec and stubs

**Depends on:** 8.1.

**Files:**
- Create: `src/report/CreatedReport.ts`, `src/report/__tests__/created-report.test.ts`
- Modify: `src/report/BugseeReport.ts` (export `normalizeSnapshot` and `toReportError`; no behaviour change), `src/report/errors.ts` (add `CreateBusy`), `src/report/types.ts`, `src/report/__tests__/validate.test.ts` (four codes), `src/NativeBugsee.ts`, `src/index.ts`, `src/__mocks__/native.ts`
- Modify (stubs only): `android/BugseeModule.java`, `ios/BugseeModule.mm`

**TurboModule additions (exact):**

```ts
createReport(): Promise<string | null>;                             // 'cr-<n>' or null; rejects E_REPORT_CREATE_BUSY
createdReportRead(handleId: string): Promise<UnsafeObject>;         // the BugseeReportSnapshot wire shape
createdReportUpdate(handleId: string, patchJson: string): Promise<void>;
createdReportAddDataAttachment(handleId: string, base64: string, name: string, mimeType: string | null): Promise<void>;
createdReportAddFileAttachment(handleId: string, path: string, name: string, mimeType: string | null): Promise<void>;
createdReportUpload(handleId: string): Promise<boolean>;            // the handle is dead afterwards, whatever the result
```

**Public JS API (exact):**

```ts
// src/report/types.ts
export interface BugseeCreatedReport {
  read(): Promise<BugseeReportSnapshot>;
  update(patch: ReportPatch): Promise<void>;
  addFileAttachment(path: string, options: { name: string; mimeType?: string }): Promise<void>;  // copied now; no move
  addDataAttachment(base64: string, options: { name: string; mimeType?: string }): Promise<void>;
  /** Uploads; resolves the SDK's result. Every later call rejects E_REPORT_HANDLE_DEAD. */
  upload(): Promise<boolean>;
}
// src/report/errors.ts: ReportErrorCode.CreateBusy = 'E_REPORT_CREATE_BUSY'
// src/index.ts, on class Bugsee
/** A report to fill and upload. null when the SDK made none (not launched). One at a time: E_REPORT_CREATE_BUSY. */
createReport(): Promise<BugseeCreatedReport | null>;
```

- `CreatedReport` validates exactly as `BugseeReportProxy` does, with the same validators, `normalizeFilePath` and base64 check. Rejections go through `toReportError`.
- `upload()` marks the object dead **synchronously**, before it crosses, so a second `upload()` rejects locally.
- The JSDoc on `createReport` states P6, P7 (the limits per platform) and P5, with the reason.
- `setReportHandler`'s JSDoc gains an "Attachments" paragraph: a handler report takes up to 1000 attachments on both platforms; a file is captured when it is added; `move` is honoured; and `onAfterReportCreated` must check `getAttachmentNames()` before adding.
- Export `BugseeCreatedReport` from `src/index.ts`.

**Stubs:** `createReport` resolves `null`, and the five `createdReport*` methods reject `E_REPORT_HANDLE_DEAD`, which is truthful since no stub mints a handle. Each is commented `Task 8.2b` or `Task 8.2c`.

- [x] **Red** — `created-report.test.ts` (native mock):
  - `createReport resolves null when native made none`;
  - `createReport wraps a handle`;
  - `E_REPORT_CREATE_BUSY surfaces as BugseeReportError with its code`;
  - `update sends the validated patch as JSON`;
  - `update with one bad field sends nothing`;
  - `addFileAttachment strips file:// and sends no move`;
  - `addDataAttachment rejects non-base64 before crossing`;
  - `upload resolves native's result`;
  - `after upload every op rejects E_REPORT_HANDLE_DEAD without crossing`;
  - `two concurrent upload calls cross once`;
  - `read normalises the snapshot as the handler proxy does`.

  `validate.test.ts`: `ReportErrorCode values are exactly the four stable strings`. Run → FAIL.
- [x] **Green** — the module, the mock (the six `jest.fn`s; `createReport` resolves `null` by default) and the stubs. Every gate is green.
- [x] **Mutate**
  - (1) Mark dead after the native upload resolves. `two concurrent upload calls cross once` must fail.
  - (2) Pass `move: true` for files. `addFileAttachment … sends no move` must fail.
  - Revert and record.
- [x] **Commit** — `feat(report): createReport, a report the app fills and uploads, bridge stubbed` (`cd79431`). Reviewed: no findings. Stubs only. No device e2e.

---

### Task 8.2b — `createReport`: Android bridge

**Depends on:** 8.2a. It runs in parallel with 8.2c.

**Files:** create `android/CreatedReports.java` and `androidTest/CreatedReportsTest.java`; modify `android/BugseeModule.java` (replace the stubs, and clear the registry in `invalidate()`).

**Interface (plain Java):**

```java
final class CreatedReports {
    static CreatedReports shared();
    CreatedReports();                                   // package-private, for tests
    /** false while a created report is outstanding or being created. */
    synchronized boolean reserve();
    /** Ends a reservation: a report gets "cr-<n>" (fresh per process) and holds the slot; null frees the slot. */
    synchronized @Nullable String fulfil(@Nullable Report report);
    synchronized @Nullable Report get(String handleId);
    /** Removes the report and frees the slot. */
    synchronized @Nullable Report take(String handleId);
    synchronized void clear();
}
```

**Module:**
- `createReport(promise)`:
  - `!reserve()` → reject `E_REPORT_CREATE_BUSY` (log `created report - busy`);
  - otherwise `Bugsee.createReport(r -> promise.resolve(registry.fulfil(r)))`, logging `created` or `none`;
  - a throw → `fulfil(null)`, and reject.
- The read, update and attachment methods mirror `reportRead`/`reportUpdate`/`reportAdd*Attachment` over `registry.get(h)`, through `ReportOps`. `addFile` passes `move = false`.
- `createdReportUpload(h, promise)`:
  - `take(h)`; `null` → `E_REPORT_HANDLE_DEAD`;
  - otherwise `Bugsee.upload(report, ok -> promise.resolve(ok))`, logging `uploaded ok=`.

- [x] **Red** — `CreatedReportsTest`:
  - `oneOutstandingAtATime`;
  - `aNullReportFreesTheSlot`;
  - `takeFreesTheSlot`;
  - `handlesAreFreshAndPrefixed` (`cr-1`, `cr-2`, never reused after a take);
  - `aTakenHandleIsGone`;
  - `clearFreesEverything`;
  - `concurrentReservationsAdmitOne` (eight threads through a start barrier).
  - Run → FAIL.
- [x] **Green** — as specified. The example builds.
- [x] **Mutate** — make `reserve()` return `true` always. `oneOutstandingAtATime` must fail. Revert and record.
- [x] **Commit** — `feat(android): createReport through a one-slot registry` (`6179794`), then `fix(android): ignore a created-report callback after its reservation ended` (`0542501`). A late listener carries the reservation stamp and cannot fill the next runtime's slot. `invalidate` still clears the registry. Not a device pass.

---

### Task 8.2c — `createReport`: iOS bridge

**Depends on:** 8.2a. It runs in parallel with 8.2b.

**Files:**
- Create: `support/BGSRNCreatedReports.{h,m}`, `support/BGSRNCreatedReportOps.{h,m}` (under `include/` for headers)
- Create tests: `supportTests/BGSRNCreatedReportsTests.m`, `supportTests/BGSRNCreatedReportOpsTests.m`
- Modify: `support/BGSRNReportOps.{h,m}` (extract `+validatedPatch:error:`, the validation half of `applyPatch:…`, which now calls it; behaviour unchanged, and the existing tests stay green), `ios/BugseeModule.mm` (replace the stubs; `invalidate` clears the registry; both import branches)

**Interfaces:**

```objc
@interface BGSRNCreatedReports : NSObject                      // os_unfair_lock; the API of Android's CreatedReports
@property (class, readonly) BGSRNCreatedReports *shared;
- (BOOL)reserve;
- (nullable NSString *)fulfil:(nullable BugseeExtendedReport *)report;
- (nullable BugseeExtendedReport *)reportFor:(NSString *)handleId;
- (nullable BugseeExtendedReport *)take:(NSString *)handleId;
- (void)clear;
@end
FOUNDATION_EXPORT const NSUInteger BGSRNCreatedReportAttachmentMaxCount;   // 3
FOUNDATION_EXPORT const NSUInteger BGSRNCreatedReportAttachmentMaxBytes;   // 3145728
@interface BGSRNCreatedReportOps : NSObject
+ (NSDictionary<NSString *, id> *)readReport:(BugseeExtendedReport *)report;
  // BGSRNReportOps' keys; severity as held; screenshotDisplayIds @[@0] iff a screenshot; attachmentNames from attachments[].name
+ (BOOL)applyPatchJSON:(NSString *)json toReport:(BugseeExtendedReport *)report error:(NSError **)error;
  // validatedPatch first (all-or-nothing); summary/description via setSummary:/setDescription: (NSNull -> nil);
  // severity via setSeverity:; labels assigned (replace); clearAttributes -> clearAllAttributes first;
  // attributes: NSNull -> clearAttribute:, else setAttribute:withValue:
+ (BOOL)addData:(NSString *)base64 name:(NSString *)name toReport:(BugseeExtendedReport *)report error:(NSError **)error;
+ (BOOL)addFileAtPath:(NSString *)path name:(NSString *)name toReport:(BugseeExtendedReport *)report error:(NSError **)error;
  // Size from the file's attributes before reading; read now. BadArgument for bad base64. AttachmentRejected when the
  // report already holds 3, the data is empty or over 3 MiB, or the file is missing or unreadable.
  // Attachment = [BugseeAttachment attachmentWithName:name filename:name data:data].
@end
```

**Module:**
- **Every created-report op runs inside `BGSRNRunOnMain`,** unlike the handler's report ops. `BugseeExtendedReport` is unsynchronised, and the SDK hands it out and takes it back on main.
- `createReport`: `reserve` else reject busy. Then `[Bugsee createReportWithCompletion:^(r){ resolve([registry fulfil:r]); }]`. The completion is called on every path (`nil` when not launched).
- `createdReportUpload`: `take`, else dead. Then `[Bugsee uploadReport:r completion:^{ resolve(@YES); }]`.

- [x] **Red**
  - `BGSRNCreatedReportsTests`: mirror 8.2b's seven, by name, with a `test` prefix.
  - `BGSRNCreatedReportOpsTests` (a real `BugseeExtendedReport`):
    - `testReadsTheFields`;
    - `testPatchIsAllOrNothing`;
    - `testLabelsReplace`;
    - `testNSNullClearsTheSummaryAndRemovesAnAttribute`;
    - `testClearAttributesRunsFirst`;
    - `testAFourthAttachmentIsRejected`;
    - `testAnAttachmentOver3MiBIsRejected`;
    - `testAnEmptyAttachmentIsRejected`;
    - `testAMissingFileIsRejected`;
    - `testAFileIsCapturedWhenAdded` (overwrite the file afterwards; the attachment keeps the original bytes);
    - `testInvalidBase64IsABadArgument`;
    - `testTheLimitsMirrorTheSdk` (3 and 3145728, with the SDK constants named in the message);
    - `testTheSdkSharesAttributesAcrossExtendedReports`. This pins the SDK bug behind P5: create A, set an attribute, create B, and A's attribute is gone. When this test fails, the SDK is fixed and P5 can be lifted; the test's message says so.
  - `BGSRNReportOpsTests` stay green unchanged.
  - Run → FAIL.
- [x] **Green** — as specified. The iOS example builds on both delivery paths.
- [x] **Mutate**
  - (1) Drop the count check. `testAFourthAttachmentIsRejected` must fail.
  - (2) Read the file lazily, keeping the path. `testAFileIsCapturedWhenAdded` must fail.
  - Revert and record.
- [x] **Commit** — `feat(ios): createReport, with the SDK's attachment limits enforced up front` (`38bfadc`), then `fix(ios): ignore a created-report callback after its reservation ended` (`a05df5a`). A late listener carries a generation token. Simulator XCTests only, not an iPhone pass.

---

### Task 8.3a — Device verification, Android: every reporting path, proven from retained bundles

**Depends on:** 8.1, 8.2b and Task 7.6a (`writeTempFile`, `fileExists`).

**Files:**
- Create: `scenarios/reporting.ts` (scenarios `rp-upload`, `rp-prelaunch`, `rp-dialog`, `rp-create` and `rp-attach`), `e2e/reporting.test.ts`, `e2e/report-dialog.ts` (the `uiautomator` helpers and `ANDROID_REPORT_SEND_RESOURCE_ID`)
- Modify: `App.tsx`, `e2e/bundles.ts` (add `attachmentsOf(bundle): Array<{ name: string; mimeType?: string; path: string }>`, joining the manifest's `attachment` entries to their stored files), `scripts/__tests__/e2e-capture-files.test.ts` (`attachmentsOf joins names to files`; `attachmentsOf is empty without attachments`)

**Retention and preconditions:** as 3.4d: the banner, the asserted clear, airplane mode, and `Launched`.

**Step 0 — pin the dialog's send control, once, before writing case 6.**
- Run `rp-dialog`. After `BeforeReportShown`, run `adb shell uiautomator dump /sdcard/rp.xml`, pull it, and find the control that submits.
- Pin its `resource-id` as `ANDROID_REPORT_SEND_RESOURCE_ID`, and put the dump's excerpt in the commit body.
- If it has no stable `resource-id`, stop and report. Do not fall back to coordinates or text.

**Scenarios.** Every value carries the run's nonce `<n>`.

`rp-upload` runs, in order, after `Launched`:

| call | expected `severity` | expected `labels` |
|---|---|---|
| `upload('up2-<n>', 'd2-<n>')` | `S` | no label contains `<n>` |
| `upload('up3-<n>', 'd3-<n>', IssueSeverity.Critical)` | `4` | no label contains `<n>` |
| `upload('up4-<n>', 'd4-<n>', IssueSeverity.Blocker, ['e2e', 'l4-<n>'])` | `5` | `⊇ ['e2e', 'l4-<n>']` |
| `upload('up5-<n>', 'd5-<n>', undefined, ['l5-<n>'])` | `S` | `⊇ ['l5-<n>']` |

`S` is up2's severity. It must be an integer 1–5, and is recorded. Then the scenario calls `(Bugsee.upload as any)('x5-<n>', '', 3, [], false)` inside `try`, and logs `BUGSEE_E2E rp upload-5th code=<error name>`.

`rp-prelaunch`: before `launch()`, `upload('pre-<n>', '')` and `showReportDialog('pre-<n>')`, then the marker `BUGSEE_E2E rp prelaunch-sent`. A lifecycle subscription logs `BUGSEE_E2E rp lifecycle <name>`.

`rp-dialog`:
- A handler is registered before `launch()`. Its `onBeforeReportCreated` reads the report and logs `BUGSEE_E2E rp dialog-before summary=<json> description=<json> severity=<n> labels=<json>`.
- A lifecycle subscription logs `BeforeReportShown`.
- After `Launched`: `showReportDialog('dlg-<n>', 'dd-<n>', IssueSeverity.High, ['dlg-<n>'])`.

`rp-create`:
- A handler is registered before `launch()`. `onBefore` runs `setAttribute('phase_before', 'h-<n>')` and logs `rp create before`; `onAfter` logs `rp create after`.
- After `Launched`:
  1. `r = await createReport()`, then log `rp created null=<r === null>`.
  2. `await r.update({ summary: 'cr-<n>', description: 'crd-<n>', severity: IssueSeverity.VeryLow, labels: ['c-<n>'], attributes: { created: 'c-<n>' } })`.
  3. `await r.addDataAttachment(b64('data <n>'), { name: 'crdata-<n>.txt', mimeType: 'text/plain' })`.
  4. `p = await writeTempFile('crfile-<n>.txt', 'file <n>')`, then `await r.addFileAttachment(p, { name: 'crfile-<n>.txt' })`.
  5. `extra1` and `extra2` data attachments, each logging its outcome as `rp extra<k> ok|code=<c>`.
  6. A second `createReport()`, logging its code.
  7. Log `rp uploading`, then `ok = await r.upload()`, and log it.
  8. `await r.read()`, logging its code.

`rp-attach`:
- A handler's `onBefore` writes `copy-<n>.txt` (`'copy <n>'`) and `move-<n>.txt` (`'move <n>'`).
- It adds the first with `{ name: 'copy-<n>.txt', mimeType: 'text/plain' }` and the second with `{ name: 'move-<n>.txt', mimeType: 'text/plain', move: true }`.
- It logs `rp exists copy=<b> move=<b>`.
- The app calls `upload('att-<n>', '')`.

**Cases (`e2e/reporting.test.ts`):**
1. `each upload form files one report with its fields` — exactly four bundles whose `summary` starts `up`, with the table's `description`, `severity` and `labels`.
2. `a fifth argument is refused` — `upload-5th code=TypeError`, and no bundle's summary is `x5-<n>`.
3. `upload files as code_upload` — every `up*` bundle has `request.source.type === 'code_upload'`.
4. `nothing is filed or shown before launch` — `prelaunch-sent` precedes `Launched`; no bundle's summary is `pre-<n>`; no `BeforeReportShown` appears in that run.
5. `the dialog opens pre-filled` — `dialog-before summary="dlg-<n>" description="dd-<n>" severity=3 labels=["dlg-<n>"]`, then `BeforeReportShown`, in that order.
6. `submitting the dialog files the report` — tap `ANDROID_REPORT_SEND_RESOURCE_ID` (found by resource-id in a fresh dump, tapped at its bounds' centre). Then exactly one bundle with `summary === 'dlg-<n>'`, `description === 'dd-<n>'`, `severity === 3`, `labels ⊇ ['dlg-<n>']` and `source.type === 'code_dialog'`.
7. `a created report's edits reach its bundle`:
   - exactly one bundle with `summary === 'cr-<n>'`, `description === 'crd-<n>'`, `severity === 1` and `labels ⊇ ['c-<n>']`;
   - `manifest.attrs.created === 'c-<n>'` and `manifest.attrs.phase_before === 'h-<n>'`;
   - `attachmentsOf` has `crdata-<n>.txt` with content `data <n>`, and `crfile-<n>.txt` with content `file <n>`.
8. `the handler runs at create, then at upload` (Android) — `rp create before` precedes `rp created null=false`, and `rp create after` follows `rp uploading`.
9. `one created report at a time, and none after upload` — the second `createReport` logs `E_REPORT_CREATE_BUSY`; `upload` logs `true`; the later `read` logs `E_REPORT_HANDLE_DEAD`.
10. `created-report attachment limits` — **Android:** `extra1 ok` and `extra2 ok`, and case 7's bundle has 4 attachments.
11. `a handler attaches a file by copy and by move` — `exists copy=true move=false`. Exactly one bundle with summary `att-<n>`, whose `attachmentsOf` has both names with contents `copy <n>` and `move <n>`, and `mimeType === 'text/plain'` on both.

- [ ] **Step 0** — as above. Record the result. *2026-10-01, WOD_LX1 `AMRJCP4718402860`, nonce `cae20c890381`: the dialog was on screen (`BeforeReportShown`, fields pre-filled). The submit control is a clickable `TextView`, text `Отправить` (`bugsee_send`), `resource-id=""`, bounds `[464,51][656,163]`. The only ids in the dump are `android:id/content` and `android:id/statusBarBackground`. Android SDK 7.3.0 builds that button with `ResourceIdentifiers.POSITIVE_BUTTON = View.generateViewId()`, so uiautomator has no stable resource name to pin. Stopped. Nothing was tapped. Cases 1–11 were not run. No commit. On 2026-10-02, cases 1–5 and 7–11 were run on WOD_LX1 `AMRJCP4718402860` and passed; case 6 was not run.*
- [x] **Red** — write the tests and scenarios. Run once before wiring `App.tsx` → FAIL at the first marker.
- [ ] **Green** — cases 1–11 pass on the WOD_LX1.
- [x] **Mutate**
  - (1) Map the Android severity by ordinal. Case 1 must fail on `up3`.
  - (2) Pass `move = false` from `ReportOps.addFile`'s caller. Case 11 must fail on `move=true`.
  - (3) Make `CreatedReports.reserve()` always `true`. Case 9 must fail.
  - Revert and record.
- [x] **Commit** — `test(e2e): upload, the dialog, createReport and attachments in Android bundles`. The body records the banner, `S`, the Step 0 excerpt, and one `request.json` verbatim.

---

### Task 8.3b — Device verification, iOS: the simulator and the iPhone

**Depends on:** 8.2c and 8.3a (the same files).

The cases of 8.3a apply, run under `E2E_PLATFORM=ios` on the simulator, and on the iPhone with `E2E_IOS_TARGET=device`. These iOS values are stated per case:
- **Case 3:** `it.failing` on iOS (P10). The plain `it` before it is case 1, which checks identity.
- **Case 6:** a gated case, `E2E_IOS_OPERATOR=1`, on the iPhone only.
  - The test prints `>>> Tap Send in the Bugsee report dialog on the iPhone now (60 s)` and waits up to 60 s for the bundle.
  - Its assertions are Android's, with `source.type === 'code_dialog'`.
  - Without the variable it is skipped, and the simulator never runs it.
- **Case 8:** `rp create before` and `rp create after` **both** follow `rp uploading` (P6), and `rp created null=false` precedes `rp uploading`.
- **Case 10:** `extra1 ok` and `extra2 code=E_REPORT_ATTACHMENT_REJECTED`, and case 7's bundle has exactly 3 attachments (P7).
- **Case 11:** as Android. iOS's `addAttachmentWithFilePath:…move:` honours `move`.
- **Every case:** retention is by `DEAD_ENDPOINT`, and `environment.sdk.version` is the pin.

- [x] **Red/Green** — every case except case 6 passes on the iOS 26.5 simulator, with case 3 failing for the right reason (record `source.type`). *2026-10-02, simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957`: 10 passed, 1 skipped. Case 3 logged `source.type` `unknown` on all four `up*` bundles (nonce `8c3771a12c38`) while still expecting `code_upload`. Banner `Bugsee IOS SDK ver:7.0.0-beta3 build:0d9c9d0a-9`. `environment.sdk.version` is `7.0.0-beta3`. `config.duration` is 90. The same suite on KRSFT (`345BA7FE-2C29-5722-892A-BFCB1FD34D0C`, iPhone11,2, iOS 18.7.9): 10 passed, 1 skipped, same `unknown` (nonce `9a41125b8a8e`).*
- [x] **Mutate** — drop the count check in `BGSRNCreatedReportOps`. Case 10 must fail on the simulator. Revert and record. *The mutant logged `rp extra2 ok` and failed `never saw rp extra2 code=E_REPORT_ATTACHMENT_REJECTED` on that simulator. `AtAttachmentLimit` is restored.*
- [x] **Commit** — `test(e2e): upload, the dialog, createReport and attachments in iOS bundles`.

**Hardware pass: add to Task 3.H** — Task 8.3b whole on the iPhone, including the gated operator case 6.

---

### Phase 8 review gate

The reviewer must independently:
- run every unit, JVM, XCTest and mutation suite, and `check-rn-compat.sh 0.81`;
- confirm by reading the code that:
  - no `upload` path, JS or native, accepts or forwards an `includeVideo`;
  - a severity crosses by value on both platforms, and `0` never reaches an SDK setter as a severity;
  - every `createdReport*` promise settles exactly once, and the registry frees its slot on upload, on a `null` report and on `invalidate`;
  - no iOS created-report op runs off main;
  - neither platform silently drops an attachment JS was told succeeded (iOS limits enforced up front; Android's `null` → `E_REPORT_ATTACHMENT_REJECTED`);
- **rerun** 8.3a and 8.3b on the simulator.

Record, for the controller:
- P5's SDK bug;
- P10;
- that iOS dialog submission is proven only by the operator case.

---

## Phase 9 — Capture & filters

The phase with the most native↔JS round-tripping, hence the most device testing.

- [x] **9.1** Console capture with the JS patch. A `console.log` was retained as source 98 (`LogSource.Custom`) at level 3 on the WOD_LX1, the iOS simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957`, and iPhone XS KRSFT.
- [x] **9.2** Log filter — the native→JS round trip. **A filter callback that cannot complete must drop the line, not pass it through**; failing open at a redaction boundary leaks exactly what the callback existed to remove. Device: WOD_LX1 `AMRJCP4718402860` retained `log-filter rewrite 1ac247198f48 REDACTED` (source 98, level 2) and omitted the unsettled hang line, and simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957` did the same for nonce `fcdfade08169`; the iPhone XS (KRSFT) was already running BareExample after a 10-minute wait, so that run was not taken.
- [x] **9.3** Network: keep the WebSocket patch; `patchXhr` stays disabled. **Do not assume native capture covers `fetch`/XHR on Android** (found 2026-09-29, from the Android SDK source):
  - RN's `NetworkingModule` runs on OkHttp, and Bugsee instruments OkHttp only when `bugsee-android-okhttp` is on the classpath.
  - This package declares `bugsee-android-okhttp` at the same version as `bugsee-android`.
  - The Bugsee Gradle plugin adds the okhttp artefact only when the app *directly* declares `com.squareup.okhttp3` (`BugseePlugin.hasOkHttpDependency`). When the artefact is present, it injects into every `OkHttpClient.Builder.build()`, including inside `react-android`.
  - A typical RN app gets OkHttp only transitively, so JS requests are likely **not** captured today.

  The WOD_LX1 retained bundle contains the JS `fetch`. iOS NSURLSession capture does not record a React Native `fetch`.
- [x] **9.4** Network filter, same round-trip shape. On the iPhone XS (KRSFT, `345BA7FE-2C29-5722-892A-BFCB1FD34D0C`) and simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957` the retained bundle held one websocket url rewritten with `bugsee-e2e-redacted` and omitted the hung `/v2/sessions` error; WOD_LX1 `AMRJCP4718402860` retained no network events, because this branch does not add `bugsee-android-okhttp`.
- [x] **9.5** `addBreadcrumb(crumb)` and `setBreadcrumbFilter(cb)`. Breadcrumbs are built through the SDK's exchange factory on both platforms, so the bridge constructs rather than forwards. Device: WOD_LX1 `AMRJCP4718402860` retained `breadcrumb-filter immediate 30dccd7246d8 REDACTED` and `breadcrumb-filter rewrite 30dccd7246d8 REDACTED` at level `info`, and the unsettled crumb was absent; simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957` retained `breadcrumb-filter immediate e62610c1b82b REDACTED` and `breadcrumb-filter rewrite e62610c1b82b REDACTED` at level `info`, and the unsettled crumb was absent. The iPhone XS (KRSFT) was already running BareExample (pid 43281), so that run was not taken.
- [x] **9.6** `addNetworkEvent` for stacks the SDK does not auto-instrument. WOD_LX1 `AMRJCP4718402860` retained `https://bugsee-e2e.invalid/add/89dc3cdd4491` (`mechanism` `react-native`, `type` `complete`) and omitted the hung url (the filter logged `hung nonce=89dc3cdd4491`). iOS builds a `BugseeNetworkEvent` (`eventWithID:`) because beta3's factory `createNetworkEvent` returns nil, then `addNetworkEvent:requiresFiltering:YES`. Simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957` retained `https://bugsee-e2e.invalid/add/0b8a3f41b546` and omitted the hung url (filter logged `hung nonce=0b8a3f41b546`). iPhone XS KRSFT `345BA7FE-2C29-5722-892A-BFCB1FD34D0C` retained `https://bugsee-e2e.invalid/add/5013161d5890` and omitted the hung url (`hung nonce=5013161d5890`). Both events are `mechanism` `react-native`, `type` `complete`. `duration` stayed 90.
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

- [x] **12** Package, JS API, Android `Bugsee.ext(Feedback.class)` (`showFeedbackActivity` / `setDefaultFeedbackGreeting` / `setOnNewFeedbackListener`, `FeedbackAppearance` colors) and iOS `BugseeFeedback.shared` from `bugsee/feedback-spm` exact `7.0.0-beta3`. Device: WOD_LX1 `AMRJCP4718402860` logged `BUGSEE_E2E feedback shown nonce=b8d28d3b1280` (pass). iOS Simulator `6FA9B3E8-26C7-4232-AA2C-537D9DF32957` logged `BUGSEE_E2E feedback shown nonce=2fd9bfc8a26a` (pass). iPhone XS (KRSFT) was already running BareExample, so that run was not taken.

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
- **`bugsee/bugsee-android#178`** — screenshot display ids were not returned in ascending order. **Shipped in Android 7.3.0** (`15abdb28b`). The bridge still sorts (`getScreenshotDisplayIds`, Task 3.4a): it is harmless, and it keeps the JS contract independent of the SDK version.
- **`bugsee/bugsee-android#186`** — `setUserIdentifier`/`setAttribute` values were written verbatim to the SDK-internal log. **Shipped in Android 7.3.0** (`afdded7be`); the iOS half ships with the next beta. Phase 5's device tests still use synthetic values and assert nothing about `log.internal`.
- **To raise (controller; implementers never file these):**
  - `bugsee/specs` `sdk/wrapper-data-requests` says `vh` bounds are "physical screen pixels" but also "the native tree's coordinate space", which is points on iOS; Phase 6 follows the latter (workbook 6.6).
  - That spec's open item 2 (the viewer does not parse `managed`) means the RN view tree will not render in the dashboard until the viewer changes.
  - Android's `startBlackout` is a no-op before launch, while iOS honours it (fails closed); Phase 6 case `blackout` 5 pins both behaviours.
  - **Android 7.3.0 `logUnhandledException` files a crash report *and* an error report** for one incident: `logExceptionInternal` falls through from the crash branch. The fix is `e1d56ed65`, on branch `fix/unhandled-error-single-report`, which is neither merged nor released. Phase 7 pins it as `it.failing` (Task 7.5a case 10, gated R3).
  - **Android 7.3.0 `logException(Throwable, Map)` reads only `domain` and `skipFrames`.** Its javadoc documents `labels` and `includeVideo`, which nothing reads. Task 7.5a case 7 is `it.failing` on Android.
  - **`includeVideo` is a dead exception option on both SDKs in 7.x.** Android ignores it. iOS records it in `crash.json` `exceptionLoggingOptions` and acts on nothing, and `[BugseeExceptionLoggingOptions new]` defaults it to `NO`. Implement it, or say so in the javadoc and the header.
  - **Android has no counterpart to iOS's overriding crash report** (`createAndStoreOverridingCrashReportWithException:`). A fatal JS error files the wrapper's `ReactNativeWebException` crash **and** RN's own `JavascriptException` crash (Phase 7 R13; pinned by Task 7.5a's gated R2). Raise it once R2 confirms it on the device.
  - **iOS beta3 compiles `logException:…` and `logUnhandledException:…` out on the simulator** (`#if !TARGET_OS_SIMULATOR`), including the call to `completion`. The no-op may be deliberate; never calling `completion` is not. Task 7.1d settles its promise on a deadline because of it.
  - **iOS beta3 `BugseeExtendedReport` keeps its attributes (and `screenshotInitialized`) in file-scope globals.** Each `createReport` resets the attributes of every earlier created report. Phase 8 P5 allows one created report at a time; `testTheSdkSharesAttributesAcrossExtendedReports` (Task 8.2c) fails when this is fixed.
  - **iOS beta3 `uploadWithSummary:…` files `source.type = "unknown"`** (`BGSReportingTriggerTypeUnknown`), where Android files `code_upload`. Task 8.3b case 3 is `it.failing` on iOS.
  - **`cleanSource`'s CodePush paths keep the update's hash**: `files/CodePush/<hash>/CodePush/index.android.bundle` and `Library/Application Support/CodePush/<hash>/…` (steps 3-4 strip only the app-bundle/data-container prefix, not the `CodePush/<hash>/` segment itself). 6.x's `^.*\/[^.]+(\.app|CodePush|.*(?=\/))` reduced these to `/index.android.bundle`/`/main.jsbundle`, so a CodePush update did not change `source`/`trace`/the signature. Left as-is in the 7.1a review's fix round: stripping through the last `CodePush/` changes signature stability across CodePush updates, which is a bigger call than a fix round should make silently. Decide, then update `cleanSource` and its tests if so (review M4).

## Out of scope

tvOS, visionOS and Mac Catalyst. The xcframework ships those slices, but the manifest declares `.iOS` only and no example app covers them.
