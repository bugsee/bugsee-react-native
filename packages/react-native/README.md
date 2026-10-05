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

The plugin's Gradle edits never remove or change a line of your own code, on a
clean or a `--no-clean` prebuild, however often it runs: it adds its own
marked lines, replaces only those, and rewrites exactly one of yours,
`react.hermesCommand`, with any trailing comment kept. Its own lines are
recognised only by their markers: the NDK dependency ends in `// bugsee:ndk`
(as does the opener of the `dependencies` block it adds when the file has
none), and the symbol-table block starts with `// bugsee-symbol-table:`. A
`bugsee-android-ndk` dependency of your own, anywhere and however written, is
never touched: the plugin then adds none of its own and says so in the
prebuild log. Your own `ndk { }` block is never touched either, and a line of
yours added inside the plugin's symbol-table block makes it refuse rather
than delete. It inserts only at anchors that hold nothing but their brace
(`dependencies {`, `buildscript … }`, `pluginManagement {`, `repositories {`,
a build type's `{` and `}`; a trailing comment is fine), always as whole
lines at your indentation, and never splits a line. Where it cannot do that
with certainty it refuses the prebuild with one error that names the file,
the reason and the fix, and writes nothing. It refuses:

- a Kotlin DSL `settings.gradle.kts`, `build.gradle.kts` or app
  `build.gradle.kts`;
- a Gradle file it cannot read for sure: a string that does not close on its
  line, a comment or string still open at the end of the file, braces that do
  not balance, or a `/` that could start a slashy string as well as divide;
- a `react.hermesCommand` that spans several lines or shares its line with
  another statement after `;`;
- an anchor brace that shares its line with code: a one-line
  `dependencies { … }` or `release { … }`, a `minifyEnabled true }`, a
  `buildscript { … }; …`, a one-line `pluginManagement` or `repositories`
  block (with the option that needs that edit on);
- its own symbol-table block with a line of yours inside it (with
  `nativeCrashReporting` off);
- a `gradlePluginVersion` option or a baked NDK version that is not a plain
  version string.

A declaration of `com.bugsee.android.gradle` in `android/build.gradle` is
taken as the plugin's own pin, whoever wrote it: its version follows the
wrapper's on each prebuild.

## Android source maps

Release builds give the Hermes bundle a debug id and upload its source map, so
JS frames in a crash report resolve. An Expo app gets this from the config
plugin. A bare app needs two edits in `android/app/build.gradle`. Resolve the
package through node, as React Native's own template resolves
`react-native`, so a hoisted or nested install works too:

```groovy
def bugseeDir = new File(["node", "--print", "require.resolve('@bugsee/react-native/package.json')"]
    .execute(null, rootDir).text.trim()).getParentFile()

react {
    // Copies the JS aside before hermesc compiles it, so the debug id can
    // reach the bytecode.
    hermesCommand = new File(new File(bugseeDir, "scripts"), "hermesc-preserve-js.sh").absolutePath
}

// At the end of the file. Applying it twice is harmless.
apply from: new File(new File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle")
```

If Hermes compiles a bundle without going through `hermesc-preserve-js.sh`,
the bundle task fails rather than ship a release without a debug id. With
Hermes off, the plain JS bundle and Metro's map get the id instead.

- **The upload needs a real token.** Set `app_token` in
  `android/bugsee.properties`, or `BUGSEE_APP_TOKEN`. Without a token, or with
  `-PbugseeUploadSourcemaps=false`, the build skips the upload with one line. A
  failed upload warns and does not fail the build.
- **The version and build number** are the variant's own, flavors included.
- **The preserve directory.** For a bundle at `build/generated/assets/<x>`
  the wrapper keeps the JS in `build/intermediates/bugsee-sourcemaps/<x>`.
  The wrapper and `hermes-sourcemaps.js` take the last `generated/assets` in
  the path; the Gradle hook takes the path relative to the build directory.
  The three agree unless the bundle directory itself nests another
  `generated/assets`, which React Native never does.
- **Limitations.** The preserve wrapper is a shell script, so Hermes release
  builds on a Windows host are not supported yet. The hook has not yet been
  verified with Gradle's configuration cache.

## Licence

Commercial. See [LICENSE](./LICENSE) and https://www.bugsee.com/terms.
