# Bare example

The smallest React Native 0.87 app that launches the Bugsee SDK, plus the
device e2e that asserts it reaches `Status.Launched`.

Its job is to compile and run the native plumbing on real hardware. The unit
tests elsewhere in this repo mock the bridge, so by construction they cannot
catch a framework that was never embedded, a Gradle plugin that was never
applied, or a launch call made off the main thread. This app can.

## Credentials

Never committed. `scripts/write-credentials.mjs` reads the environment and
writes two gitignored files:

| File | Read by | Key |
|---|---|---|
| `credentials.json` | `App.tsx`, at runtime | `ios` / `android` / `endpoint` |
| `android/bugsee.properties` | the Bugsee Gradle plugin, at build time | `app_token` (unprefixed) |

```sh
export BUGSEE_TOKEN_IOS=…
export BUGSEE_TOKEN_ANDROID=…
export BUGSEE_ENDPOINT=https://apidev.bugsee.com
yarn credentials
```

`android/bugsee.properties` belongs to the **root** Gradle project
(`android/`), not to `android/app/`.

## Android

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
yarn start          # in another terminal — a debug build loads JS from Metro
yarn device:android # credentials, assembleDebug, install, adb reverse
E2E_PLATFORM=android yarn e2e
```

Two things the app build has to do that autolinking cannot:

- `android/settings.gradle` adds `mavenCentral()` to
  `pluginManagement.repositories`. The Bugsee plugin's marker is on Maven
  Central, not the Gradle Plugin Portal.
- `android/build.gradle` resolves `com.bugsee.android.gradle` and
  `android/app/build.gradle` applies it. Applying it to the root project fails
  with *"Must apply 'com.android.application' or 'com.android.library'
  first!"* — it hangs its tasks off an Android variant.

## iOS

```sh
export IOS_DEVELOPMENT_TEAM=…   # your Apple Developer team id
yarn device:ios     # credentials, pod install, build, embed assertion, install
E2E_PLATFORM=ios yarn e2e
```

The embed assertion is not optional decoration. A build that links Bugsee
without embedding it succeeds and then dyld-crashes on the device;
`scripts/assert-ios-embed.sh` fails the run instead. It looks at every Mach-O
at the bundle root because RN 0.87 Debug puts the app's own code in
`BareExample.debug.dylib` and leaves the executable a thin launcher.

A debug build here does **not** need Metro: the iPhone's Local Network
permission is off, `RCTBundleURLProvider` cannot reach the packager and falls
back to the `main.jsbundle` the build phase produced. JS changes therefore need
a rebuild, not just a reload.

### The other delivery path: SwiftPM

CocoaPods is what this app is checked in with. The SwiftPM path is verified by
migrating a scratch copy:

```sh
npx react-native spm add --deintegrate --yes
xcodebuild -project ios/BareExample.xcodeproj -scheme BareExample \
  -configuration Debug -destination "id=$IOS_DEVICE_ID" \
  -derivedDataPath ios/build-spm \
  DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates build
```

`--deintegrate` leaves `ios/Podfile` syntactically broken — it strips
`use_native_modules!` and the `use_react_native!(` call but leaves their
argument list behind — so getting back to CocoaPods means restoring `ios/` from
git and re-running `pod install`, not re-running the tool.

## The e2e

`e2e/launch.test.ts` launches the installed app and reads the device's own log
for two markers the app prints, with a clock for each:

| Marker | Budget | Why |
|---|---|---|
| `BUGSEE_E2E launching on …` | 120s | includes fetching a debug bundle from Metro |
| `BUGSEE_E2E status=2` | 10s | the assertion — measured from the bundle running, so a cold bundler cannot fail a test about Bugsee |

Log transports differ by platform: `adb logcat` on Android, and on iOS
`devicectl device process launch --console`, which attaches to stdout/stderr.
RN 0.87's default log function writes only to `os_log`, and os_log cannot be
streamed off a physical iPhone from the command line, so the example's
`AppDelegate` mirrors it to stderr in Debug.
