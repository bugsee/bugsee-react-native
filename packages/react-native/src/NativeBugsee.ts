import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { UnsafeObject } from 'react-native/Libraries/Types/CodegenTypes';

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
   * Registers the wrapper identity with the SDK.
   *
   * Separate from `launch` because both SDKs take the wrapper through
   * `setWrapper`, not through launch options, and because the identity is
   * gathered in JS — the React Native version, the engine and the build
   * configuration are JS-side facts. Call before `launch`: the SDK reads the
   * wrapper while building a report's environment.
   */
  setWrapperInfo(identity: UnsafeObject): void;
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
