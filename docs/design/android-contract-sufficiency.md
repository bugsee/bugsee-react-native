# Is the Android wrapper contract sufficient for the React Native SDK?

**Question.** The Android contracts are the reference. Taking the React Native
SDK's committed public surface, and the bridging it requires: does everything
the Android wrapper contract provides — and the objects it hands us — let us
build it?

**Answer.** Outbound is sufficient with no gaps. Inbound is sufficient *as
signal*, but three constraints make parts of it unbridgeable to JavaScript as
the contract currently stands, and one contract is underspecified. None of
this blocks the phases we have left; two of them shape the API we expose.

Member lists below are extracted mechanically by `scripts/contract-members.ts`
rather than read by eye.

---

## 1. Outbound — what the RN SDK calls

Every phase of the implementation plan maps to a public `Bugsee` API. No gaps.

| Phase | RN surface | Android API |
|---|---|---|
| 1 | `launch` / `relaunch` / `stop` / `getStatus` | same |
| 2 | launch options, `setCustomOption` | `getLaunchOptions` (`OptionsContainer`), `getHostLaunchOptions` |
| 3 | wrapper registration | `setWrapper` |
| 4 | `log` / `event` / `trace` | same |
| 5 | attributes, user identity | `setAttribute`, `getAttribute`, `getAllAttributes`, `clearAttribute`, `clearAllAttributes`, `setUserIdentifier`, `getUserIdentifier`, `clearUserIdentifier` |
| 7 | `logException`, `logUnhandledException` | same, plus `onUncaughtException` |
| 8 | report dialog, manual reports | `showReportDialog`, `createReport`, `upload` |
| 9 | log / network filters, breadcrumbs | `setLogFilter`, `setLogEventFilter`, `setNetworkEventFilter`, `addBreadcrumb`, `setBreadcrumbFilter`, `addNetworkEvent`, `getExchangeFactory` |
| 10 | notify, APM | `notify`, `startSpan`, `getActiveSpan`, `startTransaction` |
| 11 | appearance, data deletion | `getAppearance`, `deleteCollectedDataOnDevice` |
| — | blackout | `startBlackout`, `endBlackout`, `isBlackout` |

### Secure rectangles: the wrapper hook is the only channel, and that is correct

`Bugsee.addSecureView`, `addSecureActivity` and `addSecureWebView` exist, and
are **unusable from React Native**. `PrivacyDisplayScope` says so directly:

> For a Flutter/RN/Unity app that hook is the ONLY channel available: the whole
> UI is one host view, so there is no secure View, fragment or FLAG_SECURE
> window to fall back on.

So `BugseeWrapper.getSecureRectangles` is the mechanism, which is what Task 3.3
implements. Worth recording that the set feeds the video mask, the report
screenshot **and** the input hit-test — the last was a fix, because a tap
inside a redacted region was previously still recorded with full coordinates.
Getting our rectangles wrong leaks coordinates, not just pixels.

---

## 2. Inbound — what the SDK calls on us

```
BugseeWrapper          getWrapperType getWrapperVersion getWrapperBuild getContext
                       onLifecycleEvent getSecureRectangles
DataRequestProvider    requestData
ReportHandler          onBeforeReportCreated onAfterReportCreated
```

Sufficient as signal. Three constraints on bridging it.

### 2.1 A terminating dispatch cannot consult JavaScript — structural

`TERMINATING_HANDLER_CAP_MILLIS = 3000`. On the terminating path the handler
runs on an already-alive background thread with a hard 3 s cap, while the
process is dying. A TurboModule round trip is not safe there: the JS thread may
be blocked or already torn down, and the SDK will not wait past its cap.

**Consequence for our API.** `onBeforeReportCreated(isTerminating: true)` must
be answered natively or not at all. Any JS-facing report handler we expose is
therefore best-effort and silently absent on exactly the reports — crashes —
that embedders care about most. That has to be documented as a property of the
API, not discovered.

### 2.2 `Report` does not marshal — the real gap

This is what "let embedders add attachments and update summary/description"
runs into. Most of `Report` crosses a bridge cleanly:

> `getId` `getType` `getSummary`/`setSummary` `getDescription`/`setDescription`
> `getEmail`/`setEmail` `getSeverity`/`setSeverity` attributes labels

Two do not:

- **Attachments.** Android is `Attachment.openStream() -> OutputStream`. There
  is no way to hand a JavaScript caller an `OutputStream`. The options are
  base64 through the bridge (a copy per attachment, on the main JS thread) or a
  file path. This is the concrete reason the **path-first** attachment model
  proposed by the Android session matters to us: it is the only shape that
  crosses a TurboModule without either buffering or inventing a stream in JS.
- **Screenshots.** `getScreenshot` / `setScreenshot` deal in `Bitmap` and
  `UIImage`. Same problem, same resolution: a path, or base64 with a size cost.

So we cannot hand JS a `Report`. We must expose a proxy — an opaque report
handle plus explicit operations — and the attachment and screenshot operations
need a file-path shape on both platforms before they can exist at all.

### 2.3 `requestData` is required, underspecified, and on a 500 ms clock

`requestData` is the one **required** behavioural method on the wrapper — no
`default` on Android, no `@optional` on iOS. The SDK asks for exactly one type
today, `"vh"`, from `ViewHierarchyBuilder`:

```java
dataRequestProvider.requestData("vh", data -> { ... });
BugseeHandlerWrapper.postDelayedToMainThread(timeoutRunnable, 500);
```

Three things follow, none stated in the contract:

1. The result is a **String** (`StringUtils.isNullOrEmpty(data)`).
2. There is a **500 ms timeout**, after which the subtree is dropped as null.
   A JS round trip that builds a view hierarchy has to beat that, from a cold
   JS thread, or the view hierarchy silently degrades.
3. **The payload format is nowhere in the contract.** It is written into the
   pass document's `subitems`. We cannot produce it correctly from the contract
   alone.

The contract's own documentation describes `requestData` generically —
"configuration information, user data, or system information" — which does not
describe its single real caller. This is the one place where the Android
contract is genuinely insufficient to implement against, and it is a
documentation gap rather than a missing capability.

---

## 3. What this changes

**Nothing blocks the remaining phases.** Tasks 3.2 and 3.4 proceed as planned.

**Two things shape the API we expose:**

- Our JS report handler is best-effort and does not run for terminating
  crashes (2.1). Documented, not discovered.
- A JS-facing `Report` is a proxy, and its attachment and screenshot
  operations are blocked on a path-based attachment model landing on both
  platforms (2.2). Until then, a JS embedder can set fields, labels and
  attributes but cannot add an attachment — which is one of the two things our
  user named as the point of the callbacks.

**One thing to ask the SDK teams for:** the `"vh"` payload format and its
500 ms budget, written into the `DataRequestProvider` contract. Every wrapper
that implements a view hierarchy needs it, and none of them can derive it.
