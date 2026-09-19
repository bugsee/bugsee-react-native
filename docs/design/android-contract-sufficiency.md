# Is the Android wrapper contract sufficient for the React Native SDK?

**Question.** The Android contracts are the reference. Taking the React Native
SDK's committed public surface, and the bridging it requires: does everything
the Android wrapper contract provides — and the objects it hands us — let us
build it?

**Answer.** Yes, with one structural limitation and one thing to write down.

Outbound is sufficient with no gaps. Inbound is sufficient too, once three
things are understood:

- a **terminating** dispatch cannot consult JavaScript at all (2.1) — the only
  hard limitation here, and a property of our API rather than a defect;
- `Report` does not marshal, which costs the wrapper work but blocks nothing:
  the object maps to a JS proxy and attachments cross as file paths (2.2);
- `requestData`'s flows are undeclared even internally, so each wrapper derives
  them by reading SDK internals (2.3).

Nothing here blocks the phases we have left.

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

### 2.2 `Report` does not marshal — and does not need to

This is what "let embedders add attachments and update summary/description"
runs into. Most of `Report` crosses a bridge cleanly:

> `getId` `getType` `getSummary`/`setSummary` `getDescription`/`setDescription`
> `getEmail`/`setEmail` `getSeverity`/`setSeverity` attributes labels

Two do not, as values: attachments are written through
`Attachment.openStream() -> OutputStream`, and screenshots are `Bitmap` /
`UIImage`. You cannot hand either to JavaScript.

**This is not a blocker, and an earlier revision of this document wrongly said
it was.** The single-object contract is deliberate — one object encapsulating
the related logic, rather than primitives or maps that would produce
non-deterministic APIs and long argument lists — and it does not need to
change for us. Two things follow, and neither requires anything from the SDKs:

- **The object shape maps straight through.** We expose a JS report proxy: an
  opaque handle plus operations, mirroring `Report` rather than flattening it.
  That preserves the contract's intent on our side of the bridge instead of
  fighting it.
- **The stream never has to cross.** `openStream()` writes into storage the SDK
  owns and truncates on open. So a JS caller names a *file path*, and the
  wrapper does `createAndAddAttachment(name)` -> `openStream()` -> copy ->
  close, natively. Screenshots work the same way in reverse: JS supplies a
  path, the wrapper decodes to a `Bitmap`. On iOS it is more direct still,
  since `BGSAttachmentContract` already exposes `filePath`.

So a path-based JS attachment API is implementable **today**, on the contract
as it stands, entirely inside the wrapper. The path-first discussion between
the SDK teams is about *their* cross-platform parity, not a prerequisite for
ours.

What remains true is the cost we pay for the mismatch: the wrapper owns a copy
per attachment, and has to decide where a JS-supplied path may point. Both are
ours to handle.

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
describe its single real caller.

**This is deliberate and should stay that way.** `requestData` is an open,
*internal* contract between the SDKs and the wrappers, intentionally not tied
to a flow and intentionally not public API. The generic wording is the design,
not an oversight.

What is missing is the other half: the flows themselves are undeclared even
internally. A wrapper implementing `"vh"` has to derive the type string, the
`String` return, the 500 ms budget and the payload format by reading SDK
internals — which is how we learned all four. The fix is an internal registry
of flows: what types exist, what each expects back, and what budget it is held
to. Not documentation for users; a contract between us.

---

## 3. What this changes

**Nothing blocks the remaining phases.** Tasks 3.2 and 3.4 proceed as planned.

**Two things shape the API we expose:**

- Our JS report handler is best-effort and does not run for terminating
  crashes (2.1). Documented, not discovered.
- A JS-facing `Report` is a proxy that mirrors the object rather than
  flattening it, and its attachment and screenshot operations are path-based,
  implemented inside the wrapper (2.2). Nothing there is blocked.

**One thing to ask the SDK teams for:** an internal declaration of the
`requestData` flows — for `"vh"`, the payload format, the `String` return and
the 500 ms budget. Every wrapper implementing a view hierarchy needs all four,
and each currently derives them by reading SDK internals.
