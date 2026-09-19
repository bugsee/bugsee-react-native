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
}

export default TurboModuleRegistry.getEnforcing<Spec>('Bugsee');
