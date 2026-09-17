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
- Android SDK **7.2.0**, Gradle plugin **4.0.6**, pinned exactly. The plugin marker resolves from **Maven Central**, not the Gradle Plugin Portal.
- iOS SDK **7.0.0-beta1** from `https://github.com/bugsee/spm`, requirement `exact`. SwiftPM will not admit a prerelease into a range.
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

- [ ] Lint, typecheck, unit, Stryker with a failing threshold.
- [ ] Android: assemble the example app.
- [ ] iOS: build the example, **then assert the framework is embedded**. The assertion is the point.
- [ ] Matrix across RN 0.81.x, 0.83.x, 0.86.x, 0.87.x. Only the 0.87 leg exercises SPM — SPM support for apps does not exist before 0.87, so 0.81-0.86 are CocoaPods-only.
- [ ] **Commit** — `ci: build both platforms and assert the iOS framework is embedded`

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
- [ ] **2.6** Device integration: launch with a non-default option on both devices and assert via `getLaunchOptions()` that it took effect.
- [ ] **2.7 (deferred dependency)** Manifest parity gate against `bugsee/specs` `sdk/options/`. **Blocked:** neither SDK publishes a manifest yet, and both need a complete descriptor enumerator first (plus a value-type tag on Apple). Ship a committed fixture and a test that reads it; swap to the published manifest when it exists.
- [ ] Review gate.

---

## Phase 3 — Wrapper contract

**Ships:** a `BugseeWrapper` implementation per platform — the seam for identity, context, lifecycle events, secure rectangles and report handling. Replaces four scattered mechanisms in the 6.x wrapper.

- [ ] **3.1** Identity and context: `getWrapperType() → "react_native"`, version, build, and a context map carrying RN version, JS engine and build configuration. Device test: a report's environment shows the wrapper block.
- [ ] **3.2** `onLifecycleEvent(name, data)` → a typed JS event, plus `onStatusChange(cb)` surfacing the SDK's own status transitions (iOS `bugseeDidChangeStatus:`, Android `BugseeStatus`). Normalise the two platforms' event sets: Android emits string constants; iOS keeps an enum and **never dispatches** `Paused`/`Resumed` or the feedback events. Expose only events that fire on at least one platform; document per-event availability. Device test on both.
- [ ] **3.3** `getSecureRectangles(display)` — the pull-based buffer `[version, count, l,t,r,b, …]`. Tests pin the encoding and that the version increments on every change. **Mutate:** hold the version constant across a change; the test must fail — a stale version is a privacy defect, since the SDK keeps redacting the old region.
- [ ] **3.4** `setReportHandler(handler)` — the wrapper's `ReportHandler` callbacks (`onBeforeReportCreated` / `onAfterReportCreated`) routed to JS, superseding the bespoke attachments channel. Both carry an `isTerminating` flag; when set, the process is about to exit, so the JS round trip must not be awaited.
- [ ] Review gate.

---

## Phases 4–6 — the mechanical middle

Each is small by design: they establish the bridging pattern that the harder phases reuse.

**Phase 4 — Logging, events, traces.** `log(text, level)`, `event(name, params)`, `trace(name, value)`. Tests: level mapping both directions; params survive the bridge. Device test asserting the lines appear in a report.

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
- [ ] Review gate.

---

## Phase 8 — Reporting

`showReportDialog`, `upload`, `createReport`, attachments via the wrapper's `ReportHandler`. Note `upload` has no `includeVideo` overload in 7.x — the 6.x parameter is gone and must not be reintroduced. Device test: trigger the dialog, submit, confirm the issue appears.

---

## Phase 9 — Capture & filters

The phase with the most native↔JS round-tripping, hence the most device testing.

- [ ] **9.1** Console capture with the JS patch.
- [ ] **9.2** Log filter — the native→JS round trip. **A filter callback that cannot complete must drop the line, not pass it through**; failing open at a redaction boundary leaks exactly what the callback existed to remove.
- [ ] **9.3** Network: native capture already covers `fetch`/XHR; keep the WebSocket patch; `patchXhr` stays disabled.
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

`@bugsee/react-native-feedback`: `showFeedbackUI`, `setGreeting`, `setListener`, feedback appearance. Android reaches it through `Bugsee.ext(Feedback.class)`; iOS through `BugseeFeedback.shared`, a separate SPM package (`bugsee/feedback-spm`, exact `7.0.0-beta1`) that itself pins the core exactly — so both move in lockstep. Needs no config plugin: autolinking picks up the Gradle dependency and its podspec carries its own vendoring.

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
- **`bugsee/bugsee-cocoa#91` / `bugsee-android#90`** — source-aware log API. Improves Phase 9 but does not block it: once the iOS RN hook is removed, the wrapper forwards through the public log API on both platforms and both record `source: 4`, matching Android today.

## Out of scope

tvOS, visionOS and Mac Catalyst. The xcframework ships those slices, but the manifest declares `.iOS` only and no example app covers them.
