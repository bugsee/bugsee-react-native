# Manual validation map

One row per manual check. Use it with a Release build of the playground that
has symbols uploaded (see [README.md](./README.md)).

- "Your Bugsee instance" means the dashboard your app token belongs to.
- Tabs and section names are those shown in the app. Buttons are written in bold.
- Option keys are the ones Setup → **Advanced options** shows (without the
  `com.bugsee.option.` prefix). To set one: Setup → **Advanced options** → **Show options**,
  filter by name, type the value, tap **Launch**. Relaunch the app (close it, open it)
  where a row says so, so the option applies from the start.
- Platform: A = Android, B = iOS, C = both. Keys marked (Android) or (iOS) exist
  only on that platform.
- Known issues are listed in the README. A row names the one it touches.

| ID | Platform | Where | Action | Expected | Where to look (dashboard) | Known issue |
|---|---|---|---|---|---|---|
| M-A1 / M-B1 | Android / iOS | Reports → Report | Tap **Show report dialog (prefilled)**, then **Send** | One report with the prefilled summary (`Playground report`) and description (`Prefilled description`) | Your Bugsee instance → Issues → newest report | |
| M-B2 | iOS | Reports → Report, then Home → Status | Tap **Show report dialog (prefilled)**, then Cancel. Open Home | Home lifecycle shows `AfterReportShown`. No new report | Issues: no new report | |
| M-A3 / M-B3 | Android / iOS | Setup → Advanced options | Set `reporting.ui.summary-required`, `description-required`, `email-required` and `labels-required` to `true`, tap **Launch**. Reports → Report → **Show report dialog (empty)**. Tap Send with empty fields (refused). Fill `x`, `x`, `a@b.co`, label `l1`, tap Send | Send is refused while empty. The report carries all four values | Issues → newest report: summary, description, e-mail, label | |
| M-B3 (cont.) | iOS | Setup → Advanced options | Also set `reporting.ui.labels-enabled=false` and `reporting.ui.priority-selector-enabled=false`, relaunch, **Show report dialog (empty)** | The labels field and the priority selector are hidden | | |
| M-B3 (style) | iOS | Setup → Advanced options | Set `reporting.ui.style` (iOS), relaunch, **Show report dialog (empty)**, take a screenshot | The dialog uses the chosen style | | |
| M-A4 / M-B4 | Android / iOS | Any tab | Default options (`reporting.triggers.shake` on). Shake the device | The report dialog opens. Back / Cancel closes it | | |
| M-A5 / M-B5 | Android / iOS | Setup → Advanced options | Set `reporting.triggers.screenshot=true`, relaunch, take a hardware screenshot | The report dialog opens | | |
| M-A6 | Android | Setup → Advanced options, then Reports → Report | Set `capture.video.mode=20` (Fullscreen, Android), relaunch. At the prompt tap "Start now". Go to the Home screen of the phone, wait 10 s, reopen. Reports → **Upload report (no UI)**. Then relaunch: no prompt. Set `capture.video.fullscreen-remember-decision=false` (Android), relaunch, Cancel at the prompt, then **Upload report (no UI)** | The video shows the status bar and continues across the background. No prompt on the second launch. After Cancel the app keeps running and Upload works | Issues → report → video | |
| M-A7 | Android | Setup → Advanced options | Set `reporting.triggers.notification-bar=true` (Android), relaunch, pull down the notification shade, tap the Bugsee notification | The report dialog opens | | |
| M-A8 / M-B6 | Android / iOS | Reports → Feedback | Fresh install (Android: clear the app's storage. iOS: delete and reinstall). Launch from Setup. Tap **Set greeting**, then **Show feedback UI** | The e-mail screen appears. Skip it and the chat opens. iOS shows the greeting. Android does not show the greeting ([bugsee-android#245](https://github.com/bugsee/bugsee-android/issues/245)) | Feedback in your Bugsee instance | android-245 |
| M-B7 | iOS | Setup → Advanced options | Set `capture.video.privacy-blur=true` (iOS), relaunch. Open the app switcher for 3 s, go back. Reports → **Upload report (no UI)** | Blurred frames in the video | Issues → report → video | |
| M-A10 / M-B9 | Android / iOS | Setup → Advanced options, then Privacy → BugseeSecure | Set `detect.frustration=true`, relaunch. Tap the "This box is redacted" box 6 times within 2 s (it does nothing). Reports → **Upload report (no UI)** | A frustration event in the report | Issues → report → events | |
| M-A11 | Android | Reports → Report, then Reports → Feedback | **Show report dialog (prefilled)**: press and hold Send for 3 s, take a screenshot. **Show feedback UI**: on the e-mail screen hold Continue, then Skip, take a screenshot each | Pressed colours are visible | | |
| M-C1 | Android / iOS | Reports → Feedback | **Set feedback listener**, **Show feedback UI**, send `campaign <nonce>`. Reply from the dashboard. Then **Clear feedback listener** and reply again | The feedback log shows the sent and received messages. After clearing, no new lines | Feedback in your Bugsee instance | |
| M-C2 | iOS | Reports → Report | Airplane Mode on, tap **Upload report (no UI)**, Airplane Mode off (and once more during the upload) | Exactly one issue arrives | Issues: one new report | cocoa-223: the trigger shows as unknown |
| M-C3 | Android / iOS (data SIM only) | Setup → Common options | Turn **Upload on Wi-Fi only** on, launch, Wi-Fi off, Reports → **Upload report (no UI)**. Wait 2 min. Wi-Fi on | Nothing arrives while Wi-Fi is off. It arrives after Wi-Fi is on | Issues | |
| M-C4 | Android / iOS | Home → Demo shop → Checkout | Run the shop to Checkout, choose **Bug**, tap **Pay**, reopen the app. Open the crash | The video plays. Console lines and network events are listed. The RN view tree renders. Attributes (`cart_items`) and the user id are shown. The JS stack is symbolicated | Issues → the crash | |
| M-C5 | iOS | Xcode | `npx expo prebuild -p ios`, open `ios/BugseePlayground.xcworkspace`, Product → Archive. Then Organizer → Generate Privacy Report | The Report navigator shows the dSYM upload post-action. The privacy report has Bugsee's entries | Symbols in your Bugsee instance | |
| S-1 | Android / iOS | Every tab | Open Home, Capture, Privacy, Errors, Reports, Data, Perf | Each tab renders | | |
| S-2 | Android / iOS | Home → Demo shop | Walk through products, sign in, product detail, checkout with **Success** | The flow completes | Performance: the `checkout` transaction | |
| S-3 | Android / iOS | Errors → Crashes | Tap **JS crash**, reopen. Tap **Native crash (SDK test)**, reopen. On Android also tap **Native crash: segv (NDK)**, reopen | Each crash is recovered and sent at the next launch | Issues: three crashes | |
