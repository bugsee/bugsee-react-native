import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type {
  EventEmitter,
  UnsafeObject,
} from 'react-native/Libraries/Types/CodegenTypes';

/**
 * The native surface. Codegen turns this into the C++/Java/ObjC++ spec both
 * bridges implement, so a change here is a change to three files.
 *
 * Launch options cross as `UnsafeObject` because they are an open map of
 * `com.bugsee.option.*` keys whose value types vary per option; the typed
 * model that produces the map lives in JS (Phase 2).
 */
export interface Spec extends TurboModule {
  /**
   * Lifecycle events the SDK announces to its wrapper.
   *
   * A codegen `EventEmitter`, not a `NativeEventEmitter`: verified to generate
   * real plumbing on the 0.81 floor, not merely to typecheck there --
   * `emitOnLifecycleEvent(ReadableMap)` on the Java spec base class and
   * `- (void)emitOnLifecycleEvent:(NSDictionary *)` on the ObjC one.
   *
   * `name` is the SDK's own name with the `com.bugsee.lifecycle.` prefix
   * stripped; both platforms dispatch BY NAME, so there is no per-platform
   * mapping to get wrong. `reportId` is present only for the events that
   * carry one.
   *
   * This is the ONLY event channel. Status transitions are derived from it in
   * JS rather than being a second emitter: Android exposes no status listener
   * at all (only `getStatus()`), and iOS's `bugseeDidChangeStatus:` belongs to
   * the app's own `BugseeDelegate` -- taking it would steal it from the app.
   * Deriving keeps one source, one mapping, and tests that cover both
   * platforms at once.
   */
  readonly onLifecycleEvent: EventEmitter<{ name: string; reportId?: string }>;


  /**
   * Registers the wrapper identity with the SDK.
   *
   * Separate from `launch` because both SDKs take the wrapper through
   * `setWrapper`, not through launch options, and because the identity is
   * gathered in JS — the React Native version, the engine and the build
   * configuration are JS-side facts. Call before `launch`: the SDK reads the
   * wrapper while building a report's environment.
   */
  setWrapperInfo(identity: UnsafeObject): void;
  /**
   * Publishes the regions the SDK must not record, for one display, as a flat
   * list of four-number rectangles: `[left, top, right, bottom, ...]`.
   *
   * Synchronous and fire-and-forget. The SDK PULLS these 2-3 times a second
   * from its own thread; a promise would put a JS round trip on a path that
   * has to answer immediately, and a rejected one would leave the caller
   * believing a region is redacted when it is not.
   *
   * An empty list clears the display's set.
   */
  setSecureRectangles(display: number, coordinates: number[]): void;

  /**
   * Suppresses everything that describes the screen: the video (black
   * frames), the report screenshot (black), touch/gesture recording and the
   * view hierarchy. Logs, network events, custom events and traces keep
   * recording throughout (design doc §4.1).
   *
   * Android ignores this before `launch()` resolves -- a logged no-op, not an
   * error -- while iOS honours it regardless of launch state. A caller that
   * needs blackout to hold on both platforms must call this after `launch()`
   * resolves.
   *
   * {@link isBlackout} verifies whether it actually took effect.
   */
  startBlackout(): void;
  /** Resumes everything {@link startBlackout} suppressed. */
  endBlackout(): void;
  /** The current blackout state, as {@link startBlackout} / {@link endBlackout} left it. */
  isBlackout(): Promise<boolean>;
  /** Captures the view hierarchy immediately, outside a normal snapshot pass. */
  captureViewHierarchy(): void;

  /**
   * The SDK's request for JS-side data, mid-capture. Only `'vh'` (the view
   * hierarchy) exists today; native answers any other `type` itself and never
   * emits this for it. `requestId` is native-minted and never reused within a
   * process. `originX`/`originY` are the React root's display origin --
   * Android display pixels, iOS points -- the same units `originTracker`
   * publishes for secure rectangles, and the frame the view-tree walk's
   * bounds are offset into (`src/viewtree/walk.ts`'s `WalkEnv`).
   *
   * `Task 6.4` (`src/viewtree/requests.ts`) is the only subscriber; `Task
   * 6.5`/`Task 6.6` are what actually emit it, from the same per-module event
   * bus every other emitter here goes through.
   */
  readonly onDataRequest: EventEmitter<{
    requestId: string;
    type: string;
    originX: number;
    originY: number;
  }>;
  /**
   * Answers one {@link onDataRequest} delivery. Called exactly once per
   * `requestId`, synchronously, whether or not there was anything to answer
   * with -- the SDK waits on this mid-capture. `payload` is JSON text for a
   * `'vh'` request that found something to walk, `null` for every other
   * outcome (an unmounted wrapper, an unrecognised `type`, or the walk
   * itself failing).
   */
  replyDataRequest(requestId: string, payload: string | null): void;
  /**
   * Turns view-hierarchy capture on or off. The wrapper calls this as
   * `Bugsee.wrap`'s anchor mounts and unmounts (`src/viewtree/requests.ts`):
   * on for the first mounted anchor, off once the last one unmounts, so the
   * SDK only asks for a `'vh'` {@link onDataRequest} while there is a
   * registered root to answer it from.
   */
  setViewTreeEnabled(enabled: boolean): void;

  launch(token: string, options: UnsafeObject): Promise<boolean>;
  relaunch(options: UnsafeObject): Promise<boolean>;
  stop(): Promise<boolean>;
  getStatus(): Promise<number>;
  /** The options the SDK reports as being in effect. */
  getLaunchOptions(): Promise<UnsafeObject>;
  testCrash(): void;

  /**
   * Creates and uploads a bug report immediately, without showing any UI.
   *
   * `severity` `0` is the SDK default (Android passes null; iOS resolves the
   * launch option, or High). `labels` `null` means none were given.
   * Fire-and-forget like `setSecureRectangles` -- the SDK assembles and
   * uploads the report from its own capture buffer in the background, so
   * there is nothing to await. Does nothing before `launch()`.
   */
  upload(
    summary: string,
    description: string,
    severity: number,
    labels: string[] | null,
  ): void;
  /**
   * Shows the bug-report dialog. Null summary and description, severity `0`
   * and null labels mean every argument was absent. Does nothing before
   * `launch()`. The dialog runs `onBeforeReportCreated` before it opens.
   */
  showReportDialog(
    summary: string | null,
    description: string | null,
    severity: number,
    labels: string[] | null,
  ): void;

  /**
   * Records a named event, with optional params.
   *
   * `paramsJson` is the params as JSON text (`src/bridge/json.ts`), not an
   * `UnsafeObject`: iOS's TurboModule object conversion drops every `null`
   * member, so `{ nil: null }` reached the SDK as `{}` there and as
   * `{ nil: null }` on Android. Both natives parse the text, which keeps it.
   * Text that does not parse as a JSON object drops the event, logged.
   *
   * `null` when JS sent no params (Android: `Bugsee.event(name)`; iOS:
   * `[Bugsee event:name params:nil]`) rather than `'{}'` -- the bundle's
   * `events.user` entry omits `params` entirely when none were given (design
   * doc, Phase 4 bundle facts), and a `{}` here would produce an empty object
   * on the wire instead. JS has already validated `params` against the
   * accepted value domain (`src/data/validate.ts`) and copied it, so nothing
   * unchecked reaches this call.
   */
  event(name: string, paramsJson: string | null): void;
  /** A numeric trace value, boxed on both platforms so it cannot arrive as a string. */
  traceNumber(name: string, value: number): void;
  /** A string trace value. */
  traceString(name: string, value: string): void;
  /**
   * A boolean trace value, kept a boolean across the bridge -- typed
   * separately from {@link traceNumber} so it cannot silently arrive as `0`
   * or `1` (Planner decisions, Phase 4).
   */
  traceBoolean(name: string, value: boolean): void;

  /**
   * One log line into the SDK's wrapper channel, attributed to the wrapper
   * (source `Custom`, no tag) rather than to the app's own `Bugsee.log`.
   *
   * `level` is the SDK's by-value level, 1 Error .. 5 Verbose, already
   * checked in JS; native maps anything else to Info. The line is filtered
   * natively by the app's log filter, once -- never in JS (design doc
   * §10.3). Fire-and-forget: before launch the channel accepts and drops it.
   *
   * Internal. `forwardLog` in `src/wrapper/channel.ts` is its only caller;
   * Phase 4's `log()` and Phase 9's console routing build on that, and must
   * not add a second native route.
   */
  wrapperLog(message: string, level: number): void;

  /**
   * Arms a native drop of the console echo of `message`, before that echo
   * is written. Android drops the later `ReactNativeJS` logcat line. iOS
   * drops a stderr stamp of `message`. It does not record a line, and a
   * `Bugsee.log` of the same text does not arm another drop.
   */
  noteConsoleEcho(message: string): void;

  /**
   * A network event the SDK is about to record, offered to the JS filter.
   *
   * `requestId` is native-minted and never reused within a process.
   * `eventJson` is the event (`setNetworkEventFilter`'s keep-value is the
   * event object on both SDKs, not a string). JS answers with
   * {@link replyNetworkFilter}. A request that never gets an answer is
   * dropped by the SDK; this event is not a second timeout that would pass
   * the original through.
   */
  readonly onNetworkFilterRequest: EventEmitter<{ requestId: string; eventJson: string }>;
  /**
   * Installs or removes the native network filter (`setNetworkEventFilter`
   * on both SDKs). `true` registers the bridge; `false` passes `null`, which
   * is how both SDKs clear a filter.
   */
  setNetworkFilterEnabled(enabled: boolean): void;
  /**
   * Answers one {@link onNetworkFilterRequest}. `eventJson` is the
   * replacement event to keep; `null` drops the event. A second reply for
   * the same `requestId` is a no-op. Not answering drops the event.
   */
  replyNetworkFilter(requestId: string, eventJson: string | null): void;
  /**
   * Records a network event the SDK did not capture.
   *
   * `eventJson` is the event (`url`, `method`, a stage name, and the fields
   * a network filter may rewrite). Native stamps the timestamp, builds the
   * event with the SDK exchange factory, and submits it with filtering
   * required. JS does not run the filter. A factory that makes no event
   * drops it, logged `addNetworkEvent dropped: the SDK made no event`.
   */
  addNetworkEvent(eventJson: string): void;
  /**
   * A log line the SDK is about to record, offered to the JS filter.
   *
   * `requestId` is native-minted and never reused within a process. `line`
   * is the text the SDK would store. JS answers with {@link replyLogFilter}.
   * A request that never gets an answer is dropped by the SDK's own timeout;
   * this event is not a second one.
   */
  readonly onLogFilterRequest: EventEmitter<{ requestId: string; line: string }>;
  /**
   * Installs or removes the native log filter (`setLogEventFilter` on both
   * SDKs). `true` registers the bridge; `false` passes `null`, which is how
   * both SDKs clear a filter. Lines are not filtered in JS as well.
   */
  setLogFilterEnabled(enabled: boolean): void;
  /**
   * Answers one {@link onLogFilterRequest}. `line` is the replacement to
   * keep; `null` drops the line. A second reply for the same `requestId` is
   * a no-op. Not answering drops the line — the SDK's timeout, not a reply
   * that passes the original through.
   */
  replyLogFilter(requestId: string, line: string | null): void;

  /**
   * Sets a string attribute, verified by a native read-back: neither SDK's
   * own setter reports a dropped value truthfully (design doc Phase 5,
   * "Planner decisions"), so this rejects `E_ATTRIBUTE_REJECTED` when the
   * value the SDK kept does not match what was just set -- the only way
   * iOS's byte-based archive size limit becomes observable to JS. `name` and
   * `value` are already validated (`src/attributes/validate.ts`); this never
   * rejects for a JS-side reason.
   */
  setAttributeString(name: string, value: string): Promise<void>;
  /**
   * A numeric attribute. Android stores a fractional or large value as a
   * 32-bit float, so a read-back can differ from what was set -- documented
   * on `Bugsee.setAttribute`, not treated as a rejection here.
   */
  setAttributeNumber(name: string, value: number): Promise<void>;
  /** A boolean attribute. */
  setAttributeBoolean(name: string, value: boolean): Promise<void>;
  /**
   * One attribute, read back from the SDK's persisted copy on Android --
   * `AttributeBridge.readOne`, the same copy `getAllAttributes` reads from
   * (so a fractional value already carries that copy's 32-bit-float
   * widening), not the SDK's own in-memory `Bugsee.getAttribute`, which only
   * `setAttribute`'s own verification step (`AttributeBridge.setAndVerify`)
   * reads.
   *
   * `{}` when absent, else `{ value }` -- never a bare value or `null`,
   * because `UnsafeObject` has no way to say "absent" other than omitting a
   * member.
   */
  getAttribute(name: string): Promise<UnsafeObject>;
  /**
   * Every attribute, from the persisted copy the report is built from --
   * where a fractional value is a 32-bit float, already widened back to a
   * `Double` the way the SDK's own JSON writer would (design doc Phase 5).
   * `{}` when none are set.
   */
  getAllAttributes(): Promise<UnsafeObject>;
  clearAttribute(name: string): Promise<void>;
  clearAllAttributes(): Promise<void>;
  /**
   * Sets the user identifier. Synchronous and never read back: no size limit
   * applies, and the bundle's `request.json` `email` is the device check
   * (design doc Phase 5). Never called with `''` -- JS maps that to
   * {@link clearUserIdentifier} instead, since both SDKs treat an empty
   * identifier as "no identifier" but only iOS treats setting one as a clear.
   */
  setUserIdentifier(identifier: string): void;
  /** `{}` when absent (including a native empty string), else `{ value }`. */
  getUserIdentifier(): Promise<UnsafeObject>;
  clearUserIdentifier(): void;

  /**
   * A report handoff, before or after the SDK builds it.
   *
   * `handleId` is opaque and native-minted, never reused within a process, and
   * scopes every `report*` call below to the ONE report this event announces
   * — a second delivery for the same `reportId` (an `after` phase can fire
   * more than once) gets its own handle. `phase` is `'before'` or `'after'`;
   * `type` is an open set (`'bug' | 'crash' | 'error'` today). `deadlineMs` is
   * the native deadline for THIS handle — JS marks the handle dead locally
   * once it passes, whether or not the app's callback has settled.
   */
  readonly onReportHandlerRequest: EventEmitter<{
    handleId: string;
    phase: string;
    reportId: string;
    type: string;
    deadlineMs: number;
  }>;
  /**
   * Tells the SDK which phases JS actually wants delivered. Called once per
   * `setReportHandler`, from the phases the handler defines — the SDK must
   * not pay to assemble a callback's worth of work for a phase nothing
   * listens to.
   */
  setReportHandlerPhases(before: boolean, after: boolean): void;
  /**
   * Acknowledges one handle, letting the SDK proceed. Called exactly once per
   * handle from JS, whether the app's callback resolved, rejected, threw, or
   * never settled before its deadline; a second call for the same handle is a
   * native no-op.
   */
  completeReportHandler(handleId: string): void;
  /** The live state of the report behind `handleId`, as a plain snapshot. */
  reportRead(handleId: string): Promise<UnsafeObject>;
  /**
   * Applies a validated patch to the report behind `handleId`. All-or-nothing
   * on both sides of the bridge: JS validates before crossing, and native
   * applies nothing unless every field in the patch is valid.
   *
   * `patchJson` is the patch as JSON text (`src/bridge/json.ts`): a `null`
   * summary, description or attribute means clear or remove, and iOS's
   * TurboModule object conversion dropped exactly those members, so on iOS
   * they silently did nothing. Text that does not parse as a JSON object
   * rejects with `E_REPORT_BAD_ARGUMENT`.
   */
  reportUpdate(handleId: string, patchJson: string): Promise<void>;
  reportAddFileAttachment(
    handleId: string,
    path: string,
    name: string,
    mimeType: string | null,
    move: boolean,
  ): Promise<void>;
  reportAddDataAttachment(
    handleId: string,
    base64: string,
    name: string,
    mimeType: string | null,
  ): Promise<void>;

  /**
   * Opens a report the app fills and then uploads. Resolves `'cr-<n>'`, or
   * `null` when the SDK made none. Rejects `E_REPORT_CREATE_BUSY` when one
   * created report is already outstanding.
   */
  createReport(): Promise<string | null>;
  /** The live state of the created report behind `handleId`, the `BugseeReportSnapshot` wire shape. */
  createdReportRead(handleId: string): Promise<UnsafeObject>;
  /**
   * Applies a validated patch, as JSON text, the same transport as
   * {@link reportUpdate}.
   */
  createdReportUpdate(handleId: string, patchJson: string): Promise<void>;
  createdReportAddDataAttachment(
    handleId: string,
    base64: string,
    name: string,
    mimeType: string | null,
  ): Promise<void>;
  /** No `move`: a created-report file attachment is copied. */
  createdReportAddFileAttachment(
    handleId: string,
    path: string,
    name: string,
    mimeType: string | null,
  ): Promise<void>;
  /** Uploads the created report. The handle is dead afterwards, whatever the result. */
  createdReportUpload(handleId: string): Promise<boolean>;

  /** A handled JS exception. `payloadJson` is the Task 7.1a payload; `optionsJson` is `{domain?, labels?, includeVideo?}` or null. */
  logException(payloadJson: string, optionsJson: string | null): void;
  /** An unhandled JS exception. Resolves once the SDK has the report; never rejects. */
  logUnhandledException(payloadJson: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Bugsee');
