# Bugsee React Native SDK 7.x — design

**Date:** 2026-09-15
**Status:** approved design, not yet implemented. This repository holds only this document and `LICENSE`.
**Supersedes:** the wrapper at `cross/react-native` (npm `react-native-bugsee` v2), which stays frozen on the 6.x line and is referenced throughout as the reference implementation.

---

## 1. Summary

A ground-up rewrite of the Bugsee React Native SDK against the 7.x native SDKs, published as two scoped npm packages from a new repository. The existing wrapper is a reference, not a base: 6.x → 7.x is a near-total public-API redesign on both platforms, and the wrapper's own public API, option model, build tooling and repo layout all change with it.

The single most important finding behind this design: **iOS 7.x and Android 7.x now accept the same `com.bugsee.option.*` option keys**, and both expose the same `BugseeWrapper` integration contract. The wrapper therefore needs no per-platform option translation and no bespoke per-feature bridge plumbing — two things the 6.x wrapper spent most of its code on.

## 2. Goals

- Ship a 7.x-native React Native SDK for the two current native lines: Android **7.2.0** (GA) and iOS **7.0.0-beta1** (SPM only).
- Expose the capabilities 7.x added and 6.x never had: breadcrumbs, notification relay, APM, user identity, hang/HTTP-error/frustration/anomaly detection, SDK status, report handlers.
- Make the wrapper's option surface **provably** consistent with the native SDKs, enforced in CI rather than by review.
- Work on bare React Native and on Expo, including Expo apps that regenerate native projects with `prebuild`.
- Keep the React Native crash reports the Bugsee backend already understands working unchanged.

## 3. Non-goals

- Backwards compatibility with `react-native-bugsee` v2. This is a clean break (§4.1).
- Supporting React Native below 0.83, or the legacy architecture.
- CocoaPods distribution of the native iOS SDK. Bugsee stopped publishing pods in September 2026; iOS is SPM-only permanently.
- Designing the unified cross-SDK exception format. That is a separate, larger piece of work (§14.3).
- Reusing `@bugsee/core` from the `javascript/` monorepo. That SDK's own design states React Native is out of scope and served by a separate SDK.

## 4. Decisions

### 4.1 Clean break, 7.x-native public API

New package names, new major. The public API mirrors the converged 7.x facade. Methods the native SDKs removed do not exist in the wrapper — no deprecated shims, no legacy option-key aliases. Existing apps rewrite their Bugsee call sites and get a compile error rather than a silent behaviour change where semantics shifted.

This matters most for `pause()`/`resume()`. Blackout is *not* an equivalent: 6.x `pause` suspended video and the loggers, whereas 7.x blackout suppresses only what describes the screen — logs, network events and traces keep being captured. A compatibility shim would have silently changed what a privacy-motivated `pause()` call actually does. iOS's own migration guide tells callers to use `stop:` plus a relaunch for a full stop.

### 4.2 Two packages, mirroring the native decomposition

`@bugsee/react-native` and `@bugsee/react-native-feedback`. Both native SDKs moved feedback out of core in 7.x — `bugsee-android-feedback` on Android, a separate `feedback-spm` package on iOS — and both expose an `ext()` extension registry as the seam for it. Mirroring that split keeps the RN dependency graph legible against the native one and means apps that never show the chat UI do not carry it, which on iOS is a SwiftUI dependency.

### 4.3 Expo config plugin

Android 7.x makes the `com.bugsee.android.gradle` plugin mandatory and it cannot be autolinked — the app must apply it. Expo apps regenerate `android/` and `ios/` on every prebuild, so manual edits do not survive. The package ships a config plugin. Bare RN apps perform the same changes manually, documented.

### 4.4 Debug-ID source maps via `bugsee-cli`

Build hooks run `bugsee-cli sourcemaps inject` then `debug-files upload --type sourcemaps`; the runtime reads `globalThis._bugseeDebugIds` and attaches `debug_ids` to the exception payload. Verified supported end to end: `worker/symbolfiles/sourcemap.py` keys on `debug_id` / `debugId` / `uuid`, and `worker/crash/managed/reactnative.py` (`_collect_debug_ids`, `_symbolicate`) tries debug IDs **before** the legacy `build_id`.

### 4.5 React Native floor: 0.83, New Architecture only

The legacy architecture was disabled in 0.82, removed from the codebase in 0.83, and the bridge deleted in 0.85. A 0.83 floor covers the three maintained lines (0.83.x, 0.86.x, 0.87.x) and means a single native source set per platform, a TurboModule spec with no legacy fallback, and no interop shims.

---

## 5. Repository and package layout

```
bugsee/bugsee-react-native  (main)
├── packages/
│   ├── react-native/                 → @bugsee/react-native
│   │   ├── src/                      public API, options, components
│   │   ├── android/                  Gradle library module (autolinked)
│   │   ├── ios/                      ObjC++ bridge
│   │   ├── plugin/                   Expo config plugin (src + build)
│   │   ├── scripts/                  source-map build hooks
│   │   ├── BugseeReactNative.podspec
│   │   └── package.json
│   └── react-native-feedback/        → @bugsee/react-native-feedback
│       ├── src/ android/ ios/
│       └── BugseeReactNativeFeedback.podspec
├── examples/
│   ├── bare/                         RN 0.87 bare app
│   └── expo/                         Expo app exercising the config plugin
├── native-versions.json              single source of pinned native versions
├── package.json                      yarn workspaces root
└── turbo.json
```

**Package manager: Yarn 4 with `nodeLinker: node-modules` and `nmHoistingLimits: workspaces`.** Every comparable RN native-SDK monorepo uses exactly this — `getsentry/sentry-react-native` (yarn 4.17.0), `invertase/react-native-firebase` (4.14.1), `callstack/react-native-builder-bob` (4.11.0), `software-mansion/react-native-reanimated` (4.13.0) — and all explicitly set `nodeLinker: node-modules` because Yarn 4 defaults to PnP, which React Native cannot use.

This deviates from `javascript/`, which uses pnpm. The deviation is deliberate: pnpm's isolated symlink layout puts real packages under `node_modules/.pnpm/<pkg>@<ver>/`, which RN autolinking then writes as version-stamped absolute paths into `settings.gradle` and the Podfile properties, and which breaks the `../node_modules/react-native/…` relative traversal podspecs conventionally use. Working around it means `node-linker=hoisted`, which forfeits pnpm's advantage. `javascript/` can use pnpm because it has no native build system to satisfy.

**Build tooling:** `react-native-builder-bob` with the `codegen` target; Turbo for task orchestration.

**Examples are committed; their build output is not.** The existing repo checks in `.gradle/` lock files and `.cxx/` CMake output under `src/app/`. The examples are the integration surface, not demos: the bare app proves autolinking plus `spm_dependency`, and the Expo app proves the config plugin survives `prebuild --clean`. They are written fresh, using the current sample app as a reference for screen coverage (home, attributes, secure views, identity, events/traces, console, feedback, exceptions, network) plus new screens for the 7.x capabilities (breadcrumbs, notify, APM, blackout, status/lifecycle, reports).

**No `src/lib/` nesting.** Today the library sits three levels down with the sample app as a sibling and shell scripts shuffling between them. Flattening to `packages/*` lets `npm publish` run from the package directory, which removes `scripts/build.sh` and `scripts/release.sh` entirely.

---

## 6. Native bridge

### 6.1 The wrapper contract is the integration surface

7.x has a first-class wrapper contract on both platforms, installed with `Bugsee.setWrapper()`:

- Android `com.bugsee.library.contracts.internal.BugseeWrapper` — its javadoc names React Native explicitly.
- iOS `@protocol BugseeWrapper <BGSBugseeWrapper>` in `BGSContracts.h`.

It supersedes the `$$WRAPPER` launch option, which **no longer exists** in `Options.java` at 7.2.0.

It is not merely an identity struct. It extends `ReportHandler` *and* `DataRequestProvider` and carries:

| Member | Use in the RN SDK |
|---|---|
| `getWrapperType()` / `wrapperType` | `"react_native"` |
| `getWrapperVersion()` / `getWrapperBuild()` | package version and build |
| `getContext()` / `context` | RN version, JS engine (Hermes/JSC), build configuration |
| `onLifecycleEvent(name, data)` | lifecycle delivery; fires **before** the app's own listener |
| `getSecureRectangles(display)` / `secureRectsForDisplay:` | pull-based secure rectangles |
| `ReportHandler` callbacks | attachments and report mutation; fire **before** the app's `setReportHandler` |

One object per platform replaces four scattered mechanisms in the 6.x wrapper, and removes two of the five `bgs*Event` bridge channels (attachments, lifecycle).

### 6.2 Secure rectangles become pull-based

Today `toggleProtected` resolves a React node handle after a `setTimeout(10)` and calls `addSecureView`. The delay exists because the view may not be mounted yet; the model is push-based, so a React re-layout leaves the redaction on stale coordinates.

7.x inverts this. The SDK calls `getSecureRectangles(display)` on the capture thread once per synchronize, and the wrapper answers from a preallocated flat buffer `[version, count, l, t, r, b, …]`. The version token lets the SDK skip an unchanged set; `SECURE_RECTANGLES_VERSION_UNKNOWN` (0) tells it to compare rectangles itself. The Android contract documents the failure mode precisely: reporting a stale version alongside changed rectangles is a privacy defect, because the SDK keeps redacting the old region.

The wrapper still prefers `addSecureView(nativeView)` where a protected component resolves cleanly to a real native view — the SDK then tracks it itself — and uses the pull path for components that do not.

### 6.3 TurboModule spec

Typed `EventEmitter<T>` members (available in codegen from RN 0.76, so safe at a 0.83 floor) replace the string-named `bgs*Event` channels and the `addListener`/`removeListeners` boilerplate. Filter round-trips keep their async request/reply shape — both native SDKs hand filters a completion callback, so the asynchrony is inherent — but become typed and keyed by request id rather than untyped `UnsafeObject` over a device emitter.

### 6.4 Android module

- Namespace `com.bugsee.reactnative`. The 6.x bridge squats `com.bugsee`, the SDK's own package.
- Single source set; no `newarch`/`oldarch` split.
- `api("com.bugsee:bugsee-android:7.2.0")`, pinned, replacing the unpinned `+`.
- The feedback package adds `bugsee-android-feedback` and reaches the feature through `Bugsee.ext(Feedback.class)`.
- The Gradle plugin's `DependencyDetector` was fixed to detect the SDK reached transitively through an intermediate module, which is exactly the RN autolinking shape (`:app` → `:react-native-bugsee` → SDK).

### 6.5 iOS module

- `s.platforms = { ios: "13.0" }`.
- **No `s.dependency 'Bugsee'`** — no pod exists. Instead:

```ruby
spm_dependency(s, url: 'https://github.com/bugsee/spm',
  requirement: { kind: 'exactVersion', version: '7.0.0-beta1' },
  products: ['Bugsee'])
```

- The helper lives in `react_native_pods.rb` and passes `requirement` verbatim into `Xcodeproj`'s `XCRemoteSwiftPackageReference`, so Xcode's own requirement kinds apply. `SPM.apply_on_post_install(installer)` is invoked from `react_native_post_install`, so it fires for bare RN and Expo prebuild alike.
- `exactVersion` is mandatory: SwiftPM will not admit a prerelease into a `from:` or `upToNextMajor` range.
- The helper warns about static linking with Swift packages. Bugsee's SPM slice is built from the `BugseeDynamic` target, so it is a **dynamic** xcframework and should avoid that class of error. **This needs empirical confirmation on a real app** (§15).
- The feedback package declares its own `spm_dependency` on `github.com/bugsee/feedback-spm` at the same exact tag; `feedback-spm` itself pins `bugsee/spm` exactly, so the two move in lockstep.
- Bridge is ObjC++ (`.mm`) implementing the generated `NativeBugseeSpec`; TurboModules require C++ interop.
- **Forward compatibility:** when React Native's own CocoaPods→SPM migration lands (CocoaPods trunk goes read-only 2026-12-02), the wrapper will need a `Package.swift` so it can be consumed by a pod-less app. The iOS bridge sources are laid out so that is a packaging change, not a rewrite.

---

## 7. Options model

Three classes, carrying the existing paradigm forward:

```
BugseeLaunchOptions (abstract)
  $options      Map<string, unknown>   keyed by com.bugsee.option.* directly
  $localOptions Map<string, unknown>   JS-only, never sent native
  $set / $get   (protected)
  setCustomOption(key, value)          (public)
  static serialize(opts)
  accessors for options shared by both platforms

AndroidLaunchOptions extends …   videoMode, logsUseAllSources, the detect.exit*
                                 family, triggerByNotification/Broadcast, ndk, …
IOSLaunchOptions     extends …   captureAVPlayer, machExceptions, bluetoothStatus,
                                 diskSpace, killDetection, maxDataSize, style, …
```

`createDefaultLaunchOptions()` selects by `Platform.OS`, unchanged.

**The map is keyed by the real 7.x keys**, not 6.x short names, so no translation layer exists at all. This is what makes `setCustomOption` genuinely useful: a custom key and a first-class accessor write into the same namespace, so an option the wrapper has not surfaced yet — including one added in a future 7.x patch — is reachable with no wrapper release.

**Enums cross the bridge as numbers.** iOS consumes them directly. The Android bridge holds a per-key number→enum-instance table, because of the coercion asymmetry in §14.2. A test asserts every enum-typed key in the Android manifest has a table entry.

> **Trap: the number must be the enum's internal value, never its ordinal.** The two diverge on four of the five option enums — `LogLevel.Error` has value 1 but ordinal 0; `VideoMode.Fullscreen` has value 20 but ordinal 3; `FrameRate` and `IssueSeverity` are likewise offset by one. Only `VideoQuality` coincides. Convert with each enum's own `fromIntValue` / `fromRawValue`, never `values()[n]`.
>
> There are **three** mutually incompatible int conventions live in the Android SDK today: the enums' internal values (what `_WRAPPER_OPTION_SPEC.md` tells wrappers to send), `VideoMode`'s legacy wrapper mapping `{0 None, 1 V1, 2 V2, 3→V2, 4→V2}`, and the ordinals `OptionsUtils.serializeToBundle` writes. The TS enum values in Appendix A are the **internal values**, which is also what iOS uses — so one number is correct on both platforms, provided the Android bridge converts by value and not by position.
>
> `bugsee/bugsee-android#87` additionally makes enum **names** work on the Map path. That gives a second viable encoding, but numbers stay the wire format here because iOS has no name-based path.

**Changes from the 6.x implementation:**

1. `serialize()` no longer injects `wrapper_info` (replaced by `setWrapper()`, §6.1) or `buildUUID` (replaced by debug IDs, §9.2). It emits the map.
2. `$localOptions` are no longer merged into the native payload; they are handed to the JS components separately.
3. Defaults are kept — the getter contract of returning an option's effective value before it is set is worth preserving — but are made un-driftable by the manifest check in §8. The current implementation has already drifted: `AndroidLaunchOptions` sets `videoMode = VideoMode.V3`, a value 7.x removed, and sets `minFrameRate`/`maxFrameRate`, which are iOS-only keys.

After launch, the table is refreshed from `getLaunchOptions()`, which returns the resolved set on both platforms, so hardcoded defaults only ever answer the pre-launch window.

---

## 8. Option manifest contract (cross-SDK)

Hand-maintained parity is what let the 6.x wrapper drift. The fix is for each native SDK to publish a machine-readable manifest of its option surface, and for every wrapper to check itself against it in CI.

Both SDKs already carry a runtime registry with exactly the needed data, in near-identical shape:

- Android: `OptionDescriptor.createAndRegister(key, type, defaultValue, hidden)` → `OptionsRegistry`
- iOS: `reg(key, cls, def)` → `[BGSOptionDescriptor descriptorWithKey:valueClass:defaultValue:]` → `BGSOptionsRegistry`

So the manifest is a **dump of the live registry**, authoritative by construction rather than a parse of source or prose.

Each SDK emits `options-manifest.json` as a release artifact at a public, version-addressed path:

```
https://download.bugsee.com/sdk/options/android/7.2.0.json
https://download.bugsee.com/sdk/options/ios/7.0.0-beta1.json
```

Per entry: `key`, `type`, `default`, `enumValues` (name→raw value), `hidden`, `since`, `deprecated`, and the build configuration the defaults were dumped from.

The RN check fetches the manifests for its two pinned native versions and asserts that every key it emits exists; that every key it calls cross-platform is present on both with the same type; that its enum values match; and that its defaults match. **CI-blocking.** A snapshot of the fetched manifests is committed, and CI diffs fetched against committed, so the check runs air-gapped and drift arrives as a reviewable PR diff rather than only a red build.

Two caveats the schema must handle, both observed in the sources:

1. **Build-config-dependent defaults.** `BGSOptionsDescriptors.m` wraps the body-size limit in `#if DEBUG`. The manifest records its configuration and publishes Release values.
2. **Intentional per-platform default divergence.** `BGSOptionsDescriptors.m` says verbatim: *"iOS defaults; some differ from Android intentionally."* The check is therefore strict on keys and types but tolerant on defaults, with intentional divergences declared in the manifest rather than inferred. Otherwise it cries wolf immediately.

The schema lives in `bugsee/report-bundle-structure` (`options/`), the repository where cross-SDK contracts are kept and which is becoming the general specs home rather than only the report-bundle one. Specified in `bugsee/report-bundle-structure#14`. Every wrapper consumes it, and it can also drive documentation generation, `wizard-cli`, and the AI skills.

---

## 9. Exceptions and source maps

### 9.1 Exception wire contract

Fixed by the backend and unchanged: the exception name stays literally `ReactNativeWebException`, with the payload as JSON in the message/reason. `worker/crash/managed/__init__.py:38` and `worker/crash/processors/__init__.py:33` both route on that string, and `worker/crash/managed/reactnative.py` parses it. Android 7.x removed `CrashInfo$ExceptionInfo/$FrameInfo` and has no structured foreign-frame API to replace it, so JSON-in-message remains the only path; renaming it would silently stop RN crashes being recognised.

What changes is the payload gaining a `debug_ids` member alongside name, message, frames, cause chain and signature.

| | Android 7.x | iOS 7.x |
|---|---|---|
| handled | `logException(Throwable, Map)` | `logException:reason:options:completion:` |
| unhandled | `logUnhandledException(Throwable, Map)` | `logUnhandledException:name:reason:completion:` |

`logUnhandledException` is new on Android and is a better fit than `onUncaughtException(Thread, Throwable)`, which exists to be called from a real `UncaughtExceptionHandler`.

The `ExceptionOptions` contract interface declares only `Domain` and `SkipFrames`, but the `logException` javadoc documents `"domain"`, `"labels"` and `"includeVideo"`. The parameter is `Map<String, Object>`, so the extra keys are accepted; the wrapper passes all three.

### 9.2 Source maps

`bugsee-cli sourcemaps inject` embeds a content-derived UUIDv5 debug ID into the bundle and its `.map`, plus the `globalThis._bugseeDebugIds` runtime stub; `debug-files upload --type sourcemaps` ships it. The worker's `_collect_debug_ids` accepts a crash-level list *or* a filename→id map plus per-frame ids, so the wrapper sends the whole map.

**Hermes ordering matters.** The Hermes build produces an intermediate source map and then a composed one. Injection must happen on the **composed** map, after `compose-source-maps.js`, or the debug ID lands on a map that is never consulted. The existing `hermes-sourcemaps.sh` already handles this ordering and should be read closely during implementation.

**Binary distribution.** `bugsee-cli`'s own README already specifies the answer — its Distribution table reads *"`@bugsee/cli` npm with per-OS `optionalDependencies` | RN, Cordova, Capacitor, web"* — it simply has not been built yet. That is also what the best-in-class vendors do:

| Vendor | Mechanism |
|---|---|
| Sentry | `@sentry/cli` with per-platform optional deps gated by `os`/`cpu`, plus a `postinstall` download fallback; `@sentry/react-native` depends on it pinned exactly |
| Bugsnag | `@bugsnag/cli` postinstall downloader with a committed placeholder binary |
| Firebase | no npm CLI; `upload-symbols` ships inside the pod, run from a build phase |

Optional-deps-plus-fallback is the current standard (esbuild, swc, Biome, turbo, Rollup). It needs no network in postinstall in the common case and survives `--ignore-scripts`, which pure-postinstall downloaders do not. `@bugsee/react-native` takes an exact pinned `@bugsee/cli` dependency; the packaging work lands in the `bugsee-cli` repo (§14.1).

---

## 10. JS capture components

The `componentState` pattern carries over, with `controlOptionName` values becoming 7.x keys (`com.bugsee.option.capture.logs`, `…capture.network`, `…detect.crash`).

- **console** — the wrapper owns both log paths and both level mappings; no React-Native-specific code remains in either native SDK. See §10.3.
- **network** — native capture already covers `fetch` and XHR because both traverse the native stack; `patchXhr` stays disabled as today. The WebSocket patch stays.
- **attachments** and **lifecycle** — no longer bespoke bridge events; both are responsibilities of the wrapper object (§6.1).
- **feedback** — moves wholesale into `@bugsee/react-native-feedback`.
- **breadcrumbs** — new, with `setBreadcrumbFilter` following the same filter shape as log and network.

### 10.1 Public API surface

Default export stays a singleton; types, enums and components are named exports.

Carried over: `launch` / `relaunch` / `stop`, `log`, `trace`, `event`, `showReportDialog`, `upload`, `logException`, attributes, secure rectangles, `captureViewHierarchy`, `deleteCollectedDataOnDevice`, `ErrorBoundary`, log and network filters.

New: `setUserIdentifier` / `getUserIdentifier` / `clearUserIdentifier`, `startBlackout` / `endBlackout` / `isBlackout`, `addBreadcrumb` + `setBreadcrumbFilter`, `notify`, `addNetworkEvent`, `logUnhandledException`, `getAllAttributes`, `createReport` + `setReportHandler`, `getStatus` + `onStatusChange`, `startTransaction` / `startSpan` / `getActiveSpan`.

Removed: `setEmail` / `getEmail` / `clearEmail`, `pause` / `resume`, `setKeyboardVisibility` (no replacement on either platform), `upload(…, includeVideo)`, `getDeviceId`.

Two ergonomic changes: `toggleProtected(ref, bool)` becomes a `<BugseeSecure>` component that disposes on unmount, and `initialize()` becomes `attach()` for the case where Android launched itself from manifest metadata and only the JS layer needs wiring.

### 10.2 Normalization

**Lifecycle events.** Android 7.x emits string constants; iOS kept an enum, and the sets differ. Android added `Launching`, `Stopping`, `BlackoutStarted`/`BlackoutEnded`, `Before`/`AfterReportAssembled` and three failure events. iOS still declares `Paused`/`Resumed` and `Before`/`AfterFeedbackShown` but never dispatches them. The wrapper exposes a single string union of events that genuinely fire on at least one platform, documents per-event availability, and never surfaces the dead iOS cases.

**Appearance.** Android is keyed (`setColor(ReportAppearance.ActionBarColor, int)`); iOS is property-based on `BugseeTheme`. One camelCase TS surface with two mapping tables, as `appearance/report.{android,ios}.ts` already does, regenerated against 7.x names. Feedback appearance moves to the feedback package, since `FeedbackAppearance` ships in the feedback artifact on Android.

---

### 10.3 Console capture and log filtering

The wrapper captures two distinct streams and they need different handling. Neither native SDK contains any React-Native-specific code to support this; both expose a generic, source-aware log API instead (`bugsee/bugsee-cocoa#91`, `bugsee/bugsee-android#90`), and the wrapper owns the `RCTLogLevel` mapping in the bridge it already ships on both platforms.

| stream | filtered where | `enforceFiltering` | why |
|---|---|---|---|
| JS `console.*` | in JS, by the console patch | `false` | The user's `setLogFilter` callback has already run; filtering again natively would run it twice on one line. |
| RN-internal `RCTLog` | natively, via the bridge round-trip back into JS | `true` | The JS patch never sees these — RN core warnings, native module errors — so the native filter is the only place the user's callback can run. |

Both send `LogSource.Custom`, which is what makes the source consistent across platforms.

**This fixes two divergences that exist today.** The iOS RN hook tags logs `source: 98` while Android tags the same logs `source: 4`, because neither platform exposed a source parameter publicly and Android's wrapper had no other route — so one `console.log` in one app is recorded differently per platform. And `BGSLoggerInterceptor.m:54` hard-codes `enforceFiltering:NO`, so React Native logs on iOS are **never** passed through the log filter: a customer's redaction silently does not apply to them, while the comparable Android logs are filtered. The second is a privacy gap, not a cosmetic one, and neither is fixable inside a hook with the flag baked in.

Three implementation constraints:

1. **Dedup before either filter runs.** Under `__DEV__`, `console.log` reaches both the JS patch and `RCTLog`. Dedup is not only about duplicate lines — without it the user's filter callback runs twice on one message by two different routes. React Native only routes `console.*` through `RCTLog` under `__DEV__`, and Hermes release builds commonly strip console calls, so neither stream is sufficient alone and both must be live.
2. **The native→JS filter round-trip is a redaction boundary.** `RCTLog` can fire on any thread, including during teardown. A filter callback that cannot complete must **drop the line, not pass it through** — failing open at a redaction boundary leaks exactly the data the callback existed to remove.
3. **Verify in both Debug and Release.** The two streams overlap in one and not the other, so a dedup that looks correct in development can silently drop everything in a release build.

---

## 11. Expo config plugin

`plugin/src` compiled to `plugin/build`, exposed as `@bugsee/react-native/app.plugin.js`.

- **Android:** `withSettingsGradle` adds `mavenCentral()` to `pluginManagement` — the plugin marker is on Maven Central, **not** the Gradle Plugin Portal; `withProjectBuildGradle` applies `com.bugsee.android.gradle`; `withDangerousMod` writes `android/bugsee.properties`; `withAndroidManifest` optionally writes the `com.bugsee.app-token` meta-data for 7.x manifest auto-launch.
- **iOS:** `withXcodeProject` inserts the source-map build phase after *Bundle React Native code and images*, and `withDangerousMod` inserts the dSYM scheme post-action (§11.2). No Xcode surgery is needed for the SDK itself — `spm_dependency` injects the package reference at `pod install`.
- **Options:** `appToken`, `uploadSourcemaps`, `uploadSymbols`, `nativeCrashReporting`, `gradlePluginVersion`, `autoLaunch`.

The feedback package needs no plugin: autolinking picks up its Gradle dependency and its podspec carries its own `spm_dependency`.

### 11.1 Android — mapping.txt and native debug symbols

Both are the Gradle plugin's job, and both come for free once §4.3 has applied it. The plugin finalizes `assemble<Variant>` / `bundle<Variant>` with a mapping-upload task, injects a per-build `BUILD_UUID` into the merged manifest for symbol correlation, and uploads native debug symbols on the same finalization model. Nothing in the JS layer or the bridge participates.

Two things the config plugin must still supply:

1. **The app token**, which the plugin resolves from an **unprefixed** `app_token=` key in `<rootProject>/bugsee.properties` — for a React Native app that is `android/bugsee.properties`, not `android/app/`. Note the namespace split: the token is `app_token=`, while plugin behaviour uses `plugin.*` keys. `plugin.appToken` is **not** a valid key.
2. **NDK symbol upload is opt-in** — `plugin.ndk.enabled=true` (or `bugsee { ndk { enabled.set(true) } }`), default `false`.

On that second point the RN default should differ from the SDK's. Every React Native app ships native libraries it did not write — Hermes, `libreactnative.so`, JSI, plus any native modules — and a crash inside them is exactly the kind that is unreadable without symbols. So `nativeCrashReporting` defaults **on** in the config plugin, which writes `plugin.ndk.enabled=true` *and* adds the `com.bugsee:bugsee-android-ndk` dependency, since NDK crash **detection** is a separate extension module from symbol **upload** and neither is useful alone. It is dependency-driven auto-install for OkHttp, Ktor, Cronet and Compose, but not for NDK, so this one is explicit. Opt out for build time or upload size.

### 11.2 iOS — dSYM upload, post-action and build phase

The flow is `bugsee-cli xcode post-action`, which handles dSYM upload plus build-info and optional size analysis. It daemonizes by default, specifically so it can never fail an already-signed build, and gates on Archive + Release unless `BUGSEE_BUILD_INFO_ALL_ACTIONS` / `BUGSEE_BUILD_INFO_ALL_CONFIGURATIONS` say otherwise.

**A build phase is viable today, contrary to what this spec first claimed.** dSYM discovery does not depend on the archive: `resolve_dsym_folder` *prefers* `$DWARF_DSYM_FOLDER_PATH` — which its own comment notes is "set in every Run-Script env" — and falls back to `<archive>/dSYMs` only when that does not resolve. `ARCHIVE_PATH` is a fallback for dSYMs and a requirement only for locating the `.app` for build-info.

What is genuinely coupled is the **gate**, not the dSYM step. `should_run` admits the flow when either `ACTION == "install"` with a real `ARCHIVE_PATH`, **or** `BUGSEE_BUILD_INFO_ALL_ACTIONS` is set with a real `TARGET_BUILD_DIR` — the second of which a build phase satisfies. `upload_dsyms` then runs inside that gate, so `BUGSEE_BUILD_INFO_ENABLED=0` disables dSYM upload too.

So today there are two workable shapes, and one real gap:

| Shape | Works? | Cost |
|---|---|---|
| Scheme post-action on Archive | yes, the documented path | dSYMs only on Archive |
| Build phase with `BUGSEE_BUILD_INFO_ALL_ACTIONS=1` | yes | forces build-info registration on every build |
| Build phase, dSYMs only, no build-info | **no** | no `--dsyms-only` mode exists |

That gap is the subject of `bugsee/bugsee-cli#19` (§14.4). Sentry and Firebase both take the build-phase route — `sentry-cli debug-files upload` and Crashlytics' `upload-symbols`, both reading `DWARF_DSYM_FOLDER_PATH` — so the shape is well-trodden and the parity ask is reasonable.

**This SDK supports both, and defaults to the post-action.** The post-action stays the default because it is what Bugsee documents, it is Archive-gated (which is what you actually want to symbolicate), and it cannot fail a signed build. The build phase is offered for teams that want dSYMs from every build or that already keep all build-time integration in phases.

**One gotcha that bites the build-phase route specifically:** Xcode 15+ defaults `ENABLE_USER_SCRIPT_SANDBOXING` to `YES`, which blocks a script from reading outside its declared inputs and makes `sentry-cli` and friends fail — Sentry's own docs tell users to set it to `NO`. If the config plugin writes a build phase it must either set that build setting or declare proper input/output file lists. The post-action route is unaffected, which is another reason it stays the default.

**Call the CLI directly rather than locating `BugseeAgent`.** The documented setup greps for the `BugseeAgent` Python script (`find "$PROJECT_DIR" -name 'BugseeAgent'`, or an SPM-checkout path under `SourcePackages/checkouts/spm/Tools/`), and `docs/sdk/ios/symbolication.mdx` already carries a React-Native-specific caveat telling readers to append `/../` to `$PROJECT_DIR` because the script lands in `node_modules`. `BugseeAgent` is a thin Python wrapper that shells out to `bugsee-cli xcode post-action` anyway, and this SDK already depends on `@bugsee/cli` for source maps (§9.2). Invoking the CLI directly deletes the path-guessing, the Python 3 requirement, and that RN caveat outright.

**Expo has no helper for this.** `@expo/config-plugins`' `ios/Scheme.ts` manipulates URL schemes in `Info.plist`, not `.xcscheme` build schemes, and nothing else in the package touches them. So the plugin edits `ios/<Name>.xcodeproj/xcshareddata/xcschemes/<Name>.xcscheme` through a `withDangerousMod`, inserting a `<PostActions>` / `<ExecutionAction>` block. That XML surgery is the most fragile part of the plugin and needs an explicit test in the Expo example app asserting the post-action survives `prebuild --clean`.

So iOS ends up with **two** build-time integrations, at different stages for different reasons: a build phase after *Bundle React Native code and images* for JS source maps, because the bundle only exists during the build; and a scheme post-action for dSYMs, because `ARCHIVE_PATH` only exists after it.

---

## 12. Testing

- **Unit (Jest)** over a mocked native module: option serialization, key mapping, enum coercion, exception payload shape, filter plumbing.
- **Option manifest parity** (§8), CI-blocking.
- **Native unit tests** for the two pieces of real logic in the bridges: the Android enum-coercion table and the secure-rectangle buffer encoding.
- **Device smoke tests** via **Maestro** on both example apps. The current repo uses Detox; Maestro is substantially lower maintenance for this and does not require instrumenting the app.
- **Acceptance: does a correct report arrive?** Drive the example app to crash, then assert through the Bugsee API that the issue exists, that the JS stack symbolicated through the uploaded source map, and that video and logs are attached. Every other layer can pass while the product is broken; this is the only one that catches a bad option key, a missing debug ID, or a wrapper that never registered.

## 13. CI and release

GitHub Actions on `bugsee/bugsee-react-native`, matrixed across RN 0.83.x / 0.86.x / 0.87.x. Jobs: lint + typecheck + unit; option-manifest parity; codegen freshness; Android example build and test; iOS example build on macOS (which is what proves `spm_dependency` resolves the pinned beta); and `expo prebuild --clean` followed by a build, which is the only thing that proves the config plugin survives regeneration.

Release via Changesets, matching `javascript/` and `rrweb`. Because the iOS SDK is beta, the package ships as `1.0.0-beta.N` on the **`beta`** npm dist-tag; `latest` stays unpublished until iOS reaches GA, so nobody installs a beta by accident.

Native versions live in `native-versions.json`, which generates and validates the two podspecs and the two Gradle files, so bumping iOS from `7.0.0-beta1` is one edit rather than four.

---

## 14. Cross-repo dependencies

Work outside this repository that this design depends on or has surfaced.

1. **`bugsee-cli`: publish `@bugsee/cli`** with per-OS `optionalDependencies` plus a postinstall fallback. Implemented in `bugsee/bugsee-cli#21`. **Blocking** for source-map upload until merged and first published.
2. **Both native SDKs: publish `options-manifest.json`** (§8). Schema specified in `bugsee/report-bundle-structure#14`. **Blocking** for the parity gate.
3. **Unified cross-SDK exception format.** Agreed as a direction and beneficial to the forthcoming Flutter, Unity and .NET refactors, but out of scope here. It belongs in `bugsee/report-bundle-structure` as its own design, alongside the wire format it would change. One constraint for it: the worker currently routes on the *exception name string*, so a unified format needs a new discriminator or a parallel path, or every existing wrapper's reports stop being recognised on upgrade. The RN SDK ships against today's contract with the payload behind one serializer, so swapping it later is a contained change.
4. **`bugsee-cli`: a dSYM-only build-phase mode** (§11.2). `upload_dsyms` runs inside the build-info gate, so a build phase can only upload dSYMs by also opting into build-info registration on every build via `BUGSEE_BUILD_INFO_ALL_ACTIONS=1`, and `BUGSEE_BUILD_INFO_ENABLED=0` disables dSYM upload as a side effect. Sentry and Firebase both ship a dSYM-only build phase. Non-blocking — the post-action path works today. Filed as `bugsee/bugsee-cli#19`.
5. **Open issues filed while designing:**
   - `bugsee/docs#58` — the Android migration guide wrongly states `IssueSeverity.Critical` was removed. It exists in the 7.2.0 API dump and on iOS.
   - `bugsee/bugsee-android#87` — enum-typed options accept a `String` in `validateValueType` but only the Bundle path converts it; the Map path used by `launch(Context, String, Map)` stores it verbatim, so the option is accepted-and-silently-wrong.
   - `bugsee/bugsee-cocoa#88` — the React Native log hook was duplicated between the public `BugseeLogger` and the live `BGSLoggerInterceptor`, with the level mapping in both. PR #89 consolidates it.

     **Superseded in part.** That issue asked *where* the hook should live. The answer turned out to be *nowhere*: see §10.3. `bugsee/bugsee-cocoa#91` and `bugsee/bugsee-android#90` add a generic source-aware log API to each SDK, after which the React-Native-specific code is deleted from the Apple core outright and this wrapper owns the `RCTLogLevel` mapping. #89 should be trimmed to its CocoaLumberjack half rather than merged whole, so public API is not added and then removed a release later.

6. **Blocking for §10.3:** `bugsee/bugsee-cocoa#91` and `bugsee/bugsee-android#90`. Until both land, the wrapper cannot record `LogSource.Custom` and cannot run the user's filter over RN-internal logs on iOS. The console component ships JS-side capture first and adopts the native stream when they do.

## 15. Open questions

- **`spm_dependency` with a dynamic xcframework needs empirical validation** on a real RN app, including under Expo prebuild and with `USE_FRAMEWORKS` unset. Everything in §6.5 follows from reading the RN helper and the iOS build scripts; it has not been run.
- **Whether the source-map upload should be its own package.** Sentry splits `@sentry/expo-upload-sourcemaps` because EAS Build invokes it as a standalone hook outside the config plugin. Starting in-package, to be split only if EAS forces it.
- **`bugsee-cli` npm packaging timeline**, which gates §9.2.

---

## Appendix A: verified native state (2026-09-15)

**Android — GA.** `android/sdk` version.txt `7.2.0`. Maven Central has `com.bugsee:bugsee-android` 7.2.0 and the same for `-feedback`, `-okhttp`, `-compose`, `-ndk`, `-ktor-2`, `-ktor-3`, `-cronet`. Gradle plugin `com.bugsee:bugsee-android-gradle-plugin` 4.0.6 and its marker `com.bugsee.android.gradle.gradle.plugin` 4.0.6 are on Maven Central; the Gradle Plugin Portal does **not** serve it. The plugin is mandatory for SDK 7.x.

**iOS — beta, SPM only.** `ios/sdk` version.txt `7.0.0-beta1`, shipping from branch `nextgen`. `github.com/bugsee/spm` tag `7.0.0-beta1`, products `Bugsee` and `BugseeSwiftUI`, platforms iOS 13 / tvOS 13 / visionOS 1, binary target `https://download.bugsee.com/sdk/ios/spm/Bugsee-7.0.0-beta1.zip`, built from the `BugseeDynamic` target. `github.com/bugsee/feedback-spm` tag `7.0.0-beta1`, product `BugseeFeedback`, pinning `bugsee/spm` exactly. No CocoaPods channel for 7.x.

**Shared option namespace.** Both SDKs accept the same `com.bugsee.option.*` keys; `BugseeOptions.h` states the intent verbatim for cross-platform wrappers. Android-only and iOS-only key sets are enumerated in the research notes accompanying this design.

**Enum values.**

| | Android | iOS | Note |
|---|---|---|---|
| Severity | VeryLow 1, Medium 2, High 3, Critical 4, Blocker 5 | Low 1 … Blocker 5 | values align; index 1 named differently. `Critical` is **not** removed |
| LogLevel | Error 1 … Verbose 5 | Invalid 0, Error 1 … Verbose 5 | align |
| VideoQuality | Default 0, Medium 1, High 2 | same | align |
| FrameRate | Low 1, Medium 2, High 3, Raw 4 | Low 1, Medium 2, High 3 | `Raw` Android-only |
| VideoMode | None 0, V1 1, V2 2, Fullscreen 20, DirectBuffers 21 | — | Android-only; V3 removed |

**React Native.** npm latest 0.87.1 (2026-08-26); maintained lines 0.83.10, 0.86.3, 0.87.1. Legacy architecture disabled in 0.82, removed from the codebase in 0.83, bridge deleted in 0.85. CocoaPods trunk goes permanently read-only 2026-12-02.

## Appendix B: stale prior art

- `cross/MIGRATION_REPORT.md` and `cross/_WRAPPER_OPTION_SPEC.md` were written against Android **7.0.0-beta12** on 2026-06-01. Both are now partly stale: they predate the shared iOS/Android option-key contract, and they state that wrapper blackout maps to iOS `pause`/`resume`, which 7.x removed. Their guidance that Android needs enum *instances* on the Map path does still hold (§14.2).
- `docs/sdk/react_native/*` and `docs/ai/agent-skills/sdk/react-native/SKILL.md` document the 6.x wrapper and need rewriting alongside this work.
