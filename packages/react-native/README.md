# @bugsee/react-native

Bugsee for React Native. Crash, error and bug reports carrying the video,
network traffic, console logs and traces that led up to them.

Wraps the native Bugsee SDKs — it is not a reimplementation — so a report from
a React Native app is the same report a native app produces, with the JS layer
added.

## Requirements

| | |
|---|---|
| React Native | 0.81 or later, New Architecture enabled |
| iOS | 15.0 or later |
| Android | API 21 or later |

The New Architecture is the default from React Native 0.76. On 0.81 it can
still be turned off; this package requires it on.

## Install

```sh
yarn add @bugsee/react-native
```

**iOS.** React Native 0.87 and later resolve the SDK through Swift Package
Manager. Earlier versions use CocoaPods, where the podspec vendors the same
XCFramework — run `pod install` as usual. Nothing is published to CocoaPods
trunk, so no `pod repo update` is needed.

**Android.** Autolinking picks the module up; no Gradle changes are required.

## Use

```ts
import Bugsee, { createDefaultLaunchOptions } from '@bugsee/react-native';

const options = createDefaultLaunchOptions();
options.captureLogs = true;

await Bugsee.launch('<your app token>', options.serialize());
```

`launch` resolves to whether the SDK started. It can decline — already
running, or a token the backend rejects — without that being an error worth
throwing on. Capture comes up asynchronously, so poll `getStatus()` rather
than assuming a resolved `launch` means recording has begun.

## Expo config plugin

```json
{
  "expo": {
    "plugins": [
      ["@bugsee/react-native", { "appToken": { "ios": "<ios token>", "android": "<android token>" } }]
    ]
  }
}
```

`appToken` is one string for both platforms, or one token per platform. On
`expo prebuild` the plugin wires the Bugsee Gradle plugin, the Hermes debug-id
hooks and the iOS dSYM Archive action. Release builds then upload their source
maps, and Archives upload their dSYMs, whenever a real token is set.
`uploadSourcemaps: false` and `uploadSymbols: false` turn those uploads off.
A committed `ios/` (`project.pbxproj` and the shared scheme) or
`android/bugsee.properties` carries the token.

## Android source maps

Release builds give the Hermes bundle a debug id and upload its source map, so
JS frames in a crash report resolve. An Expo app gets this from the config
plugin. A bare app needs two edits in `android/app/build.gradle`:

```groovy
react {
    // Copies the JS aside before hermesc compiles it, so the debug id can
    // reach the bytecode.
    hermesCommand = file("../../node_modules/@bugsee/react-native/scripts/hermesc-preserve-js.sh").absolutePath
}

// At the end of the file.
apply from: file("../../node_modules/@bugsee/react-native/scripts/bugsee-sourcemaps.gradle")
```

If Hermes compiles a bundle without going through `hermesc-preserve-js.sh`,
the bundle task fails rather than ship a release without a debug id. With
Hermes off, the plain JS bundle and Metro's map get the id instead.

- **The upload needs a real token.** Set `app_token` in
  `android/bugsee.properties`, or `BUGSEE_APP_TOKEN`. Without a token, or with
  `-PbugseeUploadSourcemaps=false`, the build skips the upload with one line. A
  failed upload warns and does not fail the build.
- **The version and build number** are the variant's own, flavors included.

## Licence

Commercial. See [LICENSE](./LICENSE) and https://www.bugsee.com/terms.
