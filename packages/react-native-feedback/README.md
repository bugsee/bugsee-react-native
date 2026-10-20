# @bugsee/react-native-feedback

The in-app feedback chat for `@bugsee/react-native`. Apps that never show it
do not have to depend on this package.

## Status: beta

At the same version as `@bugsee/react-native` (`7.0.0-beta3`); the npm `latest` and `beta` tags
both point at it for now. Install both with `@beta` to keep following betas. The two must be the
same release.

## Requirements

The same as `@bugsee/react-native`: React Native 0.81 or later with the New
Architecture, Hermes, iOS 15.0 or later, Android API 21 or later. Hermes is
required; JavaScriptCore (Hermes off) is not supported: React Native removed
JSC from core in 0.81, and the community package does not work with current
React Native.

## Install

```sh
yarn add @bugsee/react-native@beta @bugsee/react-native-feedback@beta
```

No Expo config plugin. Autolinking adds `bugsee-android-feedback` on Android.
On iOS the podspec vendors the `bugsee/feedback-spm` sources for the same
`7.0.0-beta7` pin as the core SDK, and React Native 0.87 resolves that
package through Swift Package Manager. There is no `spm_dependency`: that
helper does not embed the framework.

## Use

```ts
import {
  appearance,
  setGreeting,
  setListener,
  showFeedbackUI,
} from '@bugsee/react-native-feedback';

setGreeting('How can we help?');
setListener({
  onNewMessagesReceived(messages) {},
  onNewMessageSent(message) {},
});
showFeedbackUI();
```

Call these after `Bugsee.launch` has resolved. Android reaches the feature
through `Bugsee.ext(Feedback.class)`. iOS uses `BugseeFeedback.shared`.

## Appearance

`appearance` stores feedback colors. Android writes them with
`FeedbackAppearance` keys. iOS writes them onto `BugseeTheme`, which is the
published surface:

```ts
appearance.backgroundColor = '#112233';
```

The `feedback-spm` 7.0.0-beta6 SwiftUI chat paints its background with
`feedbackBackgroundColor`, and its e-mail screen (new in beta6, shown once
before the chat, as on Android) reads `feedbackEmailBackgroundColor`,
`feedbackEmailSkipColor`, `feedbackEmailContinueActiveColor` and
`feedbackEmailContinueNotActiveColor`. The message bubbles still hard-code
`Color.accentColor` and `Color.gray`, so the other colors are stored on
`BugseeTheme` but do not change the chat in this beta.

## Licence

The React Native feedback package is MIT. See [LICENSE](./LICENSE). The native Bugsee feedback SDKs it bundles (iOS and Android) are separate packages with their own terms.
