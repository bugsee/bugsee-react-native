# @bugsee/react-native-feedback

The in-app feedback chat for `@bugsee/react-native`. Apps that never show it
do not have to depend on this package.

## Requirements

The same as `@bugsee/react-native`: React Native 0.81 or later with the New
Architecture, iOS 15.0 or later, Android API 21 or later.

## Install

```sh
yarn add @bugsee/react-native @bugsee/react-native-feedback
```

No Expo config plugin. Autolinking adds `bugsee-android-feedback` on Android.
On iOS the podspec vendors the `bugsee/feedback-spm` sources for the same
`7.0.0-beta4` pin as the core SDK, and React Native 0.87 resolves that
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

The `feedback-spm` 7.0.0-beta3 SwiftUI chat hard-codes `Color.accentColor`
and `Color.gray` and does not read `BugseeTheme`, so that assignment does
not change the chat in this beta. The setter still stores the color on
`BugseeTheme`.
