# Bugsee Playground

A sample app for `@bugsee/react-native`. Every screen has buttons that call one
SDK API each. Under each button you see the exact call and what you should find
in your Bugsee dashboard afterwards.

Use it to try the SDK, to check a build, or as a starting point for your own app.

## Prerequisites

- Node 22.18 or newer.
- Yarn 4, through corepack (`corepack enable`).
- Xcode 26 (iOS) or Android Studio (Android).
- A Bugsee account with an iOS app, an Android app, or both. Each platform is a
  separate Bugsee app with its own token.

## Development build

The playground uses native code, so it does **not** run in Expo Go. Build it
with `expo prebuild` and `expo run:ios` / `expo run:android`. The commands
below do both.

## Quick start

From the repository root:

```sh
corepack enable && yarn install
cp examples/playground/bugsee.config.example.json examples/playground/bugsee.config.json
```

Edit `bugsee.config.json` and put your app tokens in it. This step is optional:
you can also paste a token in the app. Without a token in the file, crashes are
not symbolicated (see "See symbolicated crashes").

Then run one of:

```sh
yarn playground ios
yarn playground android
```

`bugsee.config.json` is git-ignored. Do not commit real tokens.

## Enter your token

On first start the Setup screen opens.

1. The token field is for the platform you run on. Paste the app token (a UUID)
   from your Bugsee dashboard, or tap **Scan QR**.
2. **Scan QR** accepts only a code that contains exactly `BGSAPT:<token>`.
   The dashboard QR code is coming to the dashboard. Until then, any QR code
   generator works: encode the text `BGSAPT:<token>`.
3. **Endpoint**: empty launches against the build's default, which is Bugsee
   cloud unless `bugsee.config.json` sets `endpoint`. When it does, Setup
   pre-fills the field with that value and shows "From bugsee.config.json".
   Change it only for a different self-hosted or regional install.
4. Adjust **Common options** or **Advanced options** if you like. Advanced
   lists every launch option key (shown without the `com.bugsee.option.`
   prefix) and sets it through `setCustomOption`.
5. Tap **Launch**.

You can come back with the **Setup** link in the header of any tab. Tapping
**Launch** there while Bugsee runs stops it and launches it again, so a changed
token or options take effect (Home's lifecycle log shows "Relaunched with the
new options").

**Auto-launch** (Setup → Auto-launch, or Home) is off by default. Turn it on to
launch Bugsee at every app start with the saved settings; it is needed to send
crash reports at the next start.

If you built with a token in `bugsee.config.json`, Setup shows only its first 8
characters as a hint ("Build-time token configured: …"); paste the full token.
It warns you when the token you launch with is not the one the symbols were
uploaded for.

## Your first report

1. Open the **Reports** tab.
2. In the **Report** section, tap **Show report dialog (prefilled)**.
3. Tap **Send**.
4. Open the report in your Bugsee dashboard. It carries the summary and
   description from the dialog.

## Wrap the root component

Copy this line into your own app. `Bugsee.wrap` lets Bugsee capture the React
Native view tree; without it the view hierarchy in every report is empty. With
Expo Router, wrap the root layout (`app/_layout.tsx`):

```tsx
export default Bugsee.wrap(RootLayout);
```

Without Expo Router, wrap the component you register:
`AppRegistry.registerComponent(appName, () => Bugsee.wrap(App))`.

## Tour

| Tab | What is there |
|---|---|
| Home | Status and lifecycle events, launch / relaunch / stop, launch options, data deletion, auto-launch, and the demo shop |
| Capture | Logging, JS and native network calls, network filters and events, and a WebView |
| Privacy | Blackout, `BugseeSecure`, secure text fields, manual secure rectangles, blackout before launch |
| Errors | Handled and unhandled errors, an `ErrorBoundary`, JS / native / NDK crashes, a hang |
| Reports | Report dialog, upload, created reports, report handler, notify, report colours, feedback chat |
| Data | User identifier, attributes, breadcrumbs, events, traces |
| Perf | Transactions and spans, a slow render |

**Demo shop** (Home → Demo shop → **Try the demo shop**). A small shop with a
product list, sign in, product detail and checkout. The checkout **Pay** button
has three outcomes: **Success**, **Declined** (a handled error) and **Bug** (a
crash sent at the next launch; see below). It shows how Bugsee looks on a
realistic flow: card fields are blacked out, and every screen has a **Report a
problem** button.

The **Report handler** preset you pick on Reports is saved and installed before
every launch, so it also runs on a crash recovered at the next start.

Crash buttons ask for confirmation. A crash report is sent when Bugsee launches
at the next start: turn on Setup → Auto-launch first (or tap Home → Launch after
reopening), then reopen the app. A JS crash may leave the process running in a
Release build: force-quit the app (swipe it away), then open it again;
backgrounding and returning does not restart it.

## See symbolicated crashes

Symbols and source maps are uploaded at build time, so the token comes from the
build configuration, not from the Setup screen.

`bugsee.config.json` (copied from `bugsee.config.example.json`):

```json
{
  "appToken": { "ios": "<iOS app token>", "android": "<Android app token>" },
  "endpoint": "https://bugsee.example.com",
  "symbolicateReactNativeFrameworks": true
}
```

- `appToken`: one token per platform. A single string is used for both.
- `endpoint`: optional. Only for self-hosted or regional installs, an https URL
  with no `/v2`. Leave it out for Bugsee cloud. It is built into the app as the
  default endpoint (an empty Setup field launches against it), and Setup shows it.
- `symbolicateReactNativeFrameworks`: optional, off by default. When `true`,
  `pod install` downloads React Native's dSYMs, so React frames in iOS crashes
  are symbolicated too. It adds a download.

`app.config.ts` passes these to the `@bugsee/react-native` config plugin. On
`expo prebuild` the plugin does this:

| Platform | Where the token lands | What it uploads |
|---|---|---|
| Android | `android/bugsee.properties` | The Bugsee Gradle plugin uploads the R8/ProGuard mapping, the unstripped NDK libraries and the Hermes source maps, and registers the build |
| iOS | The Xcode bundle phase and the Archive post-action | Hermes source maps from the bundle phase. dSYMs from the Archive: the app, the native module and Bugsee (plus React with `symbolicateReactNativeFrameworks`) |

Uploads happen only in **Release** builds and Archives. Use:

```sh
cd examples/playground
npx expo run:android --variant release
npx expo run:ios --configuration Release
```

For iOS dSYMs, run `npx expo prebuild -p ios`, open the workspace in Xcode, and
choose Product → Archive.

**Other ways to give the token** (for CI, or when you have no file):

- `BUGSEE_APP_TOKEN` is used for both platforms.
- `BUGSEE_TOKEN_IOS` is used for iOS only.
- For Xcode builds, put it in `ios/.xcode.env.local`:

  ```sh
  export BUGSEE_APP_TOKEN=00000000-0000-4000-8000-000000000000
  ```

  (That is a placeholder. Use your own token.)

Order of precedence: the config file wins; then `BUGSEE_APP_TOKEN` (both platforms); then `BUGSEE_TOKEN_IOS` (iOS only, used when `BUGSEE_APP_TOKEN` is unset).

**No token, or a placeholder token.** Uploads skip with one warning line, and
the build still succeeds. The app runs, but crashes show raw frames.

## Use outside this repo

1. Copy the `examples/playground` folder out of the repository.
2. In `package.json`, replace `workspace:*` for `@bugsee/react-native` and
   `@bugsee/react-native-feedback` with the published versions.
3. Check `metro.config.js` and `tsconfig.json` for settings that assume the
   monorepo (watch folders, paths to the repo root) and remove them.
4. Run `yarn install`, then `npx expo prebuild` and `npx expo run:ios` or
   `npx expo run:android`.

## Known issues

These are problems in the underlying Bugsee SDKs that affect some actions here.
The app shows a note next to each affected button.

None are open at the pinned versions (iOS 7.0.0-beta7 fixed bugsee-cocoa#223 and #224).

For manual test sessions, see [VALIDATION.md](./VALIDATION.md).
