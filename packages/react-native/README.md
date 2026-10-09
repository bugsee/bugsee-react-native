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
| JavaScript engine | Hermes (React Native's default) |

The New Architecture is the default from React Native 0.76. On 0.81 it can
still be turned off; this package requires it on.

Hermes is required; JavaScriptCore (Hermes off) is not supported. React
Native removed JSC from core in 0.81, and the community package that replaces
it, `@react-native-community/javascriptcore`, does not work with current React
Native: its Android JSC cannot parse React Native's own bundle, and its iOS
build fails on 0.86 and 0.87.

## Install

```sh
yarn add @bugsee/react-native
```

**iOS.** React Native 0.87 and later resolve the SDK through Swift Package
Manager. Earlier versions use CocoaPods, where the podspec vendors the same
XCFramework — run `pod install` as usual. Nothing is published to CocoaPods
trunk, so no `pod repo update` is needed.

**Android.** Autolinking picks the module up, and the app builds and
launches with no Gradle changes. Release symbolication needs the Bugsee Gradle
plugin and the source-map hooks: see [Release symbolication](#release-symbolication).

**pnpm 10 and later** run no dependency's install script unless the project
decides, and pnpm 11 fails the install until it does
(`ERR_PNPM_IGNORED_BUILDS`): `@bugsee/cli`, which uploads symbols and source
maps, has a `postinstall`. Its binary comes from a platform-specific optional
dependency, so the script is only a download fallback for registry mirrors
that lack those packages. Decide in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@bugsee/cli': false   # true only if your registry lacks @bugsee/cli-<platform>
```

React Native itself also needs `nodeLinker: hoisted` under pnpm.

## Use

```ts
import Bugsee, { BugseeLaunchOptions, createDefaultLaunchOptions } from '@bugsee/react-native';

const options = createDefaultLaunchOptions();
options.captureLogs = true;

await Bugsee.launch('<your app token>', BugseeLaunchOptions.serialize(options));
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
wrapper's on each prebuild. Gradle allows one `plugins {}` block per script,
so when the root file already has one the pin goes into it (its braces must
stand alone on their lines, or the prebuild refuses); a new block is written
only when there is none.

## Release symbolication

A Release build has to send Bugsee what turns its crash frames back into
source: the JS source map (with a debug id that ties it to the shipped
bundle), the R8 mapping and the native (NDK) symbols on Android, and the
dSYMs on iOS. **An Expo app gets all of it from the config plugin.** A bare
app needs the three sections below — the Android source-map hooks, the Bugsee
Gradle plugin, and the iOS bundle phase. Without them the app still builds
and runs, but JS and native frames in Release reports stay unsymbolicated.

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
the bundle task fails rather than ship a release without a debug id.

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

## Android: Bugsee Gradle plugin

Uploads the R8/ProGuard mapping, the native (NDK) symbols and the build info
of each Release build. It is a Gradle plugin, so autolinking cannot add it;
the config plugin writes these same edits for an Expo app.

`android/settings.gradle` — the plugin is published to Maven Central, which
Gradle does not search for plugins unless told to:

```groovy
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}
```

`android/build.gradle` — declare it at the version this package is built
against (`android.gradlePlugin` in
`node_modules/@bugsee/react-native/native-versions.json`), above
`apply plugin: "com.facebook.react.rootproject"`:

```groovy
plugins {
    id 'com.bugsee.android.gradle' version '4.0.8' apply false
}
```

`android/app/build.gradle` — apply it, and for native crash symbols add the
NDK module at the SDK version the package pins. No `ndk.debugSymbolLevel` is
needed for Bugsee: Gradle plugin 4.0.8 uploads native symbols from the
unstripped libraries in `build/intermediates/merged_native_libs`, whatever
the level. Set one only for what Google Play should get.

```groovy
apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"
apply plugin: "com.bugsee.android.gradle"

// bugseeDir as in "Android source maps" above.
def bugseeVersions = new groovy.json.JsonSlurper().parse(new File(bugseeDir, "native-versions.json"))

dependencies {
    implementation "com.bugsee:bugsee-android-ndk:${bugseeVersions.android.sdk}"
}
```

`android/bugsee.properties` (next to `android/build.gradle`; keep it out of
version control if the token is private):

```properties
app_token=<your Android app token>
plugin.ndk.enabled=true
```

## iOS: bundle phase

The JS half of iOS symbolication. In Xcode, the app target's **Bundle React
Native code and images** build phase runs React Native's
`react-native-xcode.sh`. Point it at this package's `bugsee-xcode.sh`
instead, which runs React Native's script, then composes the Hermes source
map, gives the bundle and the map a debug id, and uploads the map:

```sh
set -e

WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh"

/bin/sh -c "\"$WITH_ENVIRONMENT\" \"$REACT_NATIVE_XCODE\""
```

The upload needs a real token, from `BUGSEE_APP_TOKEN` or `BUGSEE_TOKEN_IOS`
in the build environment (for example `export BUGSEE_APP_TOKEN=…` in
`ios/.xcode.env.local`). Without one the phase bundles as usual and says it
skipped the upload; `BUGSEE_UPLOAD_SOURCEMAPS=false` turns the upload off,
and a failed upload warns without failing the build. Debug builds skip it.

Native iOS frames come from the dSYMs. The config plugin adds an Archive
post-action that uploads them with `bugsee-cli xcode post-action`; a bare app
adds the same post-action to its scheme's Archive action.

## Troubleshooting

**`fmt`: "call to consteval function … is not a constant expression" (iOS,
React Native 0.81 and 0.82, Xcode 26.4 or later).** Not Bugsee: React Native
0.81 and 0.82 build `fmt` 11.0.2 from source, which newer Apple clang rejects
as C++20 ([fmtlib/fmt#4740](https://github.com/fmtlib/fmt/issues/4740)); 0.83
and later ship `fmt` 12 and are not affected. Build that one pod as C++17 from
the `post_install` in `ios/Podfile`, after `react_native_post_install(...)`,
then run `pod install` again:

```ruby
    installer.pods_project.targets.each do |target|
      next unless target.name == 'fmt'
      target.build_configurations.each do |config|
        config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
      end
    end
```

## Licence

Commercial. See [LICENSE](./LICENSE) and https://www.bugsee.com/terms.
