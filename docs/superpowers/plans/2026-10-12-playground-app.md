# Playground App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `examples/playground`, an Expo (development build) sample app that launches Bugsee and has a screen for every public API of `@bugsee/react-native` and `@bugsee/react-native-feedback`, plus a demo shop. It is used for manual validation and published as a sample.

**Architecture:**
- **Workspace and routing.** It is a Yarn workspace under `examples/playground`, with Expo Router (file-based). Route files are one-line re-exports of screens in `src/screens/`.
- **Actions.** Each screen declares its Bugsee calls as a module-level `actions` array of `Action` objects (label, the literal call, an Expect line, `run`). A shared `ActionButton` renders them, and one table-driven Jest test runs every action against mocks to prove the label's call is the call made.
- **Native triggers.** A local Expo module, `modules/playground-native`, provides native crashes, hangs, logs, requests and a secure field. It makes no Bugsee calls.

**Tech Stack:**
- Expo SDK 57 (`expo ~57.0.26`), React Native 0.86.x as Expo 57 pins it, React 19.2.3, Expo Router, `expo-camera`, `expo-constants`, `@react-native-async-storage/async-storage`, `react-native-webview`, `expo-modules-core` (local module: Swift, Kotlin, C++/CMake).
- Tests: Jest via `jest-expo`, `@testing-library/react-native`.
- TypeScript ~5.6.

**Spec:** `docs/design/2026-10-12-playground-app-design.md`

## Global Constraints

- **No internal hosts.** No internal or staging Bugsee host appears anywhere in `examples/playground/` or in CI files: code, config example, docs, tests or comments. The only `*.bugsee.com` hosts allowed are the public allowlist in `scripts/check-no-internal-hosts.ts` on `main`: `api.bugsee.com`, `download.bugsee.com`, `www.bugsee.com`. `yarn lint` enforces it repo-wide. Use `https://bugsee.example.com` as the example endpoint.
- **No real tokens.** No real app token is committed. CI and tests use the placeholder `00000000-0000-4000-8000-000000000000`.
- **Ignored files.** `bugsee.config.json`, `ios/` and `android/` under `examples/playground/` are git-ignored.
- **Dependencies.** The SDK packages are `workspace:*`. Third-party Expo packages are added with `npx expo install <pkg>` from `examples/playground`, so the versions match Expo 57. Commit the resolved versions and `yarn.lock`.
- **Bugsee calls.** Screens call the SDK only through the real exports: `import Bugsee from '@bugsee/react-native'` and `import * as Feedback from '@bugsee/react-native-feedback'`. They call the native module only through `modules/playground-native/index.ts`.
- **Screen shape.** Each screen file is about 100–200 lines, with Bugsee calls written inline in its `actions` array. There is no state library.
- **Commits.** Every commit message ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Root checks.** `yarn lint` and `yarn typecheck` at the repo root keep passing. The root `tsconfig.example.json` excludes `examples/playground/**`, because the playground has its own tsconfig. The root Jest config already ignores `/examples/`.
- **Endpoint.** The Setup endpoint field is empty by default. An empty endpoint means no endpoint key is passed, so the SDKs use Bugsee cloud.
- **QR payload.** A scanned code is accepted only if it matches `^BGSAPT:<uuid>$` exactly. Anything else shows `Not a Bugsee app token`.

## Spec corrections (rulings made while planning; the code is the authority on API shape)

1. **`Bugsee.attach()`** hooks the JS layer onto an SDK that the native side auto-launched. It does **not** attach files. Spec 6.2 Data "`attach` with text, an image, and a too-large file" becomes:
   - Reports → "Attachments": `createReport()` + `addDataAttachment` (text), `addFileAttachment` (image), and a 4 MiB data attachment (rejected on iOS with `E_REPORT_ATTACHMENT_REJECTED`);
   - the report-handler preset "attach a file";
   - Home: an `attach()` row whose Expect explains it is for native auto-launch.
2. **`logException`** options are `{ domain, labels, includeVideo }`; there is no severity. The shop's "Declined" outcome uses `labels: ['checkout', 'payment'], domain: 'payment'`.
3. **APIs the spec's catalog left out**, added so success criterion 1 holds:
   - `notify` (Reports);
   - `logUnhandledException` (Errors);
   - `Bugsee.appearance` report colours (Reports);
   - `onLifecycleEvent` / `onStatusChange` (Session, shown on Home);
   - `getActiveSpan` (Perf);
   - `ErrorBoundary` (Errors).
4. **Route files** under `app/` are one-line re-exports of `src/screens/*`. This keeps action arrays importable by tests without Expo Router; the inline-calls rule applies to `src/screens/*`.
5. **CI** is a separate workflow, `.github/workflows/playground.yml`, with a `paths` filter, as spec 9 asks.
6. **Internal-host check.** PR #77 is merged (d9cfe95). The repo-wide `node scripts/cli-check-no-internal-hosts.ts` already runs inside root `yarn lint`, so the playground job runs that command; there is no second checker.

## Review Focus

1. **QR scan robustness.** A QR code with whitespace, lower/upper-case UUID, a URL, or a second scan while the first navigates should not crash or double-navigate. Expected: trimmed exact match, case-insensitive UUID, one navigation. Owner: Task 3 (`parseQrPayload` tests) and Task 5 (scan screen `handled` ref test).
2. **Corrupt or old saved config in AsyncStorage** (hand-edited, a previous version, or non-JSON). Expected: the app falls back to defaults and shows Setup, and never crashes on start. Owner: Task 3 `loadConfig` tests.
3. **Actions before launch.** Every action pressed while Bugsee is not launched should log what the API returned or threw, never an unhandled rejection or red box. Owner: Task 4 `ActionButton` test (a sync throw and a rejected promise both land in the log).
4. **Bugsee or the native module missing** (Expo Go, or a web preview). Expected: the screens render, and native buttons say "native module unavailable". Owner: Task 2 wrapper fallback test.
5. **Network outage in the shop.** The demo API is unreachable, or it rate-limits. Expected: the bundled mock is used, and the failed request is still made (so it appears in capture). Owner: Task 7 `demoApi` tests.

---

## File map

```
examples/playground/
  package.json  app.config.ts  babel.config.js  metro.config.js  tsconfig.json
  jest.config.js  jest.setup.ts  .gitignore
  bugsee.config.example.json   README.md  VALIDATION.md
  config/bugseeConfig.ts           reads bugsee.config.json + env → plugin props + extra (pure, tested)
  app/_layout.tsx                  SessionProvider + redirect to /setup when never launched
  app/setup.tsx  app/scan.tsx      → src/screens/SetupScreen, ScanScreen
  app/(tabs)/_layout.tsx           Tabs: Home Capture Privacy Errors Reports Data Perf
  app/(tabs)/index.tsx capture.tsx privacy.tsx errors.tsx reports.tsx data.tsx perf.tsx
  app/shop/_layout.tsx sign-in.tsx products.tsx product/[id].tsx checkout.tsx
  src/session/token.ts             isAppToken, parseQrPayload, tokenPrefix
  src/session/config.ts            SavedConfig, DEFAULT_CONFIG, loadConfig, saveConfig
  src/session/launch.ts            buildLaunchOptions, launchWith
  src/session/SessionProvider.tsx  context: config, status, lifecycle ring buffer, launch/relaunch/stop
  src/options/common.ts            CommonOptions + applyCommon
  src/options/advanced.ts          ADVANCED_KEYS (from option-keys.json), parseOptionValue
  src/ui/action.ts                 Action type + callTarget(call)
  src/ui/ActionButton.tsx Section.tsx ResultLog.tsx Toggle.tsx KnownIssue.tsx Banner.tsx Screen.tsx
  src/ui/knownIssues.ts            KNOWN_ISSUES table
  src/demoApi.ts                   public endpoints + offline mock
  src/screens/*.tsx                HomeScreen CaptureScreen PrivacyScreen ErrorsScreen ReportsScreen
                                   DataScreen PerfScreen SetupScreen ScanScreen + shop/*
  src/screens/allActions.ts        every screen's actions, for the mapping test
  modules/playground-native/       expo-module.config.json, index.ts, ios/, android/ (+ CMake)
  __tests__/                       config, token, launch, options, ActionButton, demoApi,
                                   screens.render, actions.mapping, native.fallback tests
.github/workflows/playground.yml
package.json                       root: "playground" script
tsconfig.example.json              exclude examples/playground
```

---

### Task 1: Workspace scaffold and build-time config

**Files:**
- Create: `examples/playground/package.json`, `app.config.ts`, `config/bugseeConfig.ts`, `babel.config.js`, `metro.config.js`, `tsconfig.json`, `jest.config.js`, `jest.setup.ts`, `.gitignore`, `bugsee.config.example.json`, `app/_layout.tsx` (temporary: renders `<Text>Playground</Text>`, replaced in Task 5)
- Test: `examples/playground/__tests__/bugseeConfig.test.ts`
- Modify: root `package.json` (script), root `tsconfig.example.json` (exclude)

**Interfaces:**
- Produces: `resolveBugseeConfig(input: { file?: unknown; env: Record<string, string | undefined> }): { pluginProps: BugseePluginProps; extra: { bugseeTokenPrefix: { ios?: string; android?: string } } }`
- Produces: `readBugseeConfigFile(dir: string): unknown` (undefined when absent)

- [ ] **Step 1: Create `package.json`.**

```json
{
  "name": "bugsee-playground",
  "version": "1.0.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start --dev-client",
    "ios": "expo prebuild -p ios && expo run:ios",
    "android": "expo prebuild -p android && expo run:android",
    "test": "jest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bugsee/react-native": "workspace:*",
    "@bugsee/react-native-feedback": "workspace:*",
    "expo": "~57.0.26",
    "react": "19.2.3"
  }
}
```

  Then, from `examples/playground`, run:

  ```
  npx expo install react-native expo-router expo-constants expo-linking expo-status-bar expo-camera react-native-safe-area-context react-native-screens @react-native-async-storage/async-storage react-native-webview expo-modules-core
  npx expo install -- --dev jest-expo @testing-library/react-native
  ```

  Commit whatever versions they resolve.

- [ ] **Step 2: Write the failing test** `__tests__/bugseeConfig.test.ts`:

```ts
import { resolveBugseeConfig } from '../config/bugseeConfig';

const IOS = '1a2b3c4d-0000-4000-8000-000000000001';
const AND = '9f8e7d6c-0000-4000-8000-000000000002';

describe('resolveBugseeConfig', () => {
  it('passes per-platform tokens and exposes only 8-char prefixes in extra', () => {
    const r = resolveBugseeConfig({ file: { appToken: { ios: IOS, android: AND } }, env: {} });
    expect(r.pluginProps.appToken).toEqual({ ios: IOS, android: AND });
    expect(r.extra.bugseeTokenPrefix).toEqual({ ios: '1a2b3c4d', android: '9f8e7d6c' });
    expect(JSON.stringify(r.extra)).not.toContain(IOS);
  });
  it('omits endpoint when the file has none', () => {
    const r = resolveBugseeConfig({ file: { appToken: IOS }, env: {} });
    expect('endpoint' in r.pluginProps).toBe(false);
  });
  it('passes endpoint and symbolicateReactNativeFrameworks through', () => {
    const r = resolveBugseeConfig({
      file: { appToken: IOS, endpoint: 'https://bugsee.example.com', symbolicateReactNativeFrameworks: true },
      env: {},
    });
    expect(r.pluginProps.endpoint).toBe('https://bugsee.example.com');
    expect(r.pluginProps.symbolicateReactNativeFrameworks).toBe(true);
  });
  it('falls back to BUGSEE_APP_TOKEN, then BUGSEE_TOKEN_IOS for iOS', () => {
    expect(resolveBugseeConfig({ env: { BUGSEE_APP_TOKEN: AND } }).pluginProps.appToken).toEqual({ ios: AND, android: AND });
    expect(resolveBugseeConfig({ env: { BUGSEE_TOKEN_IOS: IOS } }).pluginProps.appToken).toEqual({ ios: IOS });
  });
  it('ignores placeholder values copied from the example file', () => {
    const r = resolveBugseeConfig({ file: { appToken: { ios: '<iOS app token>', android: '<Android app token>' } }, env: {} });
    expect(r.pluginProps.appToken).toBeUndefined();
    expect(r.extra.bugseeTokenPrefix).toEqual({});
  });
  it('treats a non-object file as absent', () => {
    expect(resolveBugseeConfig({ file: 'garbage', env: {} }).pluginProps).toEqual({});
  });
});
```

- [ ] **Step 3: Configure Jest, then run the test to verify it fails.**
  - `jest.config.js`:

    ```js
    module.exports = {
      preset: 'jest-expo',
      setupFiles: ['./jest.setup.ts'],
      testMatch: ['**/__tests__/**/*.test.ts?(x)'],
      modulePathIgnorePatterns: ['<rootDir>/ios', '<rootDir>/android'],
    };
    ```

  - `jest.setup.ts`: for now, only `export {};`. Task 4 fills it.
  - Run: `yarn workspace bugsee-playground test bugseeConfig`.
  - Expected: FAIL, "Cannot find module '../config/bugseeConfig'".

- [ ] **Step 4: Implement `config/bugseeConfig.ts`.**

```ts
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tokens = { ios?: string; android?: string };

export interface ResolvedBugseeConfig {
  pluginProps: { appToken?: Tokens; endpoint?: string; symbolicateReactNativeFrameworks?: boolean };
  extra: { bugseeTokenPrefix: Tokens };
}

export function readBugseeConfigFile(dir: string): unknown {
  const file = path.join(dir, 'bugsee.config.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim() : undefined;
}

export function resolveBugseeConfig(input: {
  file?: unknown;
  env: Record<string, string | undefined>;
}): ResolvedBugseeConfig {
  const file = input.file !== null && typeof input.file === 'object' ? (input.file as Record<string, unknown>) : {};
  const raw = file.appToken;
  const fromFile: Tokens =
    typeof raw === 'string'
      ? { ios: token(raw), android: token(raw) }
      : raw !== null && typeof raw === 'object'
        ? { ios: token((raw as Tokens).ios), android: token((raw as Tokens).android) }
        : {};
  const shared = token(input.env.BUGSEE_APP_TOKEN);
  const tokens: Tokens = {};
  const ios = fromFile.ios ?? shared ?? token(input.env.BUGSEE_TOKEN_IOS);
  const android = fromFile.android ?? shared;
  if (ios) tokens.ios = ios;
  if (android) tokens.android = android;

  const pluginProps: ResolvedBugseeConfig['pluginProps'] = {};
  if (tokens.ios || tokens.android) pluginProps.appToken = tokens;
  if (typeof file.endpoint === 'string' && file.endpoint.trim() !== '') pluginProps.endpoint = file.endpoint.trim();
  if (typeof file.symbolicateReactNativeFrameworks === 'boolean') {
    pluginProps.symbolicateReactNativeFrameworks = file.symbolicateReactNativeFrameworks;
  }
  const prefix: Tokens = {};
  if (tokens.ios) prefix.ios = tokens.ios.slice(0, 8);
  if (tokens.android) prefix.android = tokens.android.slice(0, 8);
  return { pluginProps, extra: { bugseeTokenPrefix: prefix } };
}
```

- [ ] **Step 5: Run the test.** Run: `yarn workspace bugsee-playground test bugseeConfig`. Expected: PASS (6 tests).

- [ ] **Step 6: Write the remaining scaffold files.**

  `app.config.ts`:

```ts
import type { ExpoConfig } from 'expo/config';
import { readBugseeConfigFile, resolveBugseeConfig } from './config/bugseeConfig';

const { pluginProps, extra } = resolveBugseeConfig({ file: readBugseeConfigFile(__dirname), env: process.env });

const config: ExpoConfig = {
  name: 'Bugsee Playground',
  slug: 'bugsee-playground',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'bugsee-playground',
  ios: { bundleIdentifier: 'com.bugsee.playground', supportsTablet: false },
  android: { package: 'com.bugsee.playground' },
  plugins: [
    'expo-router',
    ['expo-camera', { cameraPermission: 'The camera scans the QR code of your Bugsee app token.', recordAudioAndroid: false }],
    ['@bugsee/react-native', pluginProps],
  ],
  extra,
};
export default config;
```

  - `babel.config.js`: same as `examples/expo/babel.config.js`.
  - `metro.config.js`: same as `examples/expo/metro.config.js`.
  - `tsconfig.json`:

    ```json
    { "extends": "expo/tsconfig.base", "compilerOptions": { "strict": true, "noEmit": true }, "include": ["**/*.ts", "**/*.tsx"], "exclude": ["node_modules", "ios", "android"] }
    ```

  - `.gitignore`:

    ```
    ios/
    android/
    .expo/
    bugsee.config.json
    ```

  - `bugsee.config.example.json`:

    ```json
    { "appToken": { "ios": "<iOS app token>", "android": "<Android app token>" } }
    ```

  - Temporary `app/_layout.tsx`:

    ```tsx
    import { Slot } from 'expo-router';
    export default function Root() { return <Slot />; }
    ```

    plus `app/index.tsx`:

    ```tsx
    import { Text } from 'react-native';
    export default function I() { return <Text>Playground</Text>; }
    ```

  - Root `package.json` scripts: add `"playground": "yarn workspace bugsee-playground"`.
  - Root `tsconfig.example.json`: add `"examples/playground/**"` to `exclude`.

- [ ] **Step 7: Verify.** Run, from the repo root:

  ```
  yarn install
  yarn lint
  yarn typecheck
  yarn workspace bugsee-playground typecheck
  cd examples/playground && CI=1 npx expo prebuild --no-install && rm -rf ios android
  ```

  Expected:
  - all commands exit 0;
  - prebuild prints no plugin error;
  - `git status` shows no `ios/` or `android/`.

- [ ] **Step 8: Commit.** Message: `Playground: workspace scaffold and build-time Bugsee config`.

---

### Task 2: Local native module `playground-native`

**Files:**
- Create the following under `examples/playground/modules/playground-native/`:
  - `expo-module.config.json`, `index.tsx` (JSX for the view);
  - `ios/PlaygroundNative.podspec`, `ios/PlaygroundNativeModule.swift`, `ios/NativeSecureFieldView.swift`;
  - `android/build.gradle`, `android/src/main/AndroidManifest.xml`;
  - `android/src/main/java/expo/modules/playgroundnative/PlaygroundNativeModule.kt`, `NativeSecureFieldView.kt`;
  - `android/src/main/cpp/CMakeLists.txt`, `android/src/main/cpp/playground_native.cpp`.
- Test: `examples/playground/__tests__/native.fallback.test.ts`

**Interfaces:**
- Produces: `PlaygroundNative` from `modules/playground-native`:

  ```ts
  type CrashKind = 'segv' | 'abort' | 'exception' | 'backgroundThread';
  interface PlaygroundNativeApi {
    available: boolean;
    supportsNdk: boolean;
    crash(kind: CrashKind): void;
    crashNdk(kind: 'segv' | 'abort'): void;
    hangMainThread(ms: number): void;
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
    request(method: string, url: string, body?: string): Promise<{ status: number; body: string }>;
  }
  export const PlaygroundNative: PlaygroundNativeApi;
  export function NativeSecureField(props: { style?: StyleProp<ViewStyle> }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test** `__tests__/native.fallback.test.ts`:

```ts
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeView: () => { throw new Error('no view'); },
}));
import { PlaygroundNative } from '../modules/playground-native';

it('is a no-op that says so when the native module is missing', async () => {
  expect(PlaygroundNative.available).toBe(false);
  expect(() => PlaygroundNative.crash('segv')).toThrow('native module unavailable');
  await expect(PlaygroundNative.request('GET', 'https://example.com')).rejects.toThrow('native module unavailable');
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test native.fallback`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `index.tsx`.**

```ts
import { requireOptionalNativeModule, requireNativeView } from 'expo-modules-core';
import React from 'react';
import { Platform, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type CrashKind = 'segv' | 'abort' | 'exception' | 'backgroundThread';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface NativeShape {
  crash(kind: CrashKind): void;
  crashNdk(kind: 'segv' | 'abort'): void;
  hangMainThread(ms: number): void;
  log(level: LogLevel, message: string): void;
  request(method: string, url: string, body: string | null): Promise<{ status: number; body: string }>;
}

const native = requireOptionalNativeModule<NativeShape>('PlaygroundNative');
const UNAVAILABLE = 'native module unavailable (Expo Go or a missing dev build)';
const fail = (): never => { throw new Error(UNAVAILABLE); };

export const PlaygroundNative = {
  available: native !== null,
  supportsNdk: native !== null && Platform.OS === 'android',
  crash: (kind: CrashKind) => (native ? native.crash(kind) : fail()),
  crashNdk: (kind: 'segv' | 'abort') => (native ? native.crashNdk(kind) : fail()),
  hangMainThread: (ms: number) => (native ? native.hangMainThread(ms) : fail()),
  log: (level: LogLevel, message: string) => (native ? native.log(level, message) : fail()),
  request: (method: string, url: string, body?: string) =>
    native ? native.request(method, url, body ?? null) : Promise.reject(new Error(UNAVAILABLE)),
};

let NativeView: React.ComponentType<{ style?: StyleProp<ViewStyle> }> | null = null;
try {
  NativeView = native ? requireNativeView('PlaygroundNative') : null;
} catch {
  NativeView = null;
}

export function NativeSecureField(props: { style?: StyleProp<ViewStyle> }) {
  return NativeView ? <NativeView style={[{ height: 100 }, props.style]} /> : <Text>{UNAVAILABLE}</Text>;
}
```

  Importers use `../modules/playground-native`, which resolves `index.tsx`.

- [ ] **Step 4: Run the test.** Run: `yarn workspace bugsee-playground test native.fallback`. Expected: PASS.

- [ ] **Step 5: Write the native sides.**

  `expo-module.config.json`:

  ```json
  { "platforms": ["apple", "android"], "apple": { "modules": ["PlaygroundNativeModule"] }, "android": { "modules": ["expo.modules.playgroundnative.PlaygroundNativeModule"] } }
  ```

  iOS `PlaygroundNativeModule.swift`. Every crash and hang is dispatched to its own queue, so Expo's function-call error handling cannot catch it:

```swift
import ExpoModulesCore
import os.log

public class PlaygroundNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PlaygroundNative")
    Function("crash") { (kind: String) in
      switch kind {
      case "segv": DispatchQueue.main.async { UnsafeMutablePointer<Int>(bitPattern: 0x8)!.pointee = 1 }
      case "abort": DispatchQueue.main.async { abort() }
      case "exception":
        DispatchQueue.main.async { NSException(name: .genericException, reason: "Playground native exception", userInfo: nil).raise() }
      default:
        Thread { NSException(name: .genericException, reason: "Playground background-thread exception", userInfo: nil).raise() }.start()
      }
    }
    Function("crashNdk") { (_: String) in }
    Function("hangMainThread") { (ms: Int) in DispatchQueue.main.async { Thread.sleep(forTimeInterval: Double(ms) / 1000) } }
    Function("log") { (level: String, message: String) in
      let type: OSLogType = level == "error" ? .error : level == "warn" ? .default : level == "debug" ? .debug : .info
      os_log("%{public}@", log: OSLog(subsystem: "com.bugsee.playground", category: "native"), type: type, message)
      NSLog("[playground %@] %@", level, message)
    }
    AsyncFunction("request") { (method: String, url: String, body: String?, promise: Promise) in
      guard let u = URL(string: url) else { promise.reject("E_URL", "bad url"); return }
      var req = URLRequest(url: u)
      req.httpMethod = method
      if let body = body { req.httpBody = body.data(using: .utf8); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
      URLSession.shared.dataTask(with: req) { data, resp, err in
        if let err = err { promise.reject("E_REQUEST", err.localizedDescription); return }
        promise.resolve(["status": (resp as? HTTPURLResponse)?.statusCode ?? 0, "body": String(data: data ?? Data(), encoding: .utf8) ?? ""])
      }.resume()
    }
    View(NativeSecureFieldView.self) {}
  }
}
```

  `NativeSecureFieldView.swift`: an `ExpoView` with a vertical `UIStackView` holding two bordered `UITextField`s. The first has placeholder "Native secure field" and `isSecureTextEntry = true`; the second has placeholder "Native plain field".

  `PlaygroundNative.podspec`:

  ```ruby
  Pod::Spec.new do |s|
    s.name = 'PlaygroundNative'
    s.version = '1.0.0'
    s.summary = 'Playground native triggers'
    s.author = 'Bugsee'
    s.homepage = 'https://www.bugsee.com'
    s.license = 'MIT'
    s.platforms = { :ios => '15.1' }
    s.source = { git: '' }
    s.static_framework = true
    s.dependency 'ExpoModulesCore'
    s.source_files = '**/*.swift'
  end
  ```

  Android `PlaygroundNativeModule.kt`:

```kotlin
package expo.modules.playgroundnative

import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.concurrent.thread

class PlaygroundNativeModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient()

  override fun definition() = ModuleDefinition {
    Name("PlaygroundNative")
    Function("crash") { kind: String ->
      when (kind) {
        "segv" -> main.post { nativeCrash(0) }
        "abort" -> main.post { nativeCrash(1) }
        "exception" -> main.post { throw RuntimeException("Playground native exception") }
        else -> thread(name = "playground-bg") { throw IllegalStateException("Playground background-thread exception") }
      }
    }
    Function("crashNdk") { kind: String -> main.post { nativeCrash(if (kind == "abort") 1 else 0) } }
    Function("hangMainThread") { ms: Int -> main.post { Thread.sleep(ms.toLong()) } }
    Function("log") { level: String, message: String ->
      val p = when (level) { "error" -> Log.ERROR; "warn" -> Log.WARN; "debug" -> Log.DEBUG; else -> Log.INFO }
      Log.println(p, "Playground", message)
    }
    AsyncFunction("request") { method: String, url: String, body: String?, promise: Promise ->
      thread {
        try {
          val rb = body?.toRequestBody("application/json".toMediaType())
          client.newCall(Request.Builder().url(url).method(method, rb).build()).execute().use { r ->
            promise.resolve(mapOf("status" to r.code, "body" to (r.body?.string() ?: "")))
          }
        } catch (e: Exception) { promise.reject("E_REQUEST", e.message ?: "request failed", e) }
      }
    }
    View(NativeSecureFieldView::class) {}
  }

  private external fun nativeCrash(kind: Int)
  companion object { init { System.loadLibrary("playground_native") } }
}
```

  On Android, the JNI "segv" and "abort" crashes are NDK crashes too. `crash('segv'|'abort')` and `crashNdk` share the C++ code; the JS layer labels them differently (Task 9).

  `playground_native.cpp`:

```cpp
#include <jni.h>
#include <cstdlib>
extern "C" JNIEXPORT void JNICALL
Java_expo_modules_playgroundnative_PlaygroundNativeModule_nativeCrash(JNIEnv*, jobject, jint kind) {
  if (kind == 1) abort();
  volatile int* p = nullptr;
  *p = 42;
}
```

  `CMakeLists.txt`:

  ```
  cmake_minimum_required(VERSION 3.22.1)
  project(playground_native)
  add_library(playground_native SHARED playground_native.cpp)
  ```

  `android/build.gradle`:
  - Apply `com.android.library` and `kotlin-android`.
  - `namespace 'expo.modules.playgroundnative'`.
  - `externalNativeBuild { cmake { path 'src/main/cpp/CMakeLists.txt' } }`.
  - `dependencies { implementation project(':expo-modules-core'); implementation 'com.squareup.okhttp3:okhttp:4.12.0' }`.
  - Follow the `build.gradle` shape `npx create-expo-module --local` generates for Expo 57: generate one in the scratchpad and copy its header.

  `NativeSecureFieldView.kt`: an `ExpoView` with a vertical `LinearLayout` holding two `EditText`s. The first uses `inputType = TYPE_CLASS_TEXT or TYPE_TEXT_VARIATION_PASSWORD`, hint "Native secure field"; the second uses hint "Native plain field".

- [ ] **Step 6: Verify that the native code compiles.** Run, from `examples/playground`:
  - `CI=1 npx expo prebuild --no-install && (cd android && ./gradlew :app:assembleDebug)`
  - `(cd ios && pod install && xcodebuild -workspace BugseePlayground.xcworkspace -scheme BugseePlayground -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build | tail -5)`

  Expected:
  - `BUILD SUCCESSFUL`;
  - `** BUILD SUCCEEDED **`;
  - `libplayground_native.so` appears in `android/app/build/intermediates/merged_native_libs`.

  Then run `rm -rf ios android`. The workspace and scheme names come from `name` in `app.config.ts`; adjust if prebuild names them differently.

- [ ] **Step 7: Commit.** Message: `Playground: local native module for crashes, hangs, logs, requests, secure field`.

---

### Task 3: Token, saved config, launch options

**Files:**
- Create: `src/session/token.ts`, `src/session/config.ts`, `src/session/launch.ts`, `src/options/common.ts`, `src/options/advanced.ts`
- Test: `__tests__/token.test.ts`, `__tests__/config.test.ts`, `__tests__/launch.test.ts`

**Interfaces:**
- Produces:
  - `isAppToken(s: string): boolean`
  - `parseQrPayload(raw: string): { ok: true; token: string } | { ok: false; error: 'Not a Bugsee app token' }`
  - `tokenPrefix(t: string): string`
- Produces:
  - `interface SavedConfig { version: 1; token: string; endpoint: string; common: CommonOptions; advanced: Record<string, string>; autoLaunch: boolean; everLaunched: boolean }`
  - `DEFAULT_CONFIG: SavedConfig`
  - `loadConfig(): Promise<SavedConfig>`
  - `saveConfig(c: SavedConfig): Promise<void>`
  - `CONFIG_KEY = 'playground.config.v1'`
- Produces:
  - `interface CommonOptions { video: boolean; network: boolean; logs: boolean; logLevel: LogLevel; breadcrumbs: boolean; crash: boolean; hang: boolean; duration?: number; maxDataSize?: number; wifiOnly: boolean }`
  - `DEFAULT_COMMON`
  - `applyCommon(o: BugseeLaunchOptions, c: CommonOptions): void`
- Produces:
  - `ADVANCED_KEYS: readonly string[]` (shared plus this platform, sorted, without keys already in Common)
  - `parseOptionValue(s: string): boolean | number | string`
- Produces:
  - `buildLaunchOptions(c: SavedConfig, platform: 'ios' | 'android'): Record<string, unknown>`
  - `launchWith(c: SavedConfig): Promise<boolean>`

- [ ] **Step 1: Write the failing tests.**

  `__tests__/token.test.ts`:

```ts
import { isAppToken, parseQrPayload, tokenPrefix } from '../src/session/token';
const T = '1A2B3C4D-0000-4000-8000-000000000001';
test.each([
  [`BGSAPT:${T}`, true], [`  BGSAPT:${T}\n`, true], [`BGSAPT:${T.toLowerCase()}`, true],
  [T, false], [`bgsapt:${T}`, false], [`BGSAPT:${T}x`, false], [`https://x/?BGSAPT:${T}`, false], ['', false],
])('parseQrPayload(%j) ok=%s', (raw, ok) => {
  const r = parseQrPayload(raw);
  expect(r.ok).toBe(ok);
  if (r.ok) expect(r.token).toBe(T.toLowerCase());
  else expect(r.error).toBe('Not a Bugsee app token');
});
test('isAppToken and tokenPrefix', () => {
  expect(isAppToken(` ${T} `)).toBe(true);
  expect(isAppToken('nope')).toBe(false);
  expect(tokenPrefix(T)).toBe('1a2b3c4d');
});
```

  `__tests__/config.test.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONFIG_KEY, DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/session/config';
beforeEach(() => AsyncStorage.clear());
test('round-trips', async () => {
  const c = { ...DEFAULT_CONFIG, token: 'x', autoLaunch: true };
  await saveConfig(c);
  expect(await loadConfig()).toEqual(c);
});
test.each([['not json'], ['{"version":0,"token":"x"}'], ['null'], ['[]'], ['{"version":1,"token":5}']])(
  'falls back to defaults for %j', async (stored) => {
    await AsyncStorage.setItem(CONFIG_KEY, stored);
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });
test('fills fields missing from an older v1 save', async () => {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify({ version: 1, token: 't' }));
  expect(await loadConfig()).toEqual({ ...DEFAULT_CONFIG, token: 't' });
});
```

  `__tests__/launch.test.ts`:

```ts
import { DEFAULT_CONFIG } from '../src/session/config';
import { buildLaunchOptions } from '../src/session/launch';
import { parseOptionValue, ADVANCED_KEYS } from '../src/options/advanced';
test('empty endpoint passes no endpoint key', () => {
  const o = buildLaunchOptions(DEFAULT_CONFIG, 'android');
  expect(Object.keys(o).some((k) => k.includes('ENDPOINT') || k === 'endpoint')).toBe(false);
});
test('endpoint maps per platform', () => {
  const c = { ...DEFAULT_CONFIG, endpoint: 'https://bugsee.example.com' };
  expect(buildLaunchOptions(c, 'ios').endpoint).toBe('https://bugsee.example.com/v2');
  expect(buildLaunchOptions(c, 'android')['com.bugsee.option.$$ENDPOINT']).toBe('https://bugsee.example.com');
});
test('common options map to SDK keys', () => {
  const c = { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common, video: false, maxDataSize: 50 } };
  const o = buildLaunchOptions(c, 'ios');
  expect(o['com.bugsee.option.capture.video']).toBe(false);
  expect(o['com.bugsee.option.config.max-data-size']).toBe(50);
});
test('advanced overrides are typed and win over common', () => {
  const c = { ...DEFAULT_CONFIG, advanced: { 'com.bugsee.option.capture.video': 'true', 'com.bugsee.option.config.notify-flush-delay': '3' } };
  const o = buildLaunchOptions(c, 'ios');
  expect(o['com.bugsee.option.capture.video']).toBe(true);
  expect(o['com.bugsee.option.config.notify-flush-delay']).toBe(3);
});
test('parseOptionValue', () => {
  expect([parseOptionValue('true'), parseOptionValue('false'), parseOptionValue('1.5'), parseOptionValue(' x ')]).toEqual([true, false, 1.5, 'x']);
});
test('ADVANCED_KEYS has the shared keys and is sorted', () => {
  expect(ADVANCED_KEYS).toContain('com.bugsee.option.detect.frustration');
  expect([...ADVANCED_KEYS].sort()).toEqual(ADVANCED_KEYS);
});
```

  In `jest.setup.ts`, add:

  ```ts
  jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
  ```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `yarn workspace bugsee-playground test token config launch`. Expected: FAIL, modules missing.

- [ ] **Step 3: Implement the modules.**

  `src/session/token.ts`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAppToken = (s: string): boolean => UUID.test(s.trim());
export const tokenPrefix = (t: string): string => t.trim().toLowerCase().slice(0, 8);
export function parseQrPayload(raw: string): { ok: true; token: string } | { ok: false; error: 'Not a Bugsee app token' } {
  const m = /^BGSAPT:(.+)$/.exec(raw.trim());
  return m && isAppToken(m[1]) ? { ok: true, token: m[1].toLowerCase() } : { ok: false, error: 'Not a Bugsee app token' };
}
```

  `src/options/common.ts`:

```ts
import { LogLevel } from '@bugsee/react-native';
import type { BugseeLaunchOptions } from '@bugsee/react-native';
export interface CommonOptions {
  video: boolean; network: boolean; logs: boolean; logLevel: LogLevel; breadcrumbs: boolean;
  crash: boolean; hang: boolean; duration?: number; maxDataSize?: number; wifiOnly: boolean;
}
export const DEFAULT_COMMON: CommonOptions = {
  video: true, network: true, logs: true, logLevel: LogLevel.Verbose, breadcrumbs: true, crash: true, hang: true, wifiOnly: false,
};
export const COMMON_KEYS = [
  'com.bugsee.option.capture.video', 'com.bugsee.option.capture.network', 'com.bugsee.option.capture.logs',
  'com.bugsee.option.capture.logs.level', 'com.bugsee.option.capture.breadcrumbs', 'com.bugsee.option.detect.crash',
  'com.bugsee.option.detect.hang', 'com.bugsee.option.config.duration', 'com.bugsee.option.config.max-data-size',
  'com.bugsee.option.config.wifi-only-upload',
] as const;
export function applyCommon(o: BugseeLaunchOptions, c: CommonOptions): void {
  o.captureVideo = c.video; o.captureNetwork = c.network; o.captureLogs = c.logs; o.captureLogsLevel = c.logLevel;
  o.captureBreadcrumbs = c.breadcrumbs; o.detectAndReportCrash = c.crash; o.detectAndReportHang = c.hang;
  o.duration = c.duration; o.maxDataSize = c.maxDataSize; o.wifiOnlyUpload = c.wifiOnly;
}
```

  `src/options/advanced.ts`:

```ts
import { Platform } from 'react-native';
import keys from '@bugsee/react-native/src/options/option-keys.json';
import { COMMON_KEYS } from './common';
const platformKeys = Platform.OS === 'ios' ? keys.ios : keys.android;
export const ADVANCED_KEYS: readonly string[] = [...new Set([...keys.shared, ...platformKeys])]
  .filter((k) => !(COMMON_KEYS as readonly string[]).includes(k))
  .sort();
export function parseOptionValue(s: string): boolean | number | string {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}
```

  `src/session/config.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_COMMON } from '../options/common';
import type { CommonOptions } from '../options/common';
export const CONFIG_KEY = 'playground.config.v1';
export interface SavedConfig {
  version: 1; token: string; endpoint: string; common: CommonOptions;
  advanced: Record<string, string>; autoLaunch: boolean; everLaunched: boolean;
}
export const DEFAULT_CONFIG: SavedConfig = {
  version: 1, token: '', endpoint: '', common: DEFAULT_COMMON, advanced: {}, autoLaunch: false, everLaunched: false,
};
export async function loadConfig(): Promise<SavedConfig> {
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(CONFIG_KEY)) ?? 'null');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || typeof raw.token !== 'string') {
      return DEFAULT_CONFIG;
    }
    return { ...DEFAULT_CONFIG, ...raw, common: { ...DEFAULT_COMMON, ...(raw.common ?? {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}
export async function saveConfig(c: SavedConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(c));
}
```

  `src/session/launch.ts`:

```ts
import { Platform } from 'react-native';
import Bugsee, { BugseeLaunchOptions, createDefaultLaunchOptions, endpointFor } from '@bugsee/react-native';
import { applyCommon } from '../options/common';
import { parseOptionValue } from '../options/advanced';
import type { SavedConfig } from './config';
export function buildLaunchOptions(c: SavedConfig, platform: 'ios' | 'android'): Record<string, unknown> {
  const o = createDefaultLaunchOptions(platform);
  applyCommon(o, c.common);
  for (const [k, v] of Object.entries(c.advanced)) o.setCustomOption(k, parseOptionValue(v));
  return { ...BugseeLaunchOptions.serialize(o), ...endpointFor(platform, c.endpoint) };
}
export function launchWith(c: SavedConfig): Promise<boolean> {
  return Bugsee.launch(c.token.trim(), buildLaunchOptions(c, Platform.OS as 'ios' | 'android'));
}
```

  These tests import the real `@bugsee/react-native`. Task 4 introduces a mock that keeps the real `BugseeLaunchOptions`, `createDefaultLaunchOptions` and `endpointFor`, so these keep passing.

- [ ] **Step 4: Run the tests.** Run: `yarn workspace bugsee-playground test token config launch`. Expected: PASS.

  If importing `@bugsee/react-native` fails under jest-expo because of `TurboModuleRegistry`, do Task 4 Step 1's mock now (`jest.setup.ts`) and keep the real option exports.

- [ ] **Step 5: Commit.** Message: `Playground: token parsing, saved config, launch-option building`.

---

### Task 4: UI kit, the Action model, known issues, test mocks

**Files:**
- Create: `src/ui/action.ts`, `src/ui/ActionButton.tsx`, `src/ui/ResultLog.tsx`, `src/ui/Section.tsx`, `src/ui/Toggle.tsx`, `src/ui/KnownIssue.tsx`, `src/ui/Banner.tsx`, `src/ui/Screen.tsx`, `src/ui/knownIssues.ts`, `test/bugseeMock.ts`, `test/feedbackMock.ts`, `test/nativeMock.ts`
- Modify: `jest.setup.ts`
- Test: `__tests__/ActionButton.test.tsx`, `__tests__/action.test.ts`

**Interfaces:**
- Produces:

  ```ts
  type Platformish = 'ios' | 'android';
  interface Action {
    id: string;
    label: string;
    call: string;
    expect: string;
    run: () => unknown;
    confirm?: string;
    platforms?: Platformish[];
    knownIssue?: KnownIssueId;
  }
  function callTarget(call: string): { object: 'Bugsee' | 'Feedback' | 'PlaygroundNative' | 'console' | 'global' | 'report'; member: string };
  ```

  The first token of `call` names the target:
  - `Bugsee.x(` → Bugsee/x;
  - `Bugsee.appearance.` → Bugsee/appearance;
  - `Feedback.x(` → Feedback/x;
  - `PlaygroundNative.x(` → PlaygroundNative/x;
  - `console.x(` → console/x;
  - `fetch(` / `XMLHttpRequest` / `WebSocket` → global/name;
  - `global <Name> …` → global/Name (used for an unhandled promise rejection: `global Promise rejection (no catch)`);
  - `report.x(` → report/x, for created-report operations.
- Produces:
  - `<Screen title banner?>` provides `ResultLogContext`;
  - `<Section title>`;
  - `<ActionButton action={a} />`;
  - `<Toggle label value onChange />`;
  - `<KnownIssue id />`;
  - `<NotLaunchedBanner />`;
  - `useLog(): (line: string) => void`.
- Produces: `KNOWN_ISSUES: Record<KnownIssueId, { url: string; title: string; platform: Platformish }>`, `type KnownIssueId`.
- Produces test mocks, installed globally in `jest.setup.ts`:
  - `@bugsee/react-native`: a `jest.fn` for every `Bugsee` method; real enums, `BugseeLaunchOptions`, `createDefaultLaunchOptions`, `endpointFor` and errors; `BugseeSecure` and `ErrorBoundary` as pass-through `View`s.
  - `@bugsee/react-native-feedback`: `showFeedbackUI`, `setGreeting` and `setListener` as `jest.fn`, and `appearance` as a plain object.
  - `../modules/playground-native`: `available: true`, `supportsNdk: true`, methods as `jest.fn`, `request` resolving `{ status: 200, body: '{}' }`.
  - `expo-camera`, `react-native-webview` and `expo-router`: stubs.

- [ ] **Step 1: Create the mocks.**
  - `test/bugseeMock.ts` re-exports the real module's non-default exports with `jest.requireActual('@bugsee/react-native')`. That requires mocking `@bugsee/react-native/src/NativeBugsee` first with a `jest.fn()` proxy: `new Proxy({}, { get: (t, p) => (t[p] ??= jest.fn(() => (p === 'launch' ? Promise.resolve(true) : undefined))) })`.
  - Its `default` is an object with `jest.fn` for every method in this list:

    ```
    launch relaunch stop setSecureRectangles startBlackout endBlackout isBlackout captureViewHierarchy
    onLifecycleEvent onStatusChange setReportHandler upload showReportDialog createReport log setNetworkFilter
    addNetworkEvent setLogFilter addBreadcrumb setBreadcrumbFilter event trace setAttribute getAttribute
    getAllAttributes clearAttribute clearAllAttributes setUserIdentifier getUserIdentifier clearUserIdentifier
    attach getStatus getLaunchOptions testNativeCrash testJsCrash logException logUnhandledException notify
    startTransaction startSpan getActiveSpan deleteCollectedDataOnDevice
    ```

  - Promise-returning methods resolve:
    - `launch`, `relaunch`, `stop`, `isBlackout` and `deleteCollectedDataOnDevice` resolve `true`;
    - `getStatus` resolves `2`;
    - `getLaunchOptions` and `getAllAttributes` resolve `{}`;
    - the others resolve `undefined`.
  - The two subscription methods return `{ remove: jest.fn() }`.
  - `startTransaction` and `startSpan` return a span object whose `startChildSpan` returns another, and whose `setName`, `setStatus`, `setAttribute` and `setDescription` return `this`; `finish` is a `jest.fn()`.
  - `createReport` resolves an object with the five created-report methods as `jest.fn` (`upload` resolves `true`).
  - `appearance` is a plain object.
  - `testJsCrash` is a `jest.fn()`; it does not throw.
  - `jest.setup.ts` mocks `@bugsee/react-native`, `@bugsee/react-native-feedback`, `<rootDir>/modules/playground-native`, `expo-camera` (with `CameraView` as a `View` and `useCameraPermissions` returning `[{ granted: true }, jest.fn()]`), `react-native-webview` (with `WebView` as a `View`), and `expo-router` (`useRouter` returning `{ push, replace, back }` jest fns, `Link` as `Text`, `Stack`/`Tabs` as pass-through with a `.Screen` that renders null, `Redirect` returning null).

- [ ] **Step 2: Write the failing tests.**

  `__tests__/action.test.ts`:

```ts
import { callTarget } from '../src/ui/action';
test.each([
  ['Bugsee.log("hi", LogLevel.Info)', 'Bugsee', 'log'],
  ['Bugsee.appearance.backgroundColor = "#222"', 'Bugsee', 'appearance'],
  ['Feedback.showFeedbackUI()', 'Feedback', 'showFeedbackUI'],
  ['PlaygroundNative.crash("segv")', 'PlaygroundNative', 'crash'],
  ['console.warn("x")', 'console', 'warn'],
  ['fetch("https://httpbin.org/get")', 'global', 'fetch'],
  ['new XMLHttpRequest()', 'global', 'XMLHttpRequest'],
  ['new WebSocket(ECHO)', 'global', 'WebSocket'],
  ['report.addDataAttachment(...)', 'report', 'addDataAttachment'],
  ['global Promise rejection (no catch)', 'global', 'Promise'],
])('%s → %s.%s', (call, object, member) => expect(callTarget(call)).toEqual({ object, member }));
test('unknown call shapes throw so a typo cannot pass the mapping test', () => {
  expect(() => callTarget('Bugse.log()')).toThrow();
});
```

  `__tests__/ActionButton.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ActionButton } from '../src/ui/ActionButton';
import { Screen } from '../src/ui/Screen';
const base = { id: 'a', label: 'Do it', call: 'Bugsee.log("x")', expect: 'A line in the log' };
test('shows label, call and Expect', () => {
  render(<Screen title="T"><ActionButton action={{ ...base, run: () => 1 }} /></Screen>);
  expect(screen.getByText('Do it')).toBeTruthy();
  expect(screen.getByText('Bugsee.log("x")')).toBeTruthy();
  expect(screen.getByText('Expect: A line in the log')).toBeTruthy();
});
test.each([
  ['returned value', () => 42, '→ 42'],
  ['resolved value', () => Promise.resolve({ a: 1 }), '→ {"a":1}'],
  ['sync throw', () => { throw Object.assign(new TypeError('bad'), { code: 'E_X' }); }, '✗ TypeError [E_X]: bad'],
  ['rejection', () => Promise.reject(new Error('nope')), '✗ Error: nope'],
])('logs a %s', async (_n, run, line) => {
  render(<Screen title="T"><ActionButton action={{ ...base, run }} /></Screen>);
  fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(screen.getByText(line, { exact: false })).toBeTruthy());
});
test('confirm asks first and runs only on OK', () => {
  const run = jest.fn();
  const spy = jest.spyOn(Alert, 'alert');
  render(<Screen title="T"><ActionButton action={{ ...base, run, confirm: 'Crash now?' }} /></Screen>);
  fireEvent.press(screen.getByText('Do it'));
  expect(run).not.toHaveBeenCalled();
  const buttons = spy.mock.calls[0][2]!;
  buttons.find((b) => b.text === 'Crash')!.onPress!();
  expect(run).toHaveBeenCalled();
});
test('hidden on other platforms', () => {
  render(<Screen title="T"><ActionButton action={{ ...base, run: () => 0, platforms: ['android'] }} /></Screen>);
  // jest-expo default platform is ios
  expect(screen.queryByText('Do it')).toBeNull();
});
```

- [ ] **Step 3: Run the tests to verify they fail.** Run: `yarn workspace bugsee-playground test action ActionButton`. Expected: FAIL.

- [ ] **Step 4: Implement the UI.**

  `src/ui/action.ts`:

```ts
import type { KnownIssueId } from './knownIssues';
export type Platformish = 'ios' | 'android';
export interface Action {
  id: string; label: string; call: string; expect: string; run: () => unknown;
  confirm?: string; platforms?: Platformish[]; knownIssue?: KnownIssueId;
}
export type CallObject = 'Bugsee' | 'Feedback' | 'PlaygroundNative' | 'console' | 'global' | 'report';
export function callTarget(call: string): { object: CallObject; member: string } {
  const g = /^(?:new |global )?(fetch|XMLHttpRequest|WebSocket|Promise)\b/.exec(call);
  if (g) return { object: 'global', member: g[1] };
  const m = /^(Bugsee|Feedback|PlaygroundNative|console|report)\.(\w+)/.exec(call);
  if (!m) throw new Error(`Action call has no known target: ${call}`);
  return { object: m[1] as CallObject, member: m[2] };
}
```

  `src/ui/ResultLog.tsx`:
  - `ResultLogContext = createContext<(line: string) => void>(() => {})`;
  - `useLog = () => useContext(ResultLogContext)`;
  - `ResultLog({ lines })` renders the last 50 lines, newest first, monospace, in a bordered box titled "Result log".

  `src/ui/Screen.tsx`:
  - holds `lines` state;
  - provides `add = (l) => setLines((p) => [`${new Date().toISOString().slice(11, 23)} ${l}`, ...p].slice(0, 50))`;
  - renders a `ScrollView` with `<NotLaunchedBanner />` (unless `banner={false}`), `children`, then `<ResultLog lines />`.

  `src/ui/ActionButton.tsx`:

```tsx
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Action } from './action';
import { KnownIssue } from './KnownIssue';
import { useLog } from './ResultLog';

export function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return `${e.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${e.message}`;
  }
  return describe(e);
}

export function ActionButton({ action }: { action: Action }) {
  const log = useLog();
  if (action.platforms && !action.platforms.includes(Platform.OS as 'ios' | 'android')) return null;
  const go = () => {
    log(`▶ ${action.label}`);
    try {
      const r = action.run();
      if (r instanceof Promise) r.then((v) => log(`→ ${describe(v)}`), (e) => log(`✗ ${describeError(e)}`));
      else log(`→ ${describe(r)}`);
    } catch (e) {
      log(`✗ ${describeError(e)}`);
    }
  };
  const press = () =>
    action.confirm
      ? Alert.alert(action.label, action.confirm, [{ text: 'Cancel', style: 'cancel' }, { text: 'Crash', style: 'destructive', onPress: go }])
      : go();
  return (
    <Pressable accessibilityRole="button" onPress={press} style={styles.box} testID={`action-${action.id}`}>
      <Text style={styles.label}>{action.label}</Text>
      <Text style={styles.call}>{action.call}</Text>
      <Text style={styles.expect}>{`Expect: ${action.expect}`}</Text>
      {action.knownIssue ? <KnownIssue id={action.knownIssue} /> : null}
    </Pressable>
  );
}
const styles = StyleSheet.create({
  box: { padding: 12, marginVertical: 4, borderRadius: 8, backgroundColor: '#f2f4f7' },
  label: { fontSize: 16, fontWeight: '600' },
  call: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginTop: 4 },
  expect: { fontSize: 12, color: '#475467', marginTop: 4 },
});
```

  `src/ui/knownIssues.ts`:

```ts
export const KNOWN_ISSUES = {
  'cocoa-196': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/196', title: 'capture.video=false still records', platform: 'ios' },
  'cocoa-195': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/195', title: 'deleteCollectedDataOnDevice does not delete', platform: 'ios' },
  'android-250': { url: 'https://github.com/bugsee/bugsee-android/issues/250', title: 'deleteCollectedDataOnDevice(false) also deletes the rolling capture', platform: 'android' },
  'cocoa-220': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/220', title: 'Report-handler edits on a recovered crash are lost', platform: 'ios' },
  'cocoa-224': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/224', title: 'A second createReport wipes the first', platform: 'ios' },
  'cocoa-226': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/226', title: 'logException includeVideo ignored', platform: 'ios' },
  'android-247': { url: 'https://github.com/bugsee/bugsee-android/issues/247', title: 'logException labels and includeVideo ignored', platform: 'android' },
  'android-248': { url: 'https://github.com/bugsee/bugsee-android/issues/248', title: 'Blackout before launch is a no-op', platform: 'android' },
  'cocoa-223': { url: 'https://github.com/bugsee/bugsee-cocoa/issues/223', title: 'upload() trigger shows as unknown', platform: 'ios' },
} as const satisfies Record<string, { url: string; title: string; platform: 'ios' | 'android' }>;
export type KnownIssueId = keyof typeof KNOWN_ISSUES;
```

  Before committing, check each title against the issue with `gh issue view <n> -R bugsee/<repo> --json title`, and correct any wording that differs in meaning. An action can carry only one `knownIssue`; where both platforms have one (for example deleteCollectedData), use two actions with `platforms` set.
  - `KnownIssue`: when `Platform.OS === issue.platform`, it renders "⚠ Known issue: <title>" as a link (`Linking.openURL`); otherwise it renders nothing.
  - `Banner.tsx` (`NotLaunchedBanner`): reads `useSession().status`. Until Task 5 adds the provider, it calls `useContext(SessionContext)` and renders nothing when the context is undefined. When the status is not `Status.Launched`, it renders a yellow bar: "Bugsee not launched. Calls still run and show what they return."
  - `Section`: a title, then its children.
  - `Toggle`: a label plus a `Switch`.

- [ ] **Step 5: Run the tests.** Run: `yarn workspace bugsee-playground test`. Expected: all PASS.

- [ ] **Step 6: Commit.** Message: `Playground: Action model, ActionButton, result log, known issues, test mocks`.

---

### Task 5: Session provider, root layout, Setup and Scan screens

**Files:**
- Create: `src/session/SessionProvider.tsx`, `src/screens/SetupScreen.tsx`, `src/screens/ScanScreen.tsx`, `app/setup.tsx`, `app/scan.tsx`
- Modify: `app/_layout.tsx` (replace), delete `app/index.tsx`
- Test: `__tests__/session.test.tsx`, `__tests__/setup.test.tsx`

**Interfaces:**
- Consumes:
  - `loadConfig`, `saveConfig`, `SavedConfig`, `DEFAULT_CONFIG` (Task 3);
  - `launchWith`, `buildLaunchOptions` (Task 3);
  - `parseQrPayload`, `isAppToken`, `tokenPrefix` (Task 3);
  - `ADVANCED_KEYS`, `DEFAULT_COMMON` (Task 3).
- Produces: `SessionContext` and `useSession()`, returning:

  ```ts
  {
    ready: boolean;
    config: SavedConfig;
    setConfig(c: SavedConfig): Promise<void>;
    status: Status;
    lifecycle: { at: string; event: string }[];
    launch(): Promise<boolean>;
    relaunch(): Promise<boolean>;
    stop(): Promise<boolean>;
    pendingToken: string | null;
    setPendingToken(t: string | null): void;
  }
  ```

  The ring buffer holds 100 entries.

- [ ] **Step 1: Write the failing tests.**

  `__tests__/session.test.tsx`:
  - Render `<SessionProvider><Probe/></SessionProvider>`, where `Probe` shows `ready`, `status` and `lifecycle.length`.
  - With saved `{ autoLaunch: true, token: VALID, everLaunched: true }`, assert:
    - `Bugsee.launch` is called once with `VALID` before `ready` turns true;
    - `onLifecycleEvent` is subscribed once;
    - an emitted event appends to `lifecycle` (capture the mock's listener argument, call it with `'BeforeReportShown'`);
    - `getStatus` is polled once after launch.
  - With `autoLaunch: false`, `launch` is not called.
  - With `autoLaunch: true` and an invalid token, `launch` is not called and `ready` turns true.

  `__tests__/setup.test.tsx`:
  - Typing a non-UUID token disables the Launch button and shows "Must be a UUID".
  - A valid token plus Launch calls `saveConfig` with `everLaunched: true`, calls `Bugsee.launch`, and calls `router.replace('/(tabs)')`.
  - With `Constants.expoConfig.extra.bugseeTokenPrefix.ios = '1a2b3c4d'` (mock `expo-constants`) and a typed token `9f8e…`, the text "Symbols were uploaded for app 1a2b3c4d…" appears.
  - The endpoint field is empty by default and its placeholder is "Leave empty for Bugsee cloud".
  - An endpoint of `http://x` shows "Must be an https URL" and disables Launch.
  - `pendingToken` set by the scanner fills the token field.

  `ScanScreen`, tested in the same file:
  - Calling the `onBarcodeScanned` prop with `{ data: 'nope' }` shows "Not a Bugsee app token".
  - Calling it twice quickly with a valid payload calls `router.back()` once.

- [ ] **Step 2: Run the tests to verify they fail.** Run: `yarn workspace bugsee-playground test session setup`.

- [ ] **Step 3: Implement.**

  `SessionProvider.tsx`:
  - On mount:
    1. `loadConfig()`.
    2. Subscribe `Bugsee.onLifecycleEvent((e) => push({ at: isoTime, event: String(e) }))` and `Bugsee.onStatusChange(setStatus)`.
    3. If `config.autoLaunch && isAppToken(config.token)`, `await launchWith(config)` (catch and push `launch failed: <msg>` into `lifecycle`).
    4. `setStatus(await Bugsee.getStatus())`.
    5. `setReady(true)`.
  - Unsubscribe on unmount.
  - `launch()`: saves `{ ...config, everLaunched: true }` and calls `launchWith`.
  - `relaunch()`: calls `Bugsee.relaunch(buildLaunchOptions(config, Platform.OS))`.
  - `stop()`: `Bugsee.stop()`.
  - After each of the three, refresh `status` from `getStatus()`.

  `app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router';
import { SessionProvider } from '../src/session/SessionProvider';
export default function Root() {
  return (
    <SessionProvider>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="setup" options={{ title: 'Setup' }} />
        <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan app token' }} />
        <Stack.Screen name="shop" options={{ headerShown: false }} />
      </Stack>
    </SessionProvider>
  );
}
```

  `app/(tabs)/_layout.tsx` (created in Task 6) redirects with `<Redirect href="/setup" />` when `ready && !config.everLaunched`. Until `ready`, it renders an `ActivityIndicator`.

  `SetupScreen.tsx` sections:
  - **App token for {iOS|Android}.**
    - A `TextInput` with `autoCapitalize="none"`.
    - The validation message "Must be a UUID".
    - A "Scan QR" button that calls `router.push('/scan')`.
    - The mismatch warning, when `extra.bugseeTokenPrefix[Platform.OS]` exists and differs from `tokenPrefix(token)`:

      `Symbols were uploaded for app ${prefix}…. You're launching with ${tokenPrefix(token).slice(0, 4)}…, so crashes won't be symbolicated.`

    - When the field is empty and a build-time token prefix exists, the field stays empty: only the prefix is known. Show the hint "Build-time token configured: <prefix>…; paste the full token". The spec's "pre-fill" can only be partial, because `extra` deliberately holds the prefix only.
  - **Endpoint.**
    - An empty-by-default `TextInput`, placeholder "Leave empty for Bugsee cloud".
    - Valid when empty, or when `/^https:\/\/[^\s/?#@]+(:\d+)?(\/[^\s?#]*)?$/` matches and the value does not end in `/v2`.
    - The error is "Must be an https URL (no /v2)".
  - **Common options.**
    - A `Toggle` for each boolean in `CommonOptions`.
    - `logLevel`: a row of five chips (Error … Verbose).
    - `duration` and `maxDataSize`: numeric `TextInput`s, where empty means unset.
  - **Advanced options.** Collapsed by default. A filter `TextInput`, then each `ADVANCED_KEYS` key as a row with a value `TextInput` (empty means unset). Show the key in monospace, with the `com.bugsee.option.` prefix dropped for display.
  - **Auto-launch.** A Toggle, "Launch on next app start".
  - **Launch.** Disabled unless the token and endpoint are valid. It runs `setConfig({ ...edited, everLaunched: true })`, then `launch()`, then `router.replace('/(tabs)')`.

  `ScanScreen.tsx`:
  - `useCameraPermissions()`. If not granted, show a "Grant camera access" button.
  - Otherwise render `<CameraView style={{flex:1}} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />`.
  - `onScan` uses a `handled = useRef(false)` guard. On `ok`, it sets `handled`, calls `setPendingToken(token)` and `router.back()`. Otherwise it shows the error text for 2 s.
  - Below the camera: "Get this code from your app's settings on the Bugsee dashboard."

  Route files: `app/setup.tsx` is `export { default } from '../src/screens/SetupScreen';`, and `app/scan.tsx` likewise.

- [ ] **Step 4: Run the tests.** Run: `yarn workspace bugsee-playground test`. Expected: PASS.

- [ ] **Step 5: Commit.** Message: `Playground: session provider, Setup (paste, scan, options) and QR scanner`.

---

### Task 6: Tabs layout and Home screen

**Files:**
- Create: `app/(tabs)/_layout.tsx`, `app/(tabs)/index.tsx`, `src/screens/HomeScreen.tsx`
- Test: `__tests__/home.test.tsx`

**Interfaces:**
- Consumes: `useSession()` (Task 5), `Screen`, `Section`, `ActionButton`, `Toggle` (Task 4).
- Produces: `export const homeActions: Action[]` from `HomeScreen.tsx`.

- [ ] **Step 1: Write the failing test.**
  - Home renders the status name (`Launched` for mock status 2).
  - It renders the lifecycle entries.
  - It renders `getLaunchOptions` output as pretty JSON after pressing "Refresh launch options".
  - Pressing "Try the demo shop" calls `router.push('/shop/sign-in')`.
  - Toggling auto-launch calls `setConfig` with `autoLaunch` flipped.

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test home`.

- [ ] **Step 3: Implement.**

  `app/(tabs)/_layout.tsx`:
  - It does the redirect described in Task 5.
  - It declares `<Tabs>` with screens `index` (Home), `capture`, `privacy`, `errors`, `reports`, `data` and `perf`, with titles matching.
  - The header-right "Setup" button calls `router.push('/setup')`.

  `HomeScreen.tsx`:
  - Sections:
    - **Status:** the status name, then the lifecycle log, newest first.
    - **Session:** the actions below.
    - **Launch options:** a "Refresh launch options" button, then a `<Text>` with `JSON.stringify(opts, null, 2)`.
    - **Auto-launch:** a Toggle.
    - **Demo shop:** a card that pushes `/shop/sign-in`.
  - `homeActions` (module level), where `launchFromSaved` reads `loadConfig()` and calls `launchWith`, and Launch / Relaunch / Stop in the screen use the session functions instead (these entries document the calls):

```ts
export const homeActions: Action[] = [
  { id: 'launch', label: 'Launch', call: 'Bugsee.launch(token, options)', expect: 'Status goes Launching → Launched; resolves true', run: async () => launchWith(await loadConfig()) },
  { id: 'relaunch', label: 'Relaunch with saved options', call: 'Bugsee.relaunch(options)', expect: 'Lifecycle shows a stop and a new launch; new options in effect', run: async () => Bugsee.relaunch(buildLaunchOptions(await loadConfig(), Platform.OS as 'ios' | 'android')) },
  { id: 'stop', label: 'Stop', call: 'Bugsee.stop()', expect: 'Status → Stopped; resolves true', run: () => Bugsee.stop() },
  { id: 'status', label: 'Get status', call: 'Bugsee.getStatus()', expect: '2 (Launched) after launch, 0 (Stopped) after stop', run: () => Bugsee.getStatus() },
  { id: 'launch-options', label: 'Get launch options', call: 'Bugsee.getLaunchOptions()', expect: 'The options the SDK reports in effect', run: () => Bugsee.getLaunchOptions() },
  { id: 'attach', label: 'Attach to a native auto-launch', call: 'Bugsee.attach()', expect: 'Resolves; no second session. Only meaningful when the native side auto-launched (config plugin autoLaunch); the playground does not', run: () => Bugsee.attach() },
  { id: 'delete-true-ios', label: 'Delete collected data (incl. intermediate)', call: 'Bugsee.deleteCollectedDataOnDevice(true)', expect: 'false while launched; true after Stop, and no old report is sent at the next launch', run: () => Bugsee.deleteCollectedDataOnDevice(true), platforms: ['ios'], knownIssue: 'cocoa-195' },
  { id: 'delete-true-android', label: 'Delete collected data (incl. intermediate)', call: 'Bugsee.deleteCollectedDataOnDevice(true)', expect: 'false while launched; true after Stop', run: () => Bugsee.deleteCollectedDataOnDevice(true), platforms: ['android'] },
  { id: 'delete-false-ios', label: 'Delete processed data only', call: 'Bugsee.deleteCollectedDataOnDevice(false)', expect: 'false while launched; true after Stop; intermediate capture kept', run: () => Bugsee.deleteCollectedDataOnDevice(false), platforms: ['ios'], knownIssue: 'cocoa-195' },
  { id: 'delete-false-android', label: 'Delete processed data only', call: 'Bugsee.deleteCollectedDataOnDevice(false)', expect: 'false while launched; true after Stop; intermediate capture kept', run: () => Bugsee.deleteCollectedDataOnDevice(false), platforms: ['android'], knownIssue: 'android-250' },
];
```

  `app/(tabs)/index.tsx` is `export { default } from '../../src/screens/HomeScreen';`.

- [ ] **Step 4: Run the test.** Run: `yarn workspace bugsee-playground test home`. Expected: PASS.

- [ ] **Step 5: Commit.** Message: `Playground: tabs and Home (status, lifecycle, session control, data deletion)`.

---

### Task 7: Demo API and Capture tab (logging, network, WebView)

**Files:**
- Create: `src/demoApi.ts`, `src/demoMock.ts`, `src/screens/CaptureScreen.tsx`, `app/(tabs)/capture.tsx`
- Test: `__tests__/demoApi.test.ts`

**Interfaces:**
- Produces: `DEMO` constants:

  ```ts
  ECHO = 'https://httpbin.org/anything'
  STATUS = (code: number) => `https://httpbin.org/status/${code}`
  DELAY = (s: number) => `https://httpbin.org/delay/${s}`
  BYTES = (n: number) => `https://httpbin.org/bytes/${n}`
  DNS_FAIL = 'https://does-not-exist.invalid/'
  WS_ECHO = 'wss://echo.websocket.org'
  PRODUCTS = 'https://dummyjson.com/products?limit=12&select=id,title,price,thumbnail,description'
  ```

- Produces:
  - `interface Product { id: number; title: string; price: number; thumbnail?: string; description: string }`
  - `fetchProducts(opts?: { flaky?: boolean; attempt?: number }): Promise<{ products: Product[]; source: 'network' | 'mock' }>`, which throws `DemoHttpError` (`status: 500`) when flaky and `attempt % 3 === 2`
  - `postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown }>`
- Produces: `export const captureActions: Action[]`.

- [ ] **Step 1: Write the failing test** `__tests__/demoApi.test.ts`:

```ts
import { fetchProducts, DEMO, DemoHttpError } from '../src/demoApi';
afterEach(() => jest.restoreAllMocks());
test('uses the network when it answers', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ products: [{ id: 1, title: 'A', price: 1, description: 'd' }] }) }) as never;
  expect(await fetchProducts()).toEqual({ products: [{ id: 1, title: 'A', price: 1, description: 'd' }], source: 'network' });
  expect(global.fetch).toHaveBeenCalledWith(DEMO.PRODUCTS, expect.anything());
});
test.each([['rejects', () => Promise.reject(new TypeError('Network request failed'))], ['429', () => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })]])(
  'falls back to the bundled mock when the request %s, but still makes it', async (_n, impl) => {
    global.fetch = jest.fn(impl) as never;
    const r = await fetchProducts();
    expect(r.source).toBe('mock');
    expect(r.products.length).toBeGreaterThanOrEqual(3);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
test('flaky mode fails every third load with a 500 after the request', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ products: [] }) }) as never;
  await expect(fetchProducts({ flaky: true, attempt: 2 })).rejects.toBeInstanceOf(DemoHttpError);
  await expect(fetchProducts({ flaky: true, attempt: 1 })).resolves.toBeTruthy();
});
```

  In flaky mode the real request goes to `STATUS(500)`, so capture records a genuine 500. With the mocked fetch in the test, the error is raised from the attempt count.

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test demoApi`.

- [ ] **Step 3: Implement `demoApi.ts` and `demoMock.ts`.**
  - `demoMock.ts` exports `MOCK_PRODUCTS`: four products, with no `thumbnail`.
  - `fetchProducts`:
    - `url = flaky && attempt % 3 === 2 ? DEMO.STATUS(500) : DEMO.PRODUCTS`.
    - `try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (url !== DEMO.PRODUCTS) throw new DemoHttpError(500); if (!r.ok) return mock; return { products: (await r.json()).products, source: 'network' } } catch (e) { if (e instanceof DemoHttpError) throw e; return { products: MOCK_PRODUCTS, source: 'mock' } }`.
  - `DemoHttpError extends Error`, with `status`.

- [ ] **Step 4: Implement `CaptureScreen.tsx`.** Sections and `captureActions`, each run written inline:
  - **Logging:**
    - `Bugsee.log(…)` at each `LogLevel` (Error, Warning, Info, Debug, Verbose). Five actions, ids `log-error` to `log-verbose`. Expect: "A line at <level> in the report's console, source Custom".
    - `console.log`, `console.info`, `console.warn` and `console.error`. Expect: "Printed to Metro and captured in the report console (if capture.logs is on)".
    - `PlaygroundNative.log('info', 'native line')` (`native-log`). Expect: "An os_log/NSLog line (iOS) or a Logcat line tagged Playground (Android) in the report console".
    - Burst (`log-burst`): call `'Bugsee.log(…) ×500'` runs a loop of 500 `Bugsee.log(\`burst ${i}\`)`. Expect: "500 numbered lines, in order, none missing".
    - `setLogFilter`, with three presets:
      - drop lines containing "secret": `Bugsee.setLogFilter((l) => (l.includes('secret') ? null : l))`, Expect "A following 'secret' line is absent from the report";
      - rewrite (`(l) => l.replace(/\d{4}-\d{4}-\d{4}-\d{4}/g, '****')`), Expect "Card numbers appear as ****";
      - off: `Bugsee.setLogFilter(null)`.
    - Plus a plain action `console.log('secret token=abc 4111-1111-1111-1111')` for testing the filters.
  - **Network** (JS):
    - `fetch` GET `DEMO.ECHO`.
    - POST JSON `{ hello: 'world' }`.
    - POST form, built by hand: `URLSearchParams` (`a=1&b=two`) with `Content-Type: application/x-www-form-urlencoded`.
    - POST binary: a `Uint8Array` of 256 bytes.
    - GET large: `BYTES(200000)`.
    - POST with no Content-Type: `fetch(ECHO, { method: 'POST', body: 'raw text' })`, with the header deleted.
    - 404 (`STATUS(404)`) and 503 (`STATUS(503)`).
    - Timeout: `AbortController` with a 2 s timeout against `DELAY(10)`.
    - DNS failure (`DNS_FAIL`).
    - `new XMLHttpRequest()` GET and POST.
    - `new WebSocket(DEMO.WS_ECHO)`: open, send "ping", close on the first message.
  - **Network** (native): `PlaygroundNative.request('GET', ECHO)` and `PlaygroundNative.request('POST', ECHO, '{"from":"native"}')`. Expect: "URLSession (iOS) / OkHttp (Android) request in network capture".
  - **Network filters and events:**
    - `Bugsee.setNetworkFilter` presets:
      - redact the `Authorization` header: `(e) => ({ ...e, headers: e.headers ? { ...e.headers, Authorization: '***' } : e.headers })`, plus an action that sends `fetch(ECHO, { headers: { Authorization: 'Bearer demo' } })`;
      - drop httpbin `/status/` URLs: `(e) => (e.url?.includes('/status/') ? null : e)`;
      - off (`null`).
    - `Bugsee.addNetworkEvent({ url: 'https://example.com/manual', method: 'GET', responseCode: 200, body: '{"manual":true}', headers: { 'X-Demo': '1' } })`. Expect: "A manual network event with responseCode 200 in the report".
  - **WebView.** Not an action: an inline `react-native-webview` `WebView` with `source={{ html: WEBVIEW_HTML }}`, where the page script runs:

    ```js
    console.log('webview log'); fetch('https://httpbin.org/get?from=webview'); setTimeout(() => { throw new Error('webview error'); }, 500);
    ```

    A Section note: "Expect: the WebView console line, its fetch, and the JS error in the report (with capture.webview.advanced on)."

  `app/(tabs)/capture.tsx` is the one-line re-export.

  Each Expect line names what to look for in the report. Write each one concretely, as above.

- [ ] **Step 5: Run the tests.** Run: `yarn workspace bugsee-playground test`. Expected: PASS.

- [ ] **Step 6: Commit.** Message: `Playground: Capture tab (logging, network, WebView) and demo API with offline mock`.

---

### Task 8: Privacy tab

**Files:**
- Create: `src/screens/PrivacyScreen.tsx`, `app/(tabs)/privacy.tsx`
- Test: covered by Task 14 (render and mapping); there is no new unit.

**Interfaces:**
- Produces: `export const privacyActions: Action[]`.

- [ ] **Step 1: Implement.** Sections:
  - **Blackout.** Actions:
    - `Bugsee.startBlackout()`, Expect "Video frames black and touches not recorded until endBlackout";
    - `Bugsee.endBlackout()`;
    - `Bugsee.isBlackout()`, Expect "true between start and end".
  - **Blackout before launch.** An action whose call is `'Bugsee.startBlackout() before launch'`:
    - run: `await Bugsee.stop(); Bugsee.startBlackout(); return launchWith(await loadConfig())`;
    - Expect: "The first seconds of video are black";
    - `platforms` both, `knownIssue: 'android-248'`.
  - **BugseeSecure.**
    - A `<BugseeSecure>` around a coloured `View` with the text "This box is redacted".
    - A `Toggle` that flips its `enabled` prop.
    - Section note: "Expect: a black rectangle over the box in the video while enabled".
  - **Secure TextInput.**
    - A password `TextInput` (`secureTextEntry`).
    - A card `TextInput` (`keyboardType="number-pad"`, wrapped in `BugseeSecure`).
    - A plain `TextInput`.
    - Note: "Expect: password and card hidden in video; plain field visible".
  - **Manual rectangles.**
    - Action `Bugsee.setSecureRectangles([{ x: 20, y: 200, width: 200, height: 80 }])`, which also sets component state to draw a red-bordered overlay `View` at those window coordinates (`position: 'absolute'` in a root-level overlay).
    - Action `Bugsee.setSecureRectangles([])` to clear it.
    - Expect: "The outlined area is black in the video".
  - **Native secure field.** `<NativeSecureField />`. Note: "Expect: the native password field is hidden, and the plain one beside it is visible".

  `app/(tabs)/privacy.tsx` is the one-line re-export.

- [ ] **Step 2: Typecheck.** Run: `yarn workspace bugsee-playground typecheck && yarn workspace bugsee-playground test`.

- [ ] **Step 3: Commit.** Message: `Playground: Privacy tab`.

---

### Task 9: Errors tab

**Files:**
- Create: `src/screens/ErrorsScreen.tsx`, `app/(tabs)/errors.tsx`

**Interfaces:**
- Produces: `export const errorsActions: Action[]`.
- Produces: `afterTap(fn: () => void): void`, which runs `fn` after 300 ms (`setTimeout`). It lives in `src/ui/afterTap.ts` and is used by Task 13.

- [ ] **Step 1: Implement.**
  - **Handled.**
    - `Bugsee.logException(new Error('Playground handled error'))`.
    - With a string: `Bugsee.logException('a plain string')`.
    - With labels: `Bugsee.logException(new Error('labelled'), { labels: ['playground', 'handled'] })`. `knownIssue: 'android-247'`; Expect "Labels playground, handled on the error".
    - With domain: `{ domain: 'com.bugsee.playground' }`.
    - With video: `{ includeVideo: true }`. Two actions, one per platform, with `knownIssue` `'cocoa-226'` and `'android-247'` respectively.
  - **Unhandled.**
    - `Bugsee.logUnhandledException(new Error('Playground unhandled via API'))`. Expect: "A crash-type report (iOS: at the next launch)".
    - Unhandled promise rejection: `{ id: 'unhandled-rejection', label: 'Unhandled promise rejection', call: 'global Promise rejection (no catch)', … }` (Task 4's `callTarget` maps it to global/Promise).
    - run: `void Promise.reject(new Error('Playground unhandled rejection'))`. Expect: "A crash report from the rejection tracker".
  - **ErrorBoundary.**
    - A `<ErrorBoundary fallback={({ error, resetError }) => …} options={{ labels: ['boundary'] }}>` around a child that throws during render when a state flag is set.
    - A plain button "Throw inside ErrorBoundary" sets the flag. Expect: "The fallback renders; a handled error with label boundary is reported".
    - (`ErrorBoundaryFallbackProps`: check the field names in `packages/react-native/src/exceptions/ErrorBoundary.tsx` and use them exactly.)
  - **Crashes.** Each crash action has `confirm: 'The app will crash. Reopen it to send the report.'`, and its run wraps the call in `afterTap`:
    - `Bugsee.testJsCrash()` (`js-crash`). Its run is `afterTap(() => Bugsee.testJsCrash())`, so the throw happens outside React's handler.
    - `Bugsee.testNativeCrash()`.
    - `PlaygroundNative.crash('segv')`, `('abort')`, `('exception')` and `('backgroundThread')`. On Android, the labels for segv and abort say "(JNI)".
    - `PlaygroundNative.crashNdk('segv')` and `('abort')`, with `platforms: ['android']`.
    - Expect: "Reopen the app: a crash report with a symbolicated <JS|native|NDK> stack (Release build with symbols uploaded)".
  - **Hang.** `PlaygroundNative.hangMainThread(6000)`. Expect: "UI frozen 6 s; a hang report (detect.hang on)".

  `app/(tabs)/errors.tsx` is the one-line re-export.

- [ ] **Step 2: Run tests and typecheck.** Run: `yarn workspace bugsee-playground test action && yarn workspace bugsee-playground typecheck`.

- [ ] **Step 3: Commit.** Message: `Playground: Errors tab (handled, unhandled, boundary, crashes, hang)`.

---

### Task 10: Reports tab (reports, handler, attachments, notify, appearance, feedback)

**Files:**
- Create: `src/screens/ReportsScreen.tsx`, `src/reportHandlers.ts`, `app/(tabs)/reports.tsx`
- Test: `__tests__/reportHandlers.test.ts`

**Interfaces:**
- Produces: `REPORT_HANDLER_PRESETS: Record<'labels' | 'attachFile' | 'drop', BugseeReportHandler>`, and `export const reportsActions: Action[]`.

- [ ] **Step 1: Write the failing test** `__tests__/reportHandlers.test.ts`:

```ts
import { REPORT_HANDLER_PRESETS } from '../src/reportHandlers';
const fakeReport = () => ({
  id: 'r', type: 'bug', setLabels: jest.fn(), getLabels: jest.fn().mockResolvedValue(['a']),
  getAttachmentNames: jest.fn().mockResolvedValue([]), addDataAttachment: jest.fn(), update: jest.fn(),
});
test('labels preset is idempotent (setLabels, not append)', async () => {
  const r = fakeReport();
  await REPORT_HANDLER_PRESETS.labels.onAfterReportCreated!(r as never);
  await REPORT_HANDLER_PRESETS.labels.onAfterReportCreated!(r as never);
  expect(r.setLabels).toHaveBeenLastCalledWith(['a', 'from-handler']);
});
test('attachFile preset checks names before adding', async () => {
  const r = fakeReport();
  r.getAttachmentNames.mockResolvedValueOnce([]).mockResolvedValueOnce(['handler.txt']);
  await REPORT_HANDLER_PRESETS.attachFile.onAfterReportCreated!(r as never);
  await REPORT_HANDLER_PRESETS.attachFile.onAfterReportCreated!(r as never);
  expect(r.addDataAttachment).toHaveBeenCalledTimes(1);
});
```

  The labels preset reads labels, then `setLabels([...new Set([...labels, 'from-handler'])])`. The `drop` preset clears fields: `update({ summary: '[dropped by handler]', clearAttributes: true })`. There is no SDK "drop" API in 7.x. Ruling: the spec's "drop the report" preset becomes "redact the report"; the label says "Redact (no drop API in 7.x)".

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test reportHandlers`.

- [ ] **Step 3: Implement `reportHandlers.ts`**, so the test passes. Then run it again: PASS.

- [ ] **Step 4: Implement `ReportsScreen.tsx`.**
  - **Report.**
    - `Bugsee.showReportDialog('Playground report', 'Prefilled description', IssueSeverity.High, ['playground'])`. Expect: "The dialog opens pre-filled; Send creates one report".
    - `Bugsee.showReportDialog()` (empty).
    - `Bugsee.upload('Playground upload', 'Sent with no UI', IssueSeverity.Medium, ['playground', 'upload'])`. `knownIssue: 'cocoa-223'`; Expect: "A bug report appears on the dashboard with these fields".
    - `Bugsee.captureViewHierarchy()`. Expect: "The next report carries a view hierarchy (iOS: the RN tree)".
  - **Created report.** These actions keep `let created: BugseeCreatedReport | null` at module level:
    - `Bugsee.createReport()` stores it. Expect: "Resolves an object; a second create before upload rejects with E_REPORT_CREATE_BUSY". `knownIssue: 'cocoa-224'`.
    - `report.update({ summary: 'Created report', labels: ['created'], attributes: { step: 1 } })`.
    - `report.addDataAttachment(base64('hello from the playground'), { name: 'note.txt', mimeType: 'text/plain' })`, with `base64` = `globalThis.btoa`.
    - `report.addDataAttachment(<1x1 PNG base64 constant>, { name: 'pixel.png', mimeType: 'image/png' })`.
    - `report.addDataAttachment(<4 MiB of 'A' base64>, { name: 'big.bin' })`. Expect: "iOS rejects with E_REPORT_ATTACHMENT_REJECTED (3 MiB cap); Android accepts".
    - `report.read()`.
    - `report.upload()`, which clears `created`.
    - When `created` is null, the `report.*` runs throw `new Error('Call Bugsee.createReport() first')`.
  - **Report handler.**
    - `Bugsee.setReportHandler(REPORT_HANDLER_PRESETS.labels)`. Expect: "The next report carries label from-handler, including a crash recovered at the next launch". `knownIssue: 'cocoa-220'`.
    - `.attachFile`, Expect "handler.txt attached".
    - `.drop` (redact), Expect "Summary [dropped by handler], attributes cleared".
    - `Bugsee.setReportHandler(null)`.
  - **Notify.**
    - `Bugsee.notify('Playground notification', 'Body text', IssueSeverity.Medium, { source: 'playground' })`. Expect: "Delivered to the app's messaging integrations; not a bug report".
    - Urgent: `…, true` as the fifth argument.
  - **Report UI colours.**
    - `Bugsee.appearance.backgroundColor = '#1d2939'` with `textColor '#ffffff'`, as one action whose call string is the first assignment.
    - "Reset colours" sets `'#ffffff'` / `'#101828'`.
    - Expect: "The report dialog uses these colours".
  - **Feedback** (`import * as Feedback from '@bugsee/react-native-feedback'`):
    - `Feedback.showFeedbackUI()`. Expect: "The feedback chat opens (first time: the e-mail screen)".
    - `Feedback.setGreeting('Hi from the playground!')` and `Feedback.setGreeting(null)`.
    - `Feedback.setListener({ onNewMessagesReceived: (m) => log(…), onNewMessageSent: (m) => log(…) })`. The listener logs into the screen log: `useLog` is captured in a module-level `let screenLog: (l: string) => void = () => {}` that the screen sets in an effect.
    - `Feedback.setListener(null)`.
    - `Feedback.appearance.outgoingBubbleColor = '#7f56d9'`, together with `incomingBubbleColor '#eaecf0'`.

- [ ] **Step 5: Run tests and typecheck.** Run: `yarn workspace bugsee-playground test && yarn workspace bugsee-playground typecheck`.

- [ ] **Step 6: Commit.** Message: `Playground: Reports tab (dialog, upload, created report, handler, notify, colours, feedback)`.

---

### Task 11: Data tab

**Files:**
- Create: `src/screens/DataScreen.tsx`, `app/(tabs)/data.tsx`

**Interfaces:**
- Produces: `export const dataActions: Action[]`.

- [ ] **Step 1: Implement.**
  - **User.**
    - `Bugsee.setUserIdentifier('playground-user@example.com')`.
    - `Bugsee.getUserIdentifier()`.
    - `Bugsee.clearUserIdentifier()`.
    - Expect: "The report's user is playground-user@example.com until cleared".
  - **Attributes.**
    - `Bugsee.setAttribute('plan', 'pro')`, `('seats', 5)`, `('ratio', 0.75)` and `('beta', true)`.
    - `Bugsee.getAttribute('plan')`, `Bugsee.getAllAttributes()`, `Bugsee.clearAttribute('plan')`, `Bugsee.clearAllAttributes()`.
    - Invalid values:
      - `Bugsee.setAttribute('', 'x')`, Expect "Rejects with BugseeAttributeError";
      - `Bugsee.setAttribute('obj', { a: 1 } as never)`, same;
      - `Bugsee.setAttribute('nan', Number.NaN)`.
    - Expect lines use the `.code` value that `ActionButton` prints.
  - **Breadcrumbs.**
    - `Bugsee.addBreadcrumb({ category: 'ui', level: 'info', message: 'Tapped Add breadcrumb', type: 'user' })`.
    - With data: `data: { screen: 'Data' }`.
    - `Bugsee.setBreadcrumbFilter((c) => (c.category === 'ui' ? null : c))`, Expect "ui breadcrumbs are dropped".
    - `Bugsee.setBreadcrumbFilter(null)`.
  - **Events and traces.**
    - `Bugsee.event('playground_event')`.
    - `Bugsee.event('purchase', { sku: 'A-1', qty: 2, gift: false })`.
    - `Bugsee.trace('cart_total', 42.5)`, `Bugsee.trace('signed_in', true)`, `Bugsee.trace('tier', 'gold')`.
    - Expect: "Events and traces in the report's timeline".

  `app/(tabs)/data.tsx` is the one-line re-export.

- [ ] **Step 2: Typecheck.** Run: `yarn workspace bugsee-playground typecheck`.

- [ ] **Step 3: Commit.** Message: `Playground: Data tab (user, attributes, breadcrumbs, events, traces)`.

---

### Task 12: Perf tab

**Files:**
- Create: `src/screens/PerfScreen.tsx`, `src/fakeCheckout.ts`, `app/(tabs)/perf.tsx`
- Test: `__tests__/fakeCheckout.test.ts`

**Interfaces:**
- Produces: `runFakeCheckout(sleep?: (ms: number) => Promise<void>): Promise<BugseeTransaction>`.
  - It starts `Bugsee.startTransaction('checkout', 'ui.action', { cart_items: 3 })`.
  - It runs child spans `validate` (200 ms), `payment` (700 ms; `setAttribute('provider', 'demo')`) and `confirm` (300 ms), each `finish(SpanStatus.OK)`.
  - Then it calls `tx.finish(SpanStatus.OK)`, for about 1.2 s in total.
- Produces: `export const perfActions: Action[]`.

- [ ] **Step 1: Write the failing test.** With the Bugsee mock, call `runFakeCheckout(async () => {})`. Assert:
  - `startTransaction` was called with `('checkout', 'ui.action', { cart_items: 3 })`;
  - the transaction's `startChildSpan` was called 3 times with `'validate'`, `'payment'` and `'confirm'`;
  - `finish` was called on the transaction last.

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test fakeCheckout`.

- [ ] **Step 3: Implement it, then run the test.** Expected: PASS.

- [ ] **Step 4: Implement `PerfScreen.tsx`.** Actions:
  - `Bugsee.startTransaction('checkout', …) fake checkout` (`fake-checkout`). Expect: "A checkout transaction of about 1.2 s with 3 child spans in Performance".
  - `Bugsee.startSpan('manual.work', 'no transaction')`, then `finish()` immediately. Expect: "A no-op without an active transaction".
  - `Bugsee.getActiveSpan()`. Expect: "null outside a transaction".
  - Rename and status: start a transaction `'rename-me'`, `setName('renamed')`, `setStatus(SpanStatus.Error)`, `finish()`.
  - Nested spans around real network: a transaction `'load-products'`, with a span `http.client` around `fetchProducts()` and a span `parse`; finish all.
  - Slow render: `Bugsee.startSpan('ui.render', 'slow list')`. The action sets state to render 3000 rows, then `finish()` in an effect after commit.

  `app/(tabs)/perf.tsx` is the one-line re-export.

- [ ] **Step 5: Commit.** Message: `Playground: Perf tab (transactions, spans, nested network spans)`.

---

### Task 13: Demo shop

**Files:**
- Create: `app/shop/_layout.tsx`, `app/shop/sign-in.tsx`, `app/shop/products.tsx`, `app/shop/product/[id].tsx`, `app/shop/checkout.tsx`, `src/screens/shop/{SignIn,Products,ProductDetail,Checkout}.tsx`, `src/shop/flow.ts`, `src/ui/CapturedNote.tsx`
- Test: `__tests__/shop.flow.test.ts`

**Interfaces:**
- Consumes: `fetchProducts`, `postJson`, `DEMO` (Task 7); `afterTap` (Task 9).
- Produces, in `src/shop/flow.ts`:
  - `startCheckoutFlow(): void`, which starts `Bugsee.startTransaction('checkout', 'shop.flow')` if none is running (module-level `tx`);
  - `stepSpan(name: 'sign-in' | 'products' | 'detail' | 'checkout'): BugseeSpan`, as `tx.startChildSpan('shop.step', name)`;
  - `finishFlow(status: SpanStatus): void`;
  - `SHOP_NETWORK_FILTER: NetworkFilter`, which replaces `"password":"…"` in bodies with `"password":"***"`;
  - `pay(outcome: 'success' | 'declined' | 'bug', cart: { total: number } | undefined): Promise<'ok' | 'declined'>`.
    - success: `postJson(ECHO, …)`, then `finishFlow(OK)`.
    - declined: `fetch(STATUS(402))`, then `Bugsee.logException(new Error('Payment declined'), { labels: ['checkout', 'payment'], domain: 'payment' })`, then `finishFlow(Error)`.
    - bug: `afterTap(() => { const order: { total: number } | undefined = undefined; String((order as unknown as { total: number }).total); })`. This is a real `TypeError: Cannot read property 'total' of undefined` thrown from a timer, so it reaches the global handler.

- [ ] **Step 1: Write the failing test** `__tests__/shop.flow.test.ts`:
  - `SHOP_NETWORK_FILTER` redacts `{"email":"a@b.co","password":"hunter2"}` to contain `"password":"***"` and leaves `email`.
  - It returns events without a body unchanged.
  - `pay('declined')` calls `Bugsee.logException` with `expect.any(Error), { labels: ['checkout', 'payment'], domain: 'payment' }`.
  - `pay('success')` finishes the transaction with `SpanStatus.OK`.
  - `startCheckoutFlow()` twice starts one transaction.

- [ ] **Step 2: Run the test to verify it fails.** Run: `yarn workspace bugsee-playground test shop.flow`.

- [ ] **Step 3: Implement `flow.ts`, then run the test.** Expected: PASS.

- [ ] **Step 4: Implement the screens.**
  - `CapturedNote`: a collapsible "What Bugsee captured here" box with bullet text.
  - `app/shop/_layout.tsx`:
    - a `Stack`, with screen titles: Sign in, Products, Product, Checkout;
    - `headerRight` is a "Report a problem" button that calls `Bugsee.showReportDialog(\`Problem on ${route.name}\`)`;
    - on mount, `Bugsee.setNetworkFilter(SHOP_NETWORK_FILTER)` and `startCheckoutFlow()`; on unmount, `Bugsee.setNetworkFilter(null)`.
  - **SignIn:**
    - fields: email, password (`secureTextEntry`), and a "Remember me" switch;
    - Submit: `const s = stepSpan('sign-in'); await postJson(DEMO.ECHO, { email, password }); if (remember) Bugsee.setUserIdentifier(email); s.finish(SpanStatus.OK); router.push('/shop/products')`;
    - note: "Password masked in video with no extra code; request body shows "password":"***"; user id set if Remember me".
  - **Products:**
    - a `FlatList` with `RefreshControl`. Refresh runs `Bugsee.addBreadcrumb({ category: 'shop', level: 'info', message: 'Refreshed products', type: 'user' })`, then reloads.
    - a "Flaky API" switch and a load-attempt counter, passed to `fetchProducts`.
    - on `DemoHttpError`: an inline error, plus `Bugsee.logException(e, { labels: ['shop', 'products'] })`.
    - a `source === 'mock'` badge: "Offline mock".
    - tapping a row: `Bugsee.event('product_viewed', { id })` and `router.push(\`/shop/product/${id}\`)`.
  - **ProductDetail:**
    - an image (if a thumbnail exists), the title, price and description;
    - "Add to cart": increments a module-level cart in `flow.ts` (`cart.items`, `cart.total`), calls `Bugsee.setAttribute('cart_items', cart.items)`, and offers "Checkout" to push `/shop/checkout`.
  - **Checkout:**
    - `BugseeSecure` wrapping the card number, expiry and CVV inputs; the shipping address is unwrapped;
    - a segmented control of three `Pressable`s: Success, Declined, Bug;
    - Pay calls `pay(outcome, cart)`, then shows a toast (`Alert` or an inline banner);
    - note: "Card fields black in video, address visible; Declined: handled error with labels checkout, payment; Bug: crash at next launch with the whole flow".

  Route files re-export, one line each. `product/[id].tsx` reads `useLocalSearchParams<{ id: string }>()` inside `ProductDetail`.

- [ ] **Step 5: Run tests and typecheck.** Run: `yarn workspace bugsee-playground test && yarn workspace bugsee-playground typecheck`.

- [ ] **Step 6: Commit.** Message: `Playground: demo shop (sign-in, products, detail, checkout with three outcomes)`.

---

### Task 14: Render tests and the action-mapping test

**Files:**
- Create: `src/screens/allActions.ts`, `__tests__/screens.render.test.tsx`, `__tests__/actions.mapping.test.ts`

**Interfaces:**
- Consumes: every `*Actions` export: `homeActions`, `captureActions`, `privacyActions`, `errorsActions`, `reportsActions`, `dataActions`, `perfActions`.
- Produces: `ALL_ACTIONS: { screen: string; action: Action }[]`.

- [ ] **Step 1: Write the tests.**

  `__tests__/actions.mapping.test.ts`:

```ts
import Bugsee from '@bugsee/react-native';
import * as Feedback from '@bugsee/react-native-feedback';
import { PlaygroundNative } from '../modules/playground-native';
import { ALL_ACTIONS } from '../src/screens/allActions';
import { callTarget } from '../src/ui/action';

jest.useFakeTimers();
const ids = ALL_ACTIONS.map((a) => `${a.screen}/${a.action.id}`);
test('ids are unique', () => expect(new Set(ids).size).toBe(ids.length));

const spies: Record<string, (m: string) => jest.Mock | jest.SpyInstance> = {
  Bugsee: (m) => (Bugsee as unknown as Record<string, jest.Mock>)[m],
  Feedback: (m) => (Feedback as unknown as Record<string, jest.Mock>)[m],
  PlaygroundNative: (m) => (PlaygroundNative as unknown as Record<string, jest.Mock>)[m],
  console: (m) => jest.spyOn(console, m as 'log').mockImplementation(() => {}),
};

describe.each(ALL_ACTIONS.map((a) => [`${a.screen}/${a.action.id}`, a.action] as const))('%s', (_id, action) => {
  const target = callTarget(action.call);
  test(`runs ${target.object}.${target.member}`, async () => {
    jest.clearAllMocks();
    if (target.object === 'global' || target.object === 'report' || target.member === 'appearance') {
      // fetch/XHR/WebSocket/Promise and created-report steps are checked by their own tests; here they must not throw synchronously.
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' }) as never;
      expect(() => { const r = action.run(); if (r instanceof Promise) r.catch(() => {}); }).not.toThrow();
      return;
    }
    const spy = spies[target.object](target.member);
    try { await Promise.resolve(action.run()); } catch { /* rejection is logged by ActionButton; the call is what we check */ }
    jest.runAllTimers();
    expect(spy).toHaveBeenCalled();
  });
});
```

  For `Feedback`, the mock's `appearance` is a plain object, so `Feedback.appearance` actions fall into the "must not throw" branch. Extend the branch condition: `target.member === 'appearance'` covers both objects.

  `__tests__/screens.render.test.tsx`:
  - For each of HomeScreen, CaptureScreen, PrivacyScreen, ErrorsScreen, ReportsScreen, DataScreen, PerfScreen, SetupScreen, ScanScreen and shop SignIn, Products, ProductDetail and Checkout, render inside `SessionProvider`, and assert no throw.
  - For tab screens, assert that every visible action label renders: `getByText(action.label)` for the actions without `platforms`, or whose `platforms` include `'ios'`.
  - Mock `fetch` to resolve products for Products.
  - Mock `useLocalSearchParams` to return `{ id: '1' }`.

- [ ] **Step 2: Run the tests.** Run: `yarn workspace bugsee-playground test`.
  - Expected: PASS.
  - If a mapping row fails, the action's `call` string does not match its `run`. Fix the action, not the test.

- [ ] **Step 3: Prove that the mapping test can fail.** Temporarily change one action's `call` from `Bugsee.event(` to `Bugsee.trace(`.
  - Run the test: FAIL on that row.
  - Revert it.
  - Note the red run in the commit message body.

- [ ] **Step 4: Commit.** Message: `Playground: render tests for every screen and the label-to-call mapping test`.

---

### Task 15: CI workflow

**Files:**
- Create: `.github/workflows/playground.yml`
- Uses: `scripts/cli-check-no-internal-hosts.ts` (on `main` since #77).

- [ ] **Step 1: Write the workflow.**

```yaml
name: playground

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - 'examples/playground/**'
      - 'packages/**'
      - '.github/workflows/playground.yml'
      - 'yarn.lock'
  workflow_dispatch:

concurrency:
  group: playground-${{ github.ref }}
  cancel-in-progress: true

env:
  BUGSEE_APP_TOKEN: 00000000-0000-4000-8000-000000000000
  BUGSEE_ENDPOINT: http://127.0.0.1:9

jobs:
  js:
    name: playground typecheck, lint, tests, host check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.18' }
      - run: corepack enable
      - run: yarn install --immutable
      - run: yarn workspace bugsee-playground typecheck
      - run: yarn eslint examples/playground
      - run: yarn workspace bugsee-playground test --ci
      - run: node scripts/cli-check-no-internal-hosts.ts
  android:
    name: playground android build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.18' }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - run: corepack enable
      - run: yarn install --immutable
      - working-directory: examples/playground
        run: CI=1 npx expo prebuild -p android --no-install
      - working-directory: examples/playground/android
        run: ./gradlew :app:assembleDebug --no-daemon
  ios:
    name: playground ios simulator build
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.18' }
      - run: corepack enable
      - run: yarn install --immutable
      - working-directory: examples/playground
        run: CI=1 npx expo prebuild -p ios
      - working-directory: examples/playground/ios
        run: |
          set -o pipefail
          xcodebuild -workspace BugseePlayground.xcworkspace -scheme BugseePlayground \
            -sdk iphonesimulator -configuration Debug -destination 'generic/platform=iOS Simulator' \
            CODE_SIGNING_ALLOWED=NO build | tail -20
```

  Check the Java version and the Xcode selection against the existing `android` and `ios` jobs in `ci.yml`, and copy their setup steps (for example, any `xcode-select`, or a Gradle cache) verbatim.

- [ ] **Step 2: Lint the workflow locally**, if `actionlint` is available (`actionlint .github/workflows/playground.yml`). Then run the `js` job's commands locally: all exit 0.

- [ ] **Step 3: Commit.** Message: `CI: build and test the playground on both platforms`.

  After the branch is pushed (Task 16), all three jobs must be green on the PR before the branch is offered for merge.

---

### Task 16: README and VALIDATION

**Files:**
- Create: `examples/playground/README.md`, `examples/playground/VALIDATION.md`
- Modify: root `README.md` or `packages/react-native/README.md`, wherever examples are listed (add one line linking the playground; check with `grep -n "examples/" README.md packages/react-native/README.md`)

- [ ] **Step 1: Write `README.md`.** It follows spec section 10, in this order:
  - **Prerequisites:** Node 22.18+, Yarn 4 via corepack, Xcode 26 or Android Studio, and a Bugsee account with an iOS and/or Android app.
  - **Development build.** It does not run in Expo Go.
  - **Quick start:**

    ```
    corepack enable && yarn install
    cp examples/playground/bugsee.config.example.json examples/playground/bugsee.config.json
    ```

    Then edit it (optional), then run `yarn playground ios` or `yarn playground android`.
  - **Enter your token.** Paste it, or scan the `BGSAPT:` QR code from the dashboard ("coming soon on the dashboard"; until then, any QR generator with the text `BGSAPT:<token>` works).
  - **Your first report.** Reports tab → "Show report dialog" → Send → dashboard.
  - **Tour.** One line per tab, plus the shop.
  - **See symbolicated crashes.** The table from spec section 5.1, the three Release commands, `symbolicateReactNativeFrameworks`, the environment variables `BUGSEE_APP_TOKEN` / `BUGSEE_TOKEN_IOS`, and `ios/.xcode.env.local`. An optional `endpoint` for self-hosted or regional installs, with the example `https://bugsee.example.com`.
  - **Use outside this repo.** Copy the folder; replace `workspace:*` with the published versions; remove `metro.config.js` monorepo assumptions, if any.
  - **Known issues.** Generated by hand from `src/ui/knownIssues.ts`.

- [ ] **Step 2: Write `VALIDATION.md`.** Columns: ID | Platform | Where (tab → section) | Action | Expected | Where to look (dashboard). It says "your Bugsee instance", and names no host. Rows:
  - **M-A1 / M-B1.** Reports → Report → "Show report dialog" (prefilled) → tap Send → one report with the prefilled summary and description.
  - **M-B2.** The same dialog → Cancel → lifecycle on Home shows `AfterReportShown`; no new report.
  - **M-A3 / M-B3.** Setup → Advanced → set `reporting.ui.summary-required`, `description-required`, `email-required` and `labels-required` to `true` → Launch → Reports → "Show report dialog (empty)" → Send is refused; fill x / x / a@b.co / label l1 → Send → the report carries them. M-B3 then sets `reporting.ui.labels-enabled=false` and `priority-selector-enabled=false` → the fields are hidden. Then `reporting.ui.style` → screenshot.
  - **M-A4 / M-B4.** Default options (the shake trigger is on) → shake → the dialog opens → Back / Cancel.
  - **M-A5 / M-B5.** Advanced → `reporting.triggers.screenshot=true` → relaunch → hardware screenshot → the dialog opens.
  - **M-A6.** Android, Advanced → `capture.video.mode=20` (Fullscreen) → relaunch → "Start now" → Home, wait 10 s, reopen → Reports → Upload → the video shows the status bar and continues across the background. Relaunch: no prompt. Set `capture.video.fullscreen-remember-decision=false` → relaunch → Cancel → the app keeps running; Upload works.
  - **M-A7.** Android, Advanced → `reporting.triggers.notification-bar=true` → relaunch → the notification shade → tap Bugsee → the dialog opens.
  - **M-A8 / M-B6.** Fresh install (Android: clear the app's storage; iOS: delete and reinstall), then Launch, then Reports → Feedback → "Show feedback UI". The e-mail screen appears. Skip, and the chat opens. iOS shows the greeting after `setGreeting`; on Android the greeting is missing (known bug 8).
  - **M-B7.** iOS: Advanced → `capture.video.privacy-blur=true` → relaunch → open the app switcher for 3 s → back → Upload → blurred frames in the video.
  - **M-A10 / M-B9.** Advanced → `detect.frustration=true` → relaunch → Privacy → tap the "BugseeSecure" box quickly 6 times within 2 s (a no-op target) → a frustration event in the next report.
  - **M-A11.** Reports → "Show report dialog" → press and hold Send for 3 s (screenshot) → Feedback e-mail screen → hold Continue and Skip (screenshot). Pressed colours are visible.
  - **M-C1.** Reports → Feedback → "Set listener" → "Show feedback UI" → send `campaign <nonce>` → reply from the dashboard → the result log shows the received message. "Clear listener" → reply again → nothing logged.
  - **M-C2.** iOS: Airplane Mode on → Reports → Upload → Airplane Mode off (and once more mid-upload) → exactly one issue arrives.
  - **M-C3.** Only with a data SIM: Setup → Common → "Wi-Fi only upload" on → Wi-Fi off → Upload → nothing within 2 min → Wi-Fi on → it arrives.
  - **M-C4.** After the shop flow's "Bug" outcome (Release build with symbols uploaded), open the crash. Check that:
    - the video plays;
    - the console lines and network events are listed;
    - the RN view tree renders;
    - the attributes (`cart_items`) and the user id are shown;
    - the JS stack is symbolicated.
  - **M-C5.** iOS: `npx expo prebuild -p ios` → open `ios/BugseePlayground.xcworkspace` → Product → Archive. The Report navigator shows the dSYM upload post-action. Organizer → Generate Privacy Report → Bugsee's entries are present.
  - **Extra rows for the playground smoke** (from spec 11): each tab renders; the shop flow completes; one JS, one native and one NDK crash are recovered at the next launch.
  - **A "Known issues" column**, filled from `knownIssues.ts`, for rows a known issue affects.

  Option keys in the rows use the short form shown in Setup (without `com.bugsee.option.`). Check each key against `option-keys.json`; drop a row's platform if its key is absent there.

- [ ] **Step 3: Verify that no internal host or real token slipped in.** Run:
  - `node scripts/cli-check-no-internal-hosts.ts` (exit 0; it scans tracked files, so `git add` first);
  - `grep -rnE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' examples/playground --include=*.md --include=*.json --include=*.ts --include=*.tsx | grep -v 00000000-0000-4000-8000-000000000000 | grep -v __tests__`. It must print nothing: test fixtures are synthetic.

- [ ] **Step 4: Commit.** Message: `Playground: README and VALIDATION map`.

---

### Task 17: Device smoke pass (controller-run, not a subagent)

This needs the user's devices and the device locks, so the controller runs it, not a subagent.
- **Locks.** Use `.device-lock-xs` (iPhone XS) and `.device-lock` (WOD_LX1). Acquire each one with `until mkdir <lock>; do sleep 30; done`.
- **Builds.** Release builds, with the placeholder token and the dead endpoint `http://127.0.0.1:9`.
- **Off-limits.** Never touch the iPhone 16 Pro `00008140-0014382A0CD8801C`. The XS is reached only through the hardened harness.

- [ ] **Step 1: Run the smoke pass on each device.**
  - Launch.
  - Every tab renders.
  - The shop flow completes, with outcomes Success and Declined.
  - One JS crash, one native crash, and (Android) one NDK crash, each recovered at the next launch. Recovery shows in the device log, as a report queued for upload.
- [ ] **Step 2: Test the QR scan** with a QR generated locally (`qrencode -o qr.png "BGSAPT:00000000-0000-4000-8000-000000000000"`), shown on the Mac screen.
- [ ] **Step 3: Record the results** in the campaign workspace as `playground-smoke.md`. File an upstream issue for any SDK problem found (memory: file-sdk-issues).
