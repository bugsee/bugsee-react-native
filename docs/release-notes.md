# Release notes

Newest first. The npm packages `@bugsee/react-native` and `@bugsee/react-native-feedback` always ship at
the same version. Each version also has a GitHub release with the packed tarballs and the generated list
of merged pull requests.

## 7.0.0-beta5

Native SDKs: **Android 7.6.0** (Gradle plugin **4.1.1**), **iOS 7.1.0**. npm dist-tags `beta` and `latest`.

### Gradle plugin 4.1.1

The package now builds against Bugsee Gradle plugin 4.1.1 (it was 4.0.8). This is what the Expo config
plugin declares by default and what the README tells bare apps to apply.

- The plugin requires **AGP 8.6 or newer and Gradle 8.7 or newer** (Gradle 9 is supported) and fails
  early with a readable message otherwise.
- Native symbols are still uploaded from the unstripped libraries, and an upload that did not change is
  skipped on the next build.
- Opt in to failing the build when an upload does not complete with `failOnUploadError` in the `bugsee { }`
  block.
- Uploads honour the JVM proxy settings, secrets such as the app token stay out of build logs, and the
  plugin falls back to an installed `bugsee-cli` when the download fails.

If you pin the plugin yourself, use 4.1.1: `id 'com.bugsee.android.gradle' version '4.1.1' apply false`.

## 7.0.0-beta4

Native SDKs: **Android 7.6.0** (Gradle plugin 4.0.8), **iOS 7.1.0**. npm dist-tags `beta` and `latest`.

### Behaviour changes to check before upgrading

- **Shake-to-report is off by default** on both platforms (`triggerByShake`, iOS 7.1.0 and Android 7.6.0).
  Set `options.triggerByShake = true` to keep it.
- **The notification-bar trigger is off by default on Android** (`triggerByNotification`, Android 7.6.0).
  Set it to `true` to keep it.
- **`crashSignals` is now a shared option.** Both SDKs register `com.bugsee.option.capture.crash-signals`
  (same bit layout: ABRT 1, SEGV 2, BUS 4, ILL 8, FPE 16, TRAP 32). The default is 128, the "let the SDK
  choose" bit, which means every signal only when it is the whole value; combined with other bits it is
  dropped and only the signal bits count. The accessor moved from the iOS-only options class to the shared
  one, so it is now available on Android too. On Android it is read once, when the native handler is armed.
- The bundled iOS SDK is now a stable release (7.1.0), no longer a beta.

Launch options were synchronized from the option manifests the two SDKs published for these versions;
[`launch-options.md`](launch-options.md) is regenerated from them.

### Since 7.0.0-beta3

Native SDKs and options
- Adopt iOS SDK 7.0.0 (#182), then 7.1.0, and Android SDK 7.6.0 (#194).
- A typed accessor for every option either SDK registers (#189).

Reporting and capture
- Exceptions: `ErrorBoundary` honours `detect.crash`, and a crash after a handled report is kept (#156).
- Spans: status is synced after finish, and open JS spans are cancelled on reload (#154).
- iOS: an active blackout ends on `stop()`, matching Android (#153); e2e coverage for blackout across
  `stop()` and relaunch (#165).
- `deleteCollectedDataOnDevice` exposes `includingFinishedReports`, and iOS resolves with the real
  outcome (#157).
- Android: a warning at launch when Bugsee's OkHttp interceptor is missing (#158).

Filters and privacy
- Log, network and breadcrumb filters fail closed on a 9 s deadline (iOS log/network/breadcrumb, Android
  breadcrumb) (#160), and after a JS reload until the new runtime installs its filter (#161).
- Auto-launch: an opt-in fail-closed filter hold at process start (#162).
- Breadcrumbs: an opt-in URL scrubber for http crumbs (#164).
- Network filter scope and per-platform built-in redaction are documented (#159).

Build and tooling
- dSYM token read from `.xcode.env.local`, `editGradleFiles` for Kotlin projects, and a strip
  `sourcesContent` option (#155).
- Expo plugin removes the `com.bugsee.app-token` it wrote earlier when `autoLaunch` is off (#152).
- The `launch` comments now say an already-running SDK resolves `true` (#150).
- Dependency refresh for vulnerable transitives (#185); CI and release-pipeline fixes (#163, #166, #192).

## 7.0.0-beta3

Native SDKs: Android 7.4.2 (Gradle plugin 4.0.8), iOS 7.0.0-beta7. Releases are packed with `npm pack`, so
the shell scripts keep their executable bit (beta1 and beta2 shipped `bugsee-xcode.sh` and
`hermesc-preserve-js.sh` as 0644, which broke Release bundles; #131, #132).
