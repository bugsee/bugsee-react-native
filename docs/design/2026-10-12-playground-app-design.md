# Playground app: design

Status: proposed, 2026-10-12

## 1. Purpose

`examples/playground` is an Expo app that launches Bugsee and gives a person a
screen for every public API of `@bugsee/react-native` and
`@bugsee/react-native-feedback`, and for every capability Bugsee intercepts:
logging, network, privacy, crashes, reports, feedback, data and performance.

It serves two audiences with one app:

- **Users.** It is a published sample. A developer clones the repo, adds a token
  (typed or scanned), and explores Bugsee in under ten minutes. Each screen
  shows the code path it exercises.
- **Our team.** It is the tool for manual validation sessions, starting with the
  first beta. Every manual checklist item maps to a screen, a button and an
  expected result.

Success criteria:

1. Every public API of both packages is reachable from a screen.
2. Every manual checklist item (M-A, M-B, M-C, and the staging items left for
   the manual session) is covered by a row in `VALIDATION.md` that names the
   screen, the button and the expected result.
3. A new user gets a first report on the dashboard by following the README only.
4. CI builds the app on both platforms on every relevant PR, so it cannot rot.

Out of scope: store or TestFlight builds, EAS, localisation, tablet and
landscape layouts, a web target, and device e2e automation. `examples/bare`
stays the automated e2e harness. The playground does not replace it, and the
two share no code.

## 2. Decisions

| Topic | Decision |
|---|---|
| Framework | Expo with a development build (`expo prebuild`, `npx expo run:*`). It never runs in Expo Go, because Bugsee needs native code. |
| Home | `examples/playground` in this repo, source only. It is a Yarn workspace that depends on the SDK packages with `workspace:*`. |
| Token at run time | An in-app Setup screen: paste the token, or scan a QR code (`BGSAPT:<token>`). It is stored on the device. |
| Token at build time | An optional, git-ignored `bugsee.config.json` passed to the config plugin, or environment variables. |
| Manual support | Every action shows an "Expect:" line. There is no test bookkeeping in the app. |
| Style | A catalog of capability tabs, plus a small realistic shop flow. |
| Navigation | Expo Router, file-based. |
| UI | React Native core components and a few small shared components. No UI kit. |
| Native triggers | A local Expo module, `modules/playground-native` (Swift, Kotlin, C++). |
| Endpoints | No internal Bugsee host appears anywhere in the app or its docs. |

## 3. Structure

```
examples/playground/
  app.config.ts               reads bugsee.config.json → @bugsee/react-native plugin
  bugsee.config.example.json  committed; appToken only
  bugsee.config.json          git-ignored; the user's real values
  app/
    _layout.tsx               root: SessionProvider; routes to Setup until launched once
    setup.tsx                 token (paste or scan), endpoint, launch options, Launch
    scan.tsx                  camera QR scanner (modal)
    (tabs)/_layout.tsx        Home · Capture · Privacy · Errors · Reports · Data · Perf
    (tabs)/index.tsx          Home
    (tabs)/capture.tsx  privacy.tsx  errors.tsx  reports.tsx  data.tsx  perf.tsx
    shop/_layout.tsx          shop stack + "Report a problem" header button
    shop/sign-in.tsx  products.tsx  product/[id].tsx  checkout.tsx
  src/
    session/                  SessionProvider, saved config (AsyncStorage), status + lifecycle log
    ui/                       ActionButton, Section, ResultLog, Toggle, KnownIssue, Banner
    demoApi.ts                public test endpoints + bundled offline mock
    options/                  common launch-option fields; advanced editor from option-keys.json
  modules/playground-native/  local Expo module (section 8)
  __tests__/                  render and action-mapping tests (section 9)
  README.md  VALIDATION.md
```

Code conventions:

- Each screen is one file of about 100–200 lines, with every Bugsee call written
  inline where a reader can see it.
- State is plain React state plus one session context. There is no state
  library.
- Screens never call the native module directly. They use its typed wrapper.

## 4. Setup and session

### 4.1 Setup screen

- **App token.** The screen shows the field for the current platform, because
  iOS and Android are separate Bugsee apps. Input:
  - **Paste or type.** The value must be a UUID.
  - **Scan QR** (`expo-camera` barcode scanning). The screen accepts only
    payloads that match `^BGSAPT:<uuid>$` exactly. Anything else shows "Not a
    Bugsee app token". The QR codes come from the dashboard (requested in
    bugsee/bugsee-web-viewer#93). The camera permission text is set in
    `app.config.ts`.
- **Endpoint.** Optional, and empty by default, with the hint "Leave empty for
  Bugsee cloud". It is validated by the same rule the config plugin uses.
- **Pre-fill.** Values from the build-time config (section 5) pre-fill both
  fields.
- **Token mismatch warning.** `app.config.ts` exposes the first 8 characters of
  each build-time token in `extra`. App tokens ship inside every app anyway, so
  this exposes nothing new. If the run-time token differs, Setup warns: "Symbols
  were uploaded for app `1a2b3c4d…`. You're launching with `9f8e…`, so crashes
  won't be symbolicated."
- **Launch options.**
  - *Common:* typed `BugseeLaunchOptions` fields. These are video, network, logs
    and log level, breadcrumbs, crash and hang detection, duration, max data
    size, and Wi-Fi-only upload.
  - *Advanced:* an editor generated from the SDK's `option-keys.json` (shared
    and per-platform keys), applied through `setCustomOption`. Every option is
    reachable with no hand-written UI per key.
- **Launch.** Saves the configuration, calls `launch`, and navigates to the
  tabs.

### 4.2 Session

`SessionProvider`:

- holds the saved configuration, the latest `getStatus` and `onStatusChange`
  value, and a ring buffer of `onLifecycleEvent` entries;
- offers an "auto-launch on next start" setting. When it is on, the root layout
  launches before the first screen, which the crash-recovery flows need.

### 4.3 Without a token

The app runs, and every screen shows a "Bugsee not launched" banner. Actions
still call the API and print what it returns, so a user can see how calls
behave before launch.

## 5. Build-time token and symbol upload

The build tooling uploads symbols before the app ever runs, so their token comes
from the build configuration and never from the Setup screen.

### 5.1 Configuration

`bugsee.config.example.json` is committed, contains placeholders only, and has
no `endpoint` key:

```json
{ "appToken": { "ios": "<iOS app token>", "android": "<Android app token>" } }
```

The user copies it to the git-ignored `bugsee.config.json`. An optional
`endpoint` key is documented in the README for self-hosted and regional
installs, using `https://bugsee.example.com` as the example. The README also
documents `symbolicateReactNativeFrameworks`.

`app.config.ts` reads the file, when it exists, and passes `appToken`,
`endpoint` and `symbolicateReactNativeFrameworks` to the `@bugsee/react-native`
config plugin. On `expo prebuild`:

| Platform | Where the token lands | What it uploads |
|---|---|---|
| Android | `android/bugsee.properties` (`app_token`, `plugin.endpoint`) | The Bugsee Gradle plugin uploads the R8/ProGuard mapping, the unstripped NDK `.so` files and the Hermes source maps, and registers the build |
| iOS | the Xcode bundle phase and the Archive post-action | Hermes source maps from the bundle phase; dSYMs from the Archive (the app, the native module and Bugsee, plus React with `symbolicateReactNativeFrameworks: true`) |

### 5.2 Other sources and fallbacks

- **Environment.** `BUGSEE_APP_TOKEN` (both platforms) or `BUGSEE_TOKEN_IOS`
  (iOS only) also work, for CI or for machines without the file. The README
  shows `ios/.xcode.env.local`.
- **No token.** Every upload skips with one warning line and the build still
  succeeds. The app runs, but crashes show raw frames.
- **Build type.** Uploads happen only in Release builds and Archives. The
  README's "See symbolicated crashes" section gives the commands:
  - `npx expo run:android --variant release`
  - `npx expo run:ios --configuration Release`
  - Xcode → Product → Archive, for dSYMs

## 6. Screens

### 6.1 Common components

- **`ActionButton`.** A label, the exact call shown in monospace, and an
  **Expect:** line that says what should appear in the report or on the
  dashboard. Pressing it runs the call and writes the result to the screen's
  `ResultLog`: the returned value, a rejection, or a typed error such as
  `BugseeReportError`, `BugseeAttributeError` or `BugseeSpanError`.
- **Crash buttons.** These ask for confirmation first. Their hint says "reopen
  the app to send the report".
- **`KnownIssue`.** Where a call is known not to work on a platform, the Expect
  line says so and links the upstream issue. The current list is in section
  6.3. A known issue is removed once a fixed SDK version is adopted.

### 6.2 Catalog

| Tab | Content |
|---|---|
| Home | Status and lifecycle log; current `getLaunchOptions`; Launch / Relaunch with edited options / Stop; `deleteCollectedDataOnDevice(true / false)`; the auto-launch switch; the "Try the demo shop" card |
| Capture: Logging | `Bugsee.log` at each level; `console.log/info/warn/error`; native log lines (`os_log` / `NSLog`, `android.util.Log`); a burst of 500 lines; `setLogFilter`, to drop or rewrite lines, on and off |
| Capture: Network | `fetch` and XHR GET and POST with JSON, form, binary, large and no-Content-Type bodies; a 4xx; a 5xx; a timeout; a failed DNS lookup; a WebSocket echo; native `URLSession` / `OkHttp` requests; `setNetworkFilter` to redact a header or drop a URL; `addNetworkEvent` |
| Capture: WebView | A `react-native-webview` page that writes console output, makes a fetch and throws a JS error |
| Privacy | `startBlackout` / `endBlackout` / `isBlackout`; `BugseeSecure` around a view; secure `TextInput` (password and card); `setSecureRectangles` with a visible overlay; the native secure field next to a plain one; "blackout before launch" |
| Errors | `logException` with an Error, a string and a domain; an `ErrorBoundary` demo; an unhandled promise rejection; `testJsCrash`; `testNativeCrash`; native module crashes (segv, abort, exception, background thread); NDK crashes (Android only); a 6-second main-thread hang |
| Reports | `showReportDialog` with prefill; `upload` with summary, description, severity and labels; `createReport` with the report operations; `captureViewHierarchy`; `setReportHandler` presets (add labels, attach a file, drop the report) on and off; Feedback: `showFeedbackUI`, `setGreeting`, `appearance` presets, and listener events shown in the log |
| Data | `setUserIdentifier` / `clearUserIdentifier` / `getUserIdentifier`; attributes set, get, get all, clear one and clear all, for every value type and for invalid values; `addBreadcrumb` and `setBreadcrumbFilter`; `event` with and without parameters; `trace`; `attach` with text, an image, and a too-large file |
| Perf | `startTransaction` with child spans (a fake checkout of about 1.2 s); `startSpan`, `getActiveSpan`, `setName` and status; nested spans around real network calls; a "slow render" action |

### 6.3 Known issues shown in the app at the first beta

These are the issues that affect a playground action on iOS 7.0.0-beta5 or
Android 7.3.1:

| Issue | Action affected |
|---|---|
| bugsee-cocoa#196 | `capture.video=false` |
| bugsee-cocoa#195 | `deleteCollectedDataOnDevice` (iOS) |
| bugsee-android#250 | `deleteCollectedDataOnDevice(false)` (Android) |
| bugsee-cocoa#220 | report handler edits on a crash recovered at the next launch |
| bugsee-cocoa#224 | a second `createReport` |
| bugsee-android#248 | blackout before launch (Android) |
| bugsee-cocoa#223 | `upload` trigger shows as unknown (iOS) |

The list is maintained in one file, `src/ui/knownIssues.ts`.

## 7. Demo shop

The shop is reached from Home. It has no Bugsee API buttons; it shows what Bugsee
captures from an ordinary app. Every shop screen has a collapsible "What Bugsee
captured here" note, which plays the part of the Expect lines.

The whole flow runs inside `startTransaction('checkout')`, with a span for each
step.

1. **Sign in.**
   - Email field, plus a password field with `secureTextEntry`. The video should
     show the password masked with no extra code.
   - Submitting POSTs to a public echo endpoint with the password in the body.
     The shop's network filter redacts it, so the report shows `"***"`.
   - "Remember me" calls `setUserIdentifier(email)`.
2. **Products.**
   - The list comes from a public demo JSON API, with images.
   - Pull to refresh adds a breadcrumb. Tapping a product records
     `event('product_viewed', { id })`.
   - With the "flaky" toggle on, one load in three returns a 500, shown as an
     inline error and recorded with `logException` as handled.
3. **Product detail.** "Add to cart" updates the attribute `cart_items`.
4. **Checkout.**
   - The card number, expiry and CVV fields are wrapped in `BugseeSecure`. The
     shipping address is left unmasked for comparison.
   - **Pay** has three outcomes, chosen with a segmented control:
     - **Success:** a toast; the transaction ends `ok`.
     - **Declined:** the server returns 402; the app calls `logException` with
       labels `checkout, payment` and severity 4.
     - **Bug:** a deliberate JS crash (`undefined.total`), as a realistic
       mistake. The report sent at the next launch shows the whole flow: video,
       network calls, breadcrumbs, attributes and the user id.
5. **Report a problem.** A header button on every shop screen calls
   `showReportDialog` with the summary pre-filled as "Problem on <screen>".

`src/demoApi.ts` uses public test services only and never a Bugsee host. If they
can't be reached, it falls back to a bundled mock. The failed requests still
appear in network capture.

## 8. Native module (`modules/playground-native`)

A local Expo module (`expo-modules-core`). Its only job is to give the screens
real native activity, so it contains no Bugsee calls and no test hooks.

| API | iOS | Android |
|---|---|---|
| `crash('segv' \| 'abort' \| 'exception' \| 'backgroundThread')` | null write, `abort()`, `NSException`, a throw on a background queue | a JNI null write, `abort()`, `RuntimeException`, a throw on a `Thread` |
| `crashNdk('segv' \| 'abort')` | not available; the button is hidden | C++ in `libplayground_native.so` (CMake) |
| `hangMainThread(ms)` | sleeps the main thread | sleeps the main thread |
| `log(level, message)` | `os_log` and `NSLog` | `android.util.Log` |
| `request(method, url, body)` | `URLSession` | `OkHttp` (captured through the Bugsee Gradle plugin) |
| `<NativeSecureField />` | a `UITextField` with `secureTextEntry`, next to a plain field | an `EditText` with a password input type, next to a plain field |

- **Typed wrapper.** Screens call the module through
  `modules/playground-native/index.ts`. Under Expo Go the wrapper falls back to
  a no-op that reports "native module unavailable".
- **Crash timing.** Crash functions run 300 ms after the confirmation tap, so the
  tap's breadcrumb and video frame are captured first.
- **Symbols.** The module's code is part of the app binary, so the normal symbol
  upload covers it, and its crashes double as a demonstration of native and NDK
  symbolication.

## 9. Build and CI

- **Running it.** Root scripts `yarn playground ios` and
  `yarn playground android` run `expo prebuild` followed by `expo run:*`.
- **Generated native folders.** `ios/` and `android/` are generated and
  git-ignored (Continuous Native Generation).
- **Use outside this repo.** A README section explains how: replace
  `workspace:*` with the published version.

A new CI job runs on PRs that touch `examples/playground/**`, `packages/**` or
the workflow file, and on every push to `main`. It runs these steps:

1. TypeScript (`tsc --noEmit`) and lint for the app.
2. Jest render tests. Every screen renders with Bugsee and the native module
   mocked. A table-driven test checks that each `ActionButton` calls the API
   its label shows, so labels and calls cannot drift apart.
3. `expo prebuild`, then an Android `assembleDebug` and an unsigned iOS
   simulator build. A change to the native module, the config plugin or the SDK
   that breaks the sample fails the PR.
4. An internal-host check: the job fails if any file under
   `examples/playground/` contains a `*.bugsee.com` host outside the public
   allowlist. A repo-wide version of this check comes with the staging-host
   cleanup PR.

## 10. Documentation

- **`examples/playground/README.md`.** For users. It covers:
  - prerequisites;
  - copying the config;
  - `prebuild` and `run`;
  - entering the token (paste or scan);
  - the first report;
  - a tour of the tabs and the shop;
  - "See symbolicated crashes";
  - "Use outside this repo".
- **`examples/playground/VALIDATION.md`.** For manual sessions. It has one row
  per manual checklist item, giving the ID, the tab and section, the action,
  the expected result, and where to look on the dashboard. It says "your Bugsee
  instance" and names no host. The campaign's MANUAL-PENDING steps are rewritten
  to point at it.
- **Endpoint rule.** No internal Bugsee host appears in the app's code, its
  config example or its docs. Our own staging values live only in git-ignored
  local files.

## 11. Testing the playground itself

- **CI (section 9).** Type checks, render tests, the action-mapping test, both
  native builds, and the host check.
- **Before it is used for the first beta session.**
  - One smoke pass on the iPhone XS and on WOD_LX1, with a dead endpoint
    (Release builds):
    - launch;
    - each tab renders;
    - the shop flow completes;
    - one JS crash, one native crash and one NDK crash are recovered at the next
      launch.
  - The QR scan is tested with a generated `BGSAPT:` code until the dashboard
    feature ships.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Public demo APIs go away or rate-limit | Bundled offline mock in `demoApi.ts`; the network screens use only a few public endpoints, wrapped in one file |
| The known-issue list goes stale | Kept in one file (`src/ui/knownIssues.ts`); updated as part of every SDK-pin bump PR |
| The sample drifts from the SDK | `workspace:*` dependencies, the CI native builds, and the action-mapping test |
| A user ships with a placeholder or missing token | Uploads skip with a warning (existing plugin behaviour); the app shows the "not launched" banner |
| Expo Go users get confused | The README says "development build required"; the native module's no-op fallback says so on screen |
