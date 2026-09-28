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
  launch(token: string, options: UnsafeObject): Promise<boolean>;
  relaunch(options: UnsafeObject): Promise<boolean>;
  stop(): Promise<boolean>;
  getStatus(): Promise<number>;
  /**
   * The options the SDK reports as being in effect.
   *
   * The two platforms do NOT agree on what this means, and the difference is
   * visible to callers: Android returns the merged set — its own defaults with
   * the app's overrides on top, valid even before launch — while iOS returns
   * only the options that differ from its defaults, so its defaults are not
   * reachable at all. See `refreshFrom` in the options model.
   *
   * The iOS half is tracked by bugsee/bugsee-cocoa#100; when it lands, this
   * note and the ones it points at should go.
   */
  getLaunchOptions(): Promise<UnsafeObject>;
  testCrash(): void;

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
   */
  reportUpdate(handleId: string, patch: UnsafeObject): Promise<void>;
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
}

export default TurboModuleRegistry.getEnforcing<Spec>('Bugsee');
