# Native API parity

Every public method of the Android `Bugsee` class (7.4.2) and the iOS `Bugsee` interface (7.0.x) is either exposed
by `@bugsee/react-native` or deliberately not, with a reason. The mapping is
[`scripts/sdk-api-map.ts`](../scripts/sdk-api-map.ts); `scripts/sdk-api.json` holds the SDKs' method names, and a test
fails when either side drifts (a method a new SDK release adds, an entry naming nothing, or a mapping pointing at an RN
member that does not exist). Regenerate the names with `scripts/cli-extract-sdk-api.ts`, pointing it at checkouts of the
versions in `native-versions.json`.

## Platform-specific calls

These exist in only one SDK. They are no-ops on the other platform, like `startBlackout` before launch is a no-op where
the SDK cannot honour it.

| Method | Android | iOS |
|---|---|---|
| `resetVideoCapturePermission()` | forgets the stored fullscreen-capture consent | no-op |
| `addSecureActivity(className)`, `removeSecureActivity(className)` | hides the activity from capture | no-op |
| `isSecureActivity(className)` | whether the activity is secure | `false` |
| `showVideoCapturePreview()`, `hideVideoCapturePreview()` | no-op | debug overlay of what video capture records |

## Not exposed, and why

| SDK method | Reason |
|---|---|
| `addSecureWebView` | needs a native WebView instance, which JavaScript never holds. Cover web content with `<BugseeSecure>` or `setSecureRectangles`. |
| `getAllSecureRectangles` | the wrapper owns the rectangles it publishes (`setSecureRectangles` replaces them); the SDK's list is not read back. |
| `ext`, `registerExt` | native extension lookup and registration. Extension SPIs (Leak's `watchObject`, the OkHttp interceptor) take native objects. |
| `getDefaultNetworkSanitizer`, `getExchangeFactory` | used inside the wrapper's own filter and event bridges. |
| `getVideoFrameConsumer` | SPI for wrappers that feed their own video frames; this one records natively. |
| `setWrapper`, `onUncaughtException`, `delegate`, `sharedInstance` | the wrapper's own plumbing. |
| `getLaunched`, `launched` | `await getStatus()` against `Status.Launched`. |
| `addSecureViews`, `setLogFilter` (Android) | deprecated in the SDK. |

`relaunch()` with no argument keeps the options the app supplied (it replays `getHostLaunchOptions()`); the native SDKs'
bare relaunch restarts with defaults.
