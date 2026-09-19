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

## Licence

Commercial. See [LICENSE](./LICENSE) and https://www.bugsee.com/terms.
