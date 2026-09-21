# Bugsee cross-platform wrapper: implementation workbook

**Who this is for.** Anyone implementing or rewriting a Bugsee wrapper — Flutter,
Unity, .NET, Capacitor, Cordova, KMP — against the 7.x native SDKs. React Native
is the reference implementation; every step below was executed there, and every
trap was hit there first.

**How to use it.** Work top to bottom. Each step says what to do, why, and what
goes wrong. Do not skip Part 0: two of the longest detours in the reference
implementation were caused by starting at Part 2.

**Status.** Living document. Where a step depends on SDK work still in flight it
says so and names the issue.

---

## Part 0 — Orientation

### 0.1 Where the contracts live

| What | Where | Read it for |
|---|---|---|
| Cross-SDK specs | `github.com/bugsee/specs` (public) | The normative contracts |
| Options registry | `specs: sdk/options/` | Every `com.bugsee.option.*` key, types, defaults |
| Wrapper data requests | `specs: sdk/wrapper-data-requests/` | `requestData` flows: type strings, budgets, payloads |
| Embedder `Report` contract | `specs: sdk/report-contract/` | What an embedder may do to a report |
| Recovered-report identity | `specs: sdk/report-identity/` | `identity_source`, crash-across-update |
| Bundle format | `specs: sdk/reporting/bundle/` | What actually reaches the server |
| Android SDK | `github.com/bugsee/bugsee-android` | `library/src/main/java/com/bugsee/library/contracts/**` |
| iOS SDK | `github.com/bugsee/bugsee-cocoa` | `BugseeDev/BugseeLib/BugseeLib/BGSContracts.h` |

**The two files you will read most:** Android's
`contracts/internal/BugseeWrapper.java` and iOS's `BGSContracts.h`. Between them
they define the whole wrapper surface.

- [ ] **0.1.1** Clone `bugsee/specs`. Read `sdk/wrapper-data-requests/` and
      `sdk/report-contract/` end to end before writing code.
- [ ] **0.1.2** Clone both SDKs. You will need them: the specs are good but not
      complete, and several answers exist only in source.

### 0.2 Treat the SDK source as the reference, and the doc comment as a hint

The wrapper channel is an **internal** contract between the SDKs and the
wrappers. It is deliberately not public API, and several of its doc comments are
written generically on purpose.

**Trap.** Android's `DataRequestProvider` Javadoc describes "configuration
information, user data, or system information". Its single real caller asks for
one type, `"vh"`, expects a `String`, and discards the answer after 500 ms. None
of that is in the Javadoc.

- [ ] **0.2.1** When a contract is vague, find the caller. `grep` for the method
      in the SDK's own source before deciding what it means.
- [ ] **0.2.2** If you had to read source to implement a flow correctly, that is
      a spec gap — file it against `bugsee/specs`. The next wrapper pays the same
      cost otherwise.

### 0.3 Versions and floors

| Thing | Minimum | Why |
|---|---|---|
| Android SDK | **7.2.0** | `BugseeWrapper` and `setWrapper` |
| iOS SDK | **7.0.0-beta2** | Wrapper protocol implemented; `vh` flow shipped |
| Android Gradle plugin | **4.0.7** | 4.0.6 silently breaks every extension — see 1.4 |
| Android `minSdk` | **21** | The SDK's own floor; do not raise it |
| iOS deployment target | **15.0** | Forced by the toolchain, not by Bugsee |

- [ ] **0.3.1** Pick your host-framework floor from **download data**, not from
      the newest release. The reference implementation chose React Native 0.81
      because it covered ~83% of installs where the next version covered ~60%.
- [ ] **0.3.2** Record every pinned version in **one file** with provenance, and
      write a test that fails when a copy drifts. You will have at least four
      copies (dependency manifest, lockfile, podspec/equivalent, CI matrix).

---

## Part 1 — Before you write any wrapper code

### 1.1 Pin versions in one place

- [ ] **1.1.1** One machine-readable file holds every native version.
- [ ] **1.1.2** A test asserts every other copy matches it.
- [ ] **1.1.3** Verify the guard by changing one copy and watching the suite fail.
      A drift guard you have not seen fail is a guard you are trusting on faith.

### 1.2 Declare *all* the artefacts you need

**Trap, cost: half a day.** Native crash detection on Android is a **separate
artefact**. Declaring only `com.bugsee:bugsee-android` produces an SDK that looks
correctly integrated, builds green, and reports **no native crash at all**.

- [ ] **1.2.1** Android: declare `com.bugsee:bugsee-android-ndk` alongside the core.
- [ ] **1.2.2** Assert it at build level, not by inspection — a test that reads
      the dependency declaration and fails when the NDK artefact is missing.
- [ ] **1.2.3** Verify on a device: a real `SIGSEGV` must produce a report. The
      runtime tell is that **four** `libbugsee*.so` load on a cold start, not one.

### 1.3 Know which optional modules exist

`bugsee-android-{ndk,feedback,okhttp,ktor-2,ktor-3,cronet,compose,leak}`. Each is
opt-in and each is invisible when absent.

### 1.4 Android Gradle plugin: use 4.0.7 or later

**Trap, cost: a day, and it is not yours.** The plugin strips Bugsee extension
`<provider>` entries from the merged manifest and compensates by injecting each
extension's registration into `BugseeInitProvider.initializeExtensions()`. In
**4.0.6** the injection is skipped for R8-minified classes — and the published SDK
self-minifies — so the strip happens and the injection does not. Every extension
silently never registers.

- [ ] **1.4.1** Pin the plugin to **4.0.7+**.
- [ ] **1.4.2** Verify once on a device: `adb logcat | grep -oE "libbugsee[a-z-]*\.so" | sort -u | wc -l`
      → **1 is broken, 4 is fixed**. Use *distinct* library count, not occurrence
      count, and capture for ≥30 s — the crashpad handler is a separate process
      and logs later than the app.

---

## Part 2 — Register the wrapper before the SDK launches

**This is the most important step in the workbook, and the easiest to get wrong,
because the wrong version passes every test you would naturally write.**

### 2.1 Why

The SDK reads the wrapper while building a report's environment and while
dispatching report handlers. Both happen during `launch()`, including recovery of
a crash from the previous run. A wrapper registered from your managed runtime
(Dart, JS, C#, Kotlin/Native) is registered **too late** for all of it.

It fails **only on a relaunch after a crash** — the one run nobody exercises by
hand.

### 2.2 Android — a `ContentProvider` at `initOrder="200"`

Under auto-init the SDK launches from `BugseeInitProvider`, a `ContentProvider`,
which runs **before** `Application.onCreate` — before any app code at all. The
only thing that can run earlier is another provider with a higher `initOrder`.

- [ ] **2.2.1** Ship a `ContentProvider` in your AAR at `android:initOrder="200"`.
- [ ] **2.2.2** Extend `BugseeExtensionInitProviderBase`. It wires
      `BugseeContextProvider` before your body runs; without it, anything reading
      the global context sees `null` and degrades silently.
- [ ] **2.2.3** Call `Bugsee.setWrapper(...)` from `onExtensionCreate()`.

**Naming trap, and it is a landmine.** The Gradle plugin strips every provider
matching:

```
^.*\.Bugsee[A-Za-z0-9_]+InitProvider$
```

It checks **neither the package nor whether the injection target exists**, and the
injected call is swallowed by a catch-all. So a provider named
`BugseeWrapperInitProvider` is deleted from every customer's APK, on **every**
plugin version, with a green build and no warning.

- [ ] **2.2.4** Do **not** name your provider `Bugsee<Anything>InitProvider`.
- [ ] **2.2.5** Put the regex in a test so a change on the plugin side surfaces as
      a disagreement rather than a silent strip.

### 2.3 iOS — just register before `launch`

`+setWrapper:` is a plain singleton write with no launch dependency, and nothing
in the SDK clears it. There is no auto-init ordering problem.

- [ ] **2.3.1** Register from your native module's own construction, before
      `+launchWithToken:`.

### 2.4 Register identity natively, refine from the runtime later

What you can know without a runtime: wrapper **type** and **version** (compile-time
constants). What you cannot: host-framework version, engine, build configuration.

- [ ] **2.4.1** Register type + version natively at provider/module construction.
- [ ] **2.4.2** Replace with the full identity once the runtime is up.
- [ ] **2.4.3** Keep the type string in **one** place per platform and test that
      the native and managed copies agree. Two spellings register two different
      wrappers depending on how far start-up got.

---

## Part 3 — Identity

- [ ] **3.1** Implement `getWrapperType` / `getWrapperVersion` / `getWrapperBuild`
      / `getContext` (iOS: `wrapperType`, `wrapperVersion`, `wrapperBuild`,
      `context`).
- [ ] **3.2** `context` is `String → String` on both platforms. Drop non-string
      values rather than stringifying them.
- [ ] **3.3** Report `"unknown"` rather than an empty string for a missing fact.
      An empty version reads as "this wrapper has no version".
- [ ] **3.4** Pass identity in launch options too, where supported. iOS reads
      `wrapper_info` when no wrapper object exists. Android registers
      `com.bugsee.option.$$WRAPPER` for the same purpose (consumer wiring in
      flight — check before relying on it).

---

## Part 4 — Lifecycle events

- [ ] **4.1** Implement `onLifecycleEvent(name, data)`. Both SDKs dispatch **by
      name**, prefixed `com.bugsee.lifecycle.`. There is no per-platform enum to
      map, and iOS's `BugseeLifecycleEventType` is the *app-facing delegate*
      channel — not yours. Its raw values have been renumbered between releases.
- [ ] **4.2** Strip the prefix once, natively, so your managed payload matches
      your managed type.
- [ ] **4.3** **Forward an unrecognised name unchanged.** A newer SDK adding an
      event must reach a subscriber through an older wrapper. Silently swallowing
      it is how a whole feature goes missing with no error anywhere.
- [ ] **4.4** Events arrive **off the main thread** on both platforms.
- [ ] **4.5** Only these carry a report id: `Before/AfterReportAssembled`,
      `ReportAssemblyFailed`, `Before/AfterReportUploaded`, `ReportUploadFailed`,
      `ReportUploadFailedWithFutureRetry`.
- [ ] **4.6** Derive status transitions from this channel rather than seeking a
      second one. Android has **no** status listener, and iOS's
      `bugseeDidChangeStatus:` belongs to the app's own delegate — taking it
      steals it from the app. Only `Launching`/`Launched`/`Stopping`/`Stopped` are
      transitions; everything else must report no status change.

### 4.7 The event is not the thing

**Trap, cost: two wrong bug reports against two SDKs.**
`RelaunchedAfterCrash` comes from `ApplicationExitInfo`. It fires whether or not a
crash **report** exists. Reading it as proof of a report is how the reference
implementation concluded — wrongly, twice — that report handlers never run after a
restart.

- [ ] **4.7.1** Never treat a lifecycle event as evidence that a report exists.

---

## Part 5 — Secure rectangles

For a cross-platform app this hook is the **only** privacy channel that works.
`addSecureView` and friends are unusable: the whole UI is one host view, so there
is no secure view, fragment or `FLAG_SECURE` window to attach to.

The same set feeds the video mask, the report screenshot **and the input
hit-test** — a wrong rectangle leaks tap coordinates, not just pixels.

### 5.1 The buffer

`[version, count, l, t, r, b, ...]`, little-endian `int32`. Android returns
`int[]`; iOS returns `NSData`.

- [ ] **5.1.1** `r` and `b` are **exclusive**. Degenerate rectangles are ignored.
- [ ] **5.1.2** Round fractional edges **outward** (floor `l`/`t`, ceil `r`/`b`).
      Rounding to nearest leaves a sub-pixel strip visible along an edge — which
      is where text sits.

### 5.2 The version contract

The SDK **pulls** this 2–3 times a second and re-reads the rectangles only when
the version differs.

- [ ] **5.2.1** Any change **must** move the version. A stale version keeps
      redacting the old region and records the new one in the clear.
- [ ] **5.2.2** A no-op write must **not** move it, or the SDK re-reads every frame.
- [ ] **5.2.3** Version **per display** — the freshness comparison is per display.
- [ ] **5.2.4** Mutation-test it: hold the version constant across a change and
      confirm your tests fail.

### 5.3 Units — read this twice

**Trap, cost: a shipped privacy defect.** The two SDKs currently take **different
units**: iOS points, Android physical pixels. Most managed runtimes measure in
density-independent units, which equal iOS points and are **not** Android pixels.
Publishing unconverted values on a 3× Android device redacts **one third** of the
intended area — and still looks like it is working.

- [ ] **5.3.1** Scale to the target platform's unit **before** rounding outward.
      Rounding first reintroduces the sub-pixel gap.
- [ ] **5.3.2** Read the scale per call, not once. It changes with display
      configuration.
- [ ] **5.3.3** Write the platform check so a wrong value would fail — mock a
      non-1 scale on iOS, not 1, or the test passes whether or not the check exists.

> **In flight:** unification to physical pixels on both platforms and both
> wrapper channels is proposed on `specs` PR #20. Until it lands, convert per
> platform. When it lands, one rule covers both channels.

### 5.4 Ownership

- [ ] **5.4.1** Publish **immutable snapshots**. A buffer rewritten from another
      thread while the SDK reads it is a use-after-free.
- [ ] **5.4.2** Store the set **outside** the wrapper object. The wrapper is
      replaced mid-session when you refine identity; regions must survive that,
      or the app is recorded unredacted until it next republishes.

---

## Part 6 — Data requests (`requestData`)

`requestData` is the **one required behavioural method** on the wrapper — no
`default` on Android, no `@optional` on iOS.

- [ ] **6.1** Always answer. Silence costs the SDK the whole budget. An unknown
      type answers `null`. Never throw.
- [ ] **6.2** Only one flow exists today: **`vh`**, the managed view hierarchy.
- [ ] **6.3** Reply is a `String` (JSON), stored byte for byte. The SDK does not
      parse or redact it — **privacy is entirely yours**. No text content, no
      free-text labels on nodes the app marked secure. Watch your "stable
      identifier" field: it is the one people fill with user-visible text.
- [ ] **6.4** Budget is **500 ms**, timed from when `requestData` **returns**.
- [ ] **6.5** Called on the **main thread**. If your runtime is off the main
      thread, your reply is necessarily asynchronous — see 6.7.
- [ ] **6.6** `bounds` are `[x, y, width, height]` in **screen** coordinates, in
      the unit of that platform's native tree (see 5.3). Window-relative is wrong:
      they differ under split-screen and with an offset host view.

### 6.7 Asynchronous replies on Android

> **In flight.** Android records the whole view-hierarchy entry only inside the
> `requestData` callback, and the report snapshot closes when
> `onBeforeSnapshotCreated` returns. An async reply therefore lands in the **next**
> report. iOS waits, bounded. Fixed on `bugsee-android` PR #120.
>
> Until that merges, a wrapper whose runtime is off the main thread **cannot**
> implement `vh` correctly on Android — it will look broken when it is not.

---

## Part 7 — Report handlers

`onBeforeReportCreated` / `onAfterReportCreated` are how an embedder enriches a
report before it is sent: attachments, summary, description, labels, attributes.

### 7.1 `isTerminating` means process state

`true` → the process is in a terminal phase and will be killed when the method
returns; do the work **synchronously**. `false` → the platform is healthy;
asynchronous work is fine.

- [ ] **7.1.1** When `true`, do **not** round-trip to your managed runtime. The
      budget is ~3 s on a dying process and the runtime may already be gone.
- [ ] **7.1.2** Always call the completion callback. The pipeline waits on it;
      failing to call it stalls the report rather than merely skipping your
      contribution.

> **In flight.** iOS currently passes `isTerminating = YES` for reports recovered
> on the next launch — a healthy process — because the flag also selects a
> dispatch discipline. `bugsee-cocoa` #122.

### 7.2 Delivery is not once

- [ ] **7.2.1** `onBefore` is **at most once** and may be skipped entirely.
- [ ] **7.2.2** `onAfter` is **at least once** — make it idempotent.
- [ ] **7.2.3** Do not infer "this is a recovered crash" from `type` +
      `isTerminating`. The two platforms differ, and `type == crash` has several
      producers including a live `logException`.

### 7.3 Bridging `Report` to a managed runtime

`Report` is a single object by design. Do not flatten it.

- [ ] **7.3.1** Expose a **proxy**: an opaque handle plus operations, mirroring
      the object.
- [ ] **7.3.2** Strings, labels, attributes and severity cross a bridge cleanly.
- [ ] **7.3.3** Attachments and screenshots do **not**. Take a **file path** from
      your runtime and do the work natively — Android `openStream()` writes into
      storage the SDK owns, so the stream never has to cross.
- [ ] **7.3.4** A report is live only until your completion runs. A late
      mutation is silently absent, which is indistinguishable from failure.
- [ ] **7.3.5** Your handler's deadline is the **SDK's**, not yours. If your
      runtime is slow, the SDK completes without you and a late enrichment races.
      Do not promise your users otherwise.

### 7.4 Enum values cross by value, never by ordinal

- [ ] **7.4.1** Map every enum by its **internal value**. Ordinals differ and
      shift between releases.
- [ ] **7.4.2** Extract enum values from SDK source and test them; do not hand-write.
      `IssueSeverity` is `VeryLow=1, Medium=2, High=3, Critical=4, Blocker=5` on
      Android and `Low=1` with the same 2–5 on iOS — the **names** diverge at 1.
- [ ] **7.4.3** Compare enums across **both** platforms. A fixture extracted from
      one SDK cannot see a divergence in the other.

---

## Part 8 — Options

- [ ] **8.1** Keys are `com.bugsee.option.*`. Use the registry in
      `specs: sdk/options/`, not string literals.
- [ ] **8.2** **Endpoint is asymmetric**: iOS takes a flat `endpoint` key whose
      value includes the version; Android takes
      `com.bugsee.option.$$ENDPOINT` without it. Normalise in one place.
- [ ] **8.3** `getLaunchOptions` means different things: Android returns the
      merged set (defaults + overrides), iOS returns only what differs from its
      defaults. Do not present them as the same.
- [ ] **8.4** Hidden options (`$$ENDPOINT`, `$$WRAPPER`, `$$DEBUG`) must not
      appear in uploaded `sdk.options`.

---

## Part 9 — Verifying on a device

Most of the wrong conclusions in the reference implementation came from runs that
**looked valid while measuring something incapable of producing the answer**. Four
separate times. Every one would have been caught by an assertion about the
*experiment* rather than the result.

### 9.1 Assert the experiment before trusting the result

- [ ] **9.1.1** **Assert which build you are testing.** Print the SDK banner and
      match its commit SHA against what you expect. A version *string* is not
      enough: a version **range** in a dependency graph silently outranks a local
      `-SNAPSHOT` of the same version, and both call themselves the same thing.
- [ ] **9.1.2** **Assert the SDK actually launched** before drawing any conclusion
      from its absence.
- [ ] **9.1.3** **Assert the precondition you staged actually took.** If you
      deleted a file to reach a branch, confirm it is gone.
- [ ] **9.1.4** **Assert the event you were testing for happened** — e.g. the
      process really died of `signal 11`.
- [ ] **9.1.5** Put these in the **harness**, not in the run you happen to be
      thinking about. A guard that is not the default is one you will forget
      exactly when you are moving fast.

### 9.2 Distinguish absence from proof

A negative result is only evidence if the setup could have produced a positive.
Absence of a handler call, of a device in a listing, of a compile error in one
configuration — none of these mean what they look like.

### 9.3 Useful device recipes

- [ ] **9.3.1** **Native crash:** `adb shell run-as <pkg> kill -11 $(adb shell pidof <pkg>)`.
      Plain `adb shell kill` is not permitted for app processes.
- [ ] **9.3.2** **Retain a report bundle** instead of letting it upload: enable
      **airplane mode** before the relaunch (`adb shell cmd connectivity airplane-mode enable`).
      Prefer this to pointing the endpoint at a dead port — a dead port changes
      upload *timing*, which perturbs unrelated code paths.
- [ ] **9.3.3** **Read a bundle:** pull it from
      `files/bugsee_data/bundles/*.bundle.zip` via `run-as` and read `request.json`.
- [ ] **9.3.4** **Crash across an app update:** install N, crash, install N+1
      **without** wiping data, relaunch. Assert a *different* build on each half.
- [ ] **9.3.5** **Deobfuscate a stack** against the mapping from the exact build
      that produced it (`library/build/outputs/mapping/release/mapping.txt`), not
      a rebuild.

### 9.4 Reporting a finding to an SDK team

- [ ] **9.4.1** Separate what you measured from what you inferred.
- [ ] **9.4.2** Sample both arms equally before attributing a difference. One run
      per arm is not evidence.
- [ ] **9.4.3** State what you did **not** cover.
- [ ] **9.4.4** Withdraw promptly and in writing when the evidence does not hold.
      A team may already be acting on it.

---

## Appendix A — Traps, ranked by cost

| Trap | Symptom | Part |
|---|---|---|
| NDK artefact not declared | No native crashes at all; build green | 1.2 |
| Gradle plugin 4.0.6 | Every extension silently unregistered | 1.4 |
| Provider named `Bugsee*InitProvider` | Provider deleted from the APK | 2.2 |
| Wrapper registered from the managed runtime | Fails only on relaunch after a crash | 2.1 |
| Secure rectangles in the wrong unit | Redacts a third of the region on Android | 5.3 |
| Lifecycle event read as proof of a report | Two wrong bug reports | 4.7 |
| Enum mapped by ordinal or by name | Silently valid, wrong value | 7.4 |
| Async `vh` reply on Android | Entry lands in the next report | 6.7 |
| Version range beats local `-SNAPSHOT` | You test the wrong build | 9.1 |

## Appendix B — Minimum viable wrapper

The smallest wrapper that is correct rather than merely working:

1. Versions pinned in one file, with a drift guard (1.1)
2. NDK artefact declared and verified on a device (1.2)
3. Gradle plugin ≥ 4.0.7 (1.4)
4. Registered before launch, provider correctly named (2.2)
5. Identity: type, version, context (Part 3)
6. Lifecycle events forwarded, unknown names included (Part 4)
7. `requestData` answers — `null` is a valid answer (6.1)
8. Secure rectangles with the version contract and the right unit (Part 5)
9. Report handlers that always call completion and never block a dying process (7.1)

Parts 6.7, 7.3 and 8 can follow. Nothing above them can.
