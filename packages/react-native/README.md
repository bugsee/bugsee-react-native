# @bugsee/react-native

Bugsee for React Native. Crash, error and bug reports carrying the video,
network traffic, console logs and traces that led up to them.

Wraps the native Bugsee SDKs — it is not a reimplementation — so a report from
a React Native app is the same report a native app produces, with the JS layer
added.

## Status: beta

This is a beta (`7.0.0-beta3`), built on the 7.x native SDKs, and the iOS SDK it
bundles is itself a beta. `latest` and `beta` both point at it for now, so a plain
`yarn add @bugsee/react-native` installs it; the `@beta` form in [Install](#install)
keeps following betas once a stable release exists. The API can still change
between betas.

It replaces `react-native-bugsee` (6.x), which stays on its own line. The two
are different packages with different APIs, not an upgrade in place: remove the
old one and follow this README.

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
yarn add @bugsee/react-native@beta
```

`npm install @bugsee/react-native@beta` and `pnpm add @bugsee/react-native@beta` work the
same way.

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
import Bugsee, { createDefaultLaunchOptions } from '@bugsee/react-native';

const options = createDefaultLaunchOptions();
options.captureLogs = true;

await Bugsee.launch('<your app token>', options);
```

`launch` and `relaunch` take the options object as is. They also accept the plain
`com.bugsee.option.*` map, for options you build or merge yourself; the object's
`BugseeLaunchOptions.serialize(options)` returns exactly that map.

`launch` resolves to whether the SDK started. It can decline — already
running, or a token the backend rejects — without that being an error worth
throwing on. Capture comes up asynchronously, so poll `getStatus()` rather
than assuming a resolved `launch` means recording has begun.

### Reporting render errors

Wrap part of the tree (or the whole app) in `<ErrorBoundary>` to report an error thrown while rendering
and show a fallback instead of an empty screen:

```tsx
import { ErrorBoundary } from '@bugsee/react-native';

<ErrorBoundary
  fallback={({ error, componentStack, resetError }) => (
    <ErrorScreen onRetry={resetError} />
  )}
  onError={(error, componentStack) => console.warn('render failed', error)}
  options={{ domain: 'checkout' }}
>
  <App />
</ErrorBoundary>
```

| Prop | |
|---|---|
| `fallback` | What to render after an error: an element, or a function that receives `error`, `componentStack` and `resetError()`. Without it the boundary renders nothing, so give it one. |
| `onError(error, componentStack)` | Called after the boundary has caught the error, and after it has reported it unless the error was already reported (see the list below). |
| `onReset(error, componentStack)` | Called when `resetError()` is called, just before the children render again. |
| `options` | Handled-exception options for the report. `{ domain }` only, as for `Bugsee.logException`. An invalid value logs a warning and the error is reported without options. |

What it does and does not do:

- The error is reported as a **handled** exception, with the React component stack attached as an extra
  (not as the error's `cause`).
- An error object the SDK has already reported is not reported again, so a boundary and
  `Bugsee.logException` (or the global handler) do not file the same error twice, unless it later ends the app as a crash. Deduplication applies to
  error objects only: a thrown string or number is never deduplicated.
- When `com.bugsee.option.detect.crash` is `false` the boundary reports nothing, as the global handlers
  do; it still shows the fallback and calls `onError`. (`Bugsee.logException` is an explicit call and
  always reports.)
- `children` is a plain React node. The function-as-children form from 6.x is not supported.
- Like any React error boundary it only catches errors thrown while **rendering**. Errors in event
  handlers, timers and promises are not caught by it; the global handlers `launch` installs report the
  uncaught ones.

### Exception capture: what to know

- **Render errors need `Bugsee.wrap`.** On React Native 0.81+ an uncaught render error never reaches
  `ErrorUtils`, so it is reported as a crash only when the app root is wrapped:
  `AppRegistry.registerComponent(name, () => Bugsee.wrap(App))`. An error boundary above the app
  that swallows the error hides it from Bugsee; put an `<ErrorBoundary>` below it, or call
  `Bugsee.logException` from your own boundary.
- **Log, then rethrow.** Deduplication is per error object and per kind. `Bugsee.logException(e)`
  followed by a rethrow that ends the app is still reported as a crash, and
  `Bugsee.logUnhandledException(e)` after `logException(e)` is reported. Once an error has been
  reported as a crash, no later report of it is sent. A report dropped because the SDK had not
  launched yet still counts as sent.
- **Unhandled promise rejections** are reported as handled errors, not crashes. Hermes has no getter
  for the active rejection tracker, so if another library installs one after `launch()`, the last
  one installed wins and Bugsee stops seeing rejections. Likewise Bugsee replaces any tracker installed
  before `launch()`, and chains only React Native's own dev-mode options.
- **iOS Simulator.** The Simulator slice of the iOS SDK has no crash reporter, and
  `logUnhandledException` does nothing there. Exercise crash capture on a device.

### Hiding a view from recordings

Wrap anything that must never be recorded in `<BugseeSecure>`:

```tsx
import { BugseeSecure } from '@bugsee/react-native';

<BugseeSecure>
  <Text>{accountNumber}</Text>
</BugseeSecure>
```

The part of it that is on screen is masked, and taps on it are dropped, while
it is mounted and `enabled` (default `true`). It follows scrolling, hidden
screens, react-native-screens push and pop transitions, sliding `<Modal>`s and
`Animated` transforms driven by the native driver, masking more rather than
less where it cannot tell exactly. `enabled={false}` unmasks at once; an
unmount keeps the mask for about half a second, as native may still draw the
view.

Known limits:

- Content that mounts in a pushed screen or an opening `<Modal>` after it
  came (behind a spinner), or that is first shown on the screen a pop
  uncovers, is masked for the rest of the transition. When a screen came or
  went is known only if a `<BugseeSecure>` saw it; otherwise the first one to
  look masks as if it happened then (the whole screen, or the Modal's band,
  for under a second).
- A value a native event drives (an `Animated.event` in an `Animated`
  component's `onScroll` or `onGestureEvent`, or `Animated.attachNativeEvent`,
  which React Native's own ScrollView uses for `stickyHeaderIndices`) moves
  with the scroll or the gesture. What it transforms is masked wherever it can
  be drawn, for as long as the event is attached, idle or not:
  - a clamped interpolation, one whose ends are flat (a swipeable row without
    overshoot), or a `diffClamp`: over its output range;
  - on Android, a ScrollView's `contentOffset`, vertical or horizontal (a
    collapsing or parallax header, a sticky header): over the offsets the
    ScrollView can reach, from its measured content and viewport, plus 64 dp
    either way for a fling's overrun (AOSP flings 6 dp past an end; the
    margin assumes no device flings more than ten times that). A view inside
    the content of the ScrollView whose offset drives it (a sticky header,
    from `stickyHeaderIndices` or a `SectionList`) moves with that content
    too, natively ahead of what JS measures: it is masked over that
    ScrollView's whole viewport;
  - anything else (a gesture's translation through an interpolation that
    extends, an iOS ScrollView, which bounces and can be scrolled anywhere by
    `scrollTo`, a ScrollView in another React root, or under a scale other
    than 1): the whole surface around it, cut by the clipping ancestors above
    it (a list's viewport, say).
- Native events are followed from when `@bugsee/react-native` is first
  evaluated: with Metro's `inlineRequires`, its first use. Import it (or call
  `Bugsee.launch`) at the top of `index.js` to follow them from the start.
  A value made native before then is masked as if anything could drive it,
  until JS next animates or sets it. A native event attached without
  `Animated` (code that calls React Native's native Animated module itself)
  is not seen at all, and the value it drives is taken to be where JS last
  had it.
- A transform animated from JS (`useNativeDriver: false`) is followed every
  frame while its animation runs. Other styles a JS animation moves (`top`,
  `left`, `margin`, a size) are followed by the 100 ms re-measure only.
- Reanimated runs its animations on the UI thread, out of JS's sight. A
  Reanimated component whose style sets a transform through an animated
  style, sets a shared value inline, or uses a CSS animation or transition
  masks the whole surface around it; other Reanimated motion (an animated
  style that adds a transform only later, layout animations,
  `entering`/`exiting`, shared element transitions) is not followed.
- An interactive back gesture (iOS swipe-back, Android predictive back) moves
  a mounted screen without anything JS can see.
- The mask is published in the same JS task that starts a native animation
  (or sets, resets or offsets an `Animated.Value`), but the two reach native
  separately: under heavy load the animation's first frame could still be
  drawn before the mask lands.

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

With the config plugin, no upload runs with a missing token or the placeholder token
(`00000000-0000-4000-8000-000000000000`, the version and variant digits
aside): the source-map upload, the Archive dSYM post-action and the Bugsee
Gradle plugin's mapping, symbol and build uploads each skip, with one line in
the build log (for the post-action: `warning: bugsee: dSYM upload skipped: the
app token is the placeholder`), and the build or Archive carries on. For
Android the plugin simply leaves the placeholder out of `bugsee.properties`.

### Self-hosted, staging or regional endpoint

```json
["@bugsee/react-native", { "appToken": "<token>", "endpoint": "https://bugsee.example.com" }]
```

`endpoint` is the API base: `https://`, a host, an optional port and path, and
no credentials, query, fragment or `/v2` (each reader adds the API version
itself). Anything else fails the prebuild. Unset, the default, everything stays
on Bugsee's production API. Set, it reaches every upload and the runtime:

- Android: `plugin.endpoint` in `android/bugsee.properties`, for the Gradle
  plugin's uploads and the source-map upload; `com.bugsee.reactnative.endpoint`
  application meta-data for the SDK.
- iOS: `BUGSEE_ENDPOINT` in the bundle phase (source maps) and in the Archive
  dSYM post-action; `BugseeReactNativeEndpoint` in `Info.plist` for the SDK.
- Runtime: `Bugsee.launch()` and `relaunch()` use it whenever their options
  carry no `endpoint`; an `endpoint` you pass yourself wins.
  `getLaunchOptions()` reads it back. With `autoLaunch` it is also written as
  the auto-launched SDK's `com.bugsee.option.$$ENDPOINT`, unless your manifest
  already has one, which is then left as it is.

Each of these is the plugin's own, so a later prebuild with a new value
replaces it, and one without `endpoint` removes it again.

The plugin's Gradle edits never remove or change a line of your own code, on a
clean or a `--no-clean` prebuild, however often it runs: it adds its own
marked lines, replaces only those, and rewrites exactly one of yours,
`react.hermesCommand`, with any trailing comment kept. Its own lines are
recognised only by their markers: the NDK dependency ends in `// bugsee:ndk`
(as does the opener of the `dependencies` block it adds when the file has
none). A `bugsee-android-ndk` dependency of your own, anywhere and however
written, is never touched: the plugin then adds none of its own and says so in
the prebuild log. The plugin writes no `debugSymbolLevel` (see
[Native symbols](#native-symbols-android)), and your own `ndk { }` block or
level is never touched. It inserts only at anchors that hold nothing but their
brace (`dependencies {`, `buildscript … }`, `pluginManagement {`,
`repositories {`; a trailing comment is fine), always as whole lines at your
indentation, and never splits a line. Where it cannot do that
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
  `dependencies { … }`, a `buildscript { … }; …`, a one-line
  `pluginManagement` or `repositories` block (with the option that needs that
  edit on);
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
    // reach the bytecode. React Native runs this command through cmd on
    // Windows, so Windows gets the .cmd launcher and macOS and Linux the .sh.
    // Keep it on one line: tools that apply this snippet read it as one.
    hermesCommand = new File(new File(bugseeDir, "scripts"), System.getProperty("os.name").startsWith("Windows") ? "hermesc-preserve-js.cmd" : "hermesc-preserve-js.sh").absolutePath
}

// At the end of the file. Applying it twice is harmless.
apply from: new File(new File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle")
```

The OS is checked when Gradle configures the build, so one `build.gradle`
works on macOS, Linux and Windows. Both launchers run
`scripts/hermesc-preserve-js.js` with `node`, which must be on the `PATH` (as
React Native's own bundling already needs). The wrapper exits non-zero when
hermesc writes no bytecode.

If Hermes compiles a bundle without going through the wrapper, the bundle
task fails rather than ship a release without a debug id. On Windows a
`hermesCommand` that names a `.sh` (what earlier versions of this README
said) fails the bundle task before hermesc runs, with the line to use
instead: `cmd` cannot run a shell script. With Hermes off, the plain JS
bundle and Metro's map get the id instead.

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
- **Expo.** `expo prebuild` writes the same per-OS choice. A `hermesCommand`
  that an earlier prebuild wrote (the `.sh` on every OS) is recognised by its
  exact text and moved to the per-OS one; a `hermesCommand` of your own that
  already names `hermesc-preserve-js` is left as it is.
- **Windows paths with spaces or brackets.** React Native runs
  `hermesCommand` through `cmd /c`, which cuts an absolute path holding a
  space together with `(` `)` (`C:\Program Files (x86)\…`), or `(` `)` alone
  (`C:\Users\John(US)\…`). On Windows the hook gives the launcher to React
  Native relative to the project root instead, as React Native gives its own
  paths; the build is verified from `C:\s (x86)\b rn`. A project whose path is long
  can still pass Windows' 260-character limit in React Native's own native
  build, which has nothing to do with Bugsee.
- **Limitations.** The hook has not yet been verified with Gradle's
  configuration cache.

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
needed for Bugsee ([Native symbols](#native-symbols-android)); set one only
for what Google Play should get.

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

### Native symbols (Android)

With `plugin.ndk.enabled=true` (the config plugin writes it for a real token
unless `nativeCrashReporting` is `false`), each Release build's
`uploadBugsee<Variant>Native` task uploads native symbols. Bugsee Gradle
plugin 4.0.8 and later read them from the **unstripped** libraries AGP leaves
in `build/intermediates/merged_native_libs/<variant>`, keyed by GNU build-id,
with `bugsee-cli` 0.8.1 or later (the plugin's own floor). That makes them
independent of `ndk.debugSymbolLevel`:

- every library that still has its debug info is uploaded with it, so crash
  frames get function names and `file:line`. That covers your own native
  code, and React Native's `libreactnative.so`, which the Maven
  `react-android` artefact ships with full DWARF. Libraries shipped stripped
  (Maven Hermes's `libhermesvm.so`, the Bugsee SDK's own) get their symbol
  table, function names only;
- an unchanged prebuilt library (`libreactnative.so`, `libc++_shared.so`) has
  the same build-id in every release, and the server keeps one copy; a copy
  stored earlier with function names only is upgraded to the full one;
- the symbols are a build artefact: nothing is added to the APK or AAB.

`debugSymbolLevel` is therefore **your app's own choice, for Google Play**
(what AGP packs into `native-debug-symbols.zip` and the AAB). The config
plugin writes none. Earlier versions of it wrote
`ndk { debugSymbolLevel 'SYMBOL_TABLE' }`, under a
`// bugsee-symbol-table:` comment, into the `debug` and `release` build
types; the next prebuild removes that block, recognised by its exact lines
only. A block you changed inside is yours: it is left as it is, and the
prebuild log says so. A level of your own is never touched.

The wrapper's own `@bugsee/cli` (source maps, dSYMs) is 0.7.12 or later.
If you pin the Gradle plugin's CLI yourself (`plugin.cliPath` or
`plugin.cliVersion`), use 0.8.1 or later: older CLIs do not read
`merged_native_libs`, and the plugin then falls back to AGP's
`native-debug-symbols.zip`, which depends on `debugSymbolLevel` (and
0.7.0–0.7.11 send nothing for a `SYMBOL_TABLE` zip, bugsee/bugsee-cli#61).

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
adds the same post-action to its scheme's Archive action (the example app's
scheme, `examples/bare/ios/BareExample.xcodeproj`, is the reference). Keep its
token check: without a real token the post-action must stop, exit 0, before
it runs `bugsee-cli`, which would otherwise register the build and send the
placeholder to your endpoint, or to production when none is set.

### React Native framework dSYMs (iOS)

React Native's prebuilt `React.xcframework` ships without dSYMs, so after an
Archive the `React` frames in a crash stay raw addresses (`React 0x10271dbc4`)
while your own and Bugsee's frames symbolicate. **Leaving this off means React
Native frames on iOS show as raw addresses.** React Native downloads the dSYMs
only when `pod install` runs with `RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1`:

```sh
cd ios && RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1 pod install
```

With it set, the Archive's `dSYMs/` folder includes React's dSYMs and the
post-action uploads them with the rest. A bare app has to export it wherever
it runs `pod install`, including CI.

The dSYMs are fetched together with the prebuilt `React-Core-prebuilt` pod, so
the variable does nothing for a pod that is already in `ios/Pods` (or in
CocoaPods' cache) from an earlier `pod install` without it: the log shows no
`Resolved stable dSYMs`, and the Archive has no `React.framework.dSYM`. On such
a machine remove the pod first and install again, from the app's root
directory:

```sh
rm -rf ios/Pods/React-Core-prebuilt
pod cache clean React-Core-prebuilt --all
(cd ios && RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1 pod install)
```

A fresh CI checkout is not affected. The check that it worked is the Archive's
`dSYMs/React.framework.dSYM`. With the Expo config plugin it is opt-in:

```json
["@bugsee/react-native", { "appToken": "…", "symbolicateReactNativeFrameworks": true }]
```

`expo prebuild` then adds `ENV['RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS'] ||= '1'`
to the top of `ios/Podfile` (Expo's Podfile reads only a fixed set of
`Podfile.properties.json` keys, so a property cannot do it), and a later
prebuild without the option removes the line again. A value you export
yourself, such as `0`, wins.

The trade-off: `pod install` makes an extra download (React Native's dSYM
tarballs). React Native fetches them in the same step as the prebuilt
framework itself, so a failed download drops the prebuilt React for that
install, and a failure while unpacking the dSYMs aborts `pod install`. That is
why the plugin leaves it off unless you ask. Apps that build React Native from
source already get its dSYMs.

Uploaded source maps list project files relative to the project root
(`/scenarios/staging.ts`), as Expo's do. The bundle phase and the Gradle hook
rewrite absolute `sources` before upload: under the project root they become
`/path/from/root`, and outside it (linked workspace packages in a monorepo)
`../path/from/root`. Entries that are already relative are left as they are. The map on disk is not changed and symbolication does not depend on
the strings.

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

**`TypeError: ExceptionOptions has unknown key "labels"` (or
`"includeVideo"`).** `Bugsee.logException` takes `{ domain }` only, as the
7.x native SDKs do, and throws on any other key before anything is sent.
Earlier betas accepted `labels` and `includeVideo`. Set labels from the
report handler instead. It has no per-call context: the labels it sets land
on every report it handles, not only on one `logException` call's.
`onAfterReportCreated` may run more than once, so set the labels rather than
append to them:

```ts
Bugsee.setReportHandler({
  onAfterReportCreated: report => report.setLabels(['checkout']),
});
```

The handler sees only the reports that reach JavaScript. An Android NDK
relaunch never does, and an iOS report recovered at launch is best-effort;
`BugseeReportHandler` has the details.

`includeVideo` has no replacement: neither SDK can leave the video out of a
single report.

## Examples

[`examples/playground`](https://github.com/bugsee/bugsee-react-native/tree/main/examples/playground) is a sample app with a button for every SDK API, a demo shop and a manual validation map.

## Licence

The React Native wrapper is MIT. See [LICENSE](./LICENSE). The native Bugsee SDKs it bundles (iOS and Android) are separate packages with their own terms.
