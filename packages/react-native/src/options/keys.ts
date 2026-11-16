/**
 * The real `com.bugsee.option.*` keys each SDK accepts.
 *
 * Extracted from the SDK sources by `scripts/cli-extract-option-keys.ts` and
 * committed, because neither SDK publishes a manifest yet and CI has no SDK
 * checkout. Regenerate it rather than editing it by hand.
 */
import keys from './option-keys.json';

/** Accepted by both platforms — the great majority in 7.x. */
export const SHARED_KEYS: readonly string[] = keys.shared;
/** Accepted only by iOS; sending one to Android is a key it never agreed to. */
export const IOS_ONLY_KEYS: readonly string[] = keys.ios;
/** Accepted only by Android. */
export const ANDROID_ONLY_KEYS: readonly string[] = keys.android;

/**
 * Keys each SDK honours but does not declare where the extractor looks.
 *
 * Both are the endpoint override, and neither is in the generated fixture:
 * Android registers `$$ENDPOINT` directly in OptionsDescriptors.java with a
 * string literal rather than declaring it in the Options interface, and iOS
 * reads a flat `endpoint` out of the options dictionary
 * (`bgs_options()[@"endpoint"]` in BGSNetworkManager) rather than exposing a
 * BugseeOption constant. Listed here so the platform guard knows they are
 * legitimate, and so nobody "tidies" them away as typos.
 */
export const UNDECLARED_KEYS: Readonly<Record<'ios' | 'android', readonly string[]>> = {
  ios: ['endpoint'],
  // `$$DEBUG` and `$$WRAPPER` are internal: the wrapper owns them (it registers
  // itself as the wrapper), and an app has no business setting them.
  android: [
    'com.bugsee.option.$$ENDPOINT',
    'com.bugsee.option.$$DEBUG',
    'com.bugsee.option.$$WRAPPER',
  ],
};

export { NO_ACCESSOR } from './noAccessor';

/**
 * Options this package defines for itself: sent in the launch options, ignored by the native SDKs, and
 * acted on by the wrapper alone. Listing one here keeps the unknown-key warning quiet for it.
 *
 * The published-manifest check never complains about a key that is here or in an accessor and absent
 * from an SDK's manifest: it only complains about what an SDK publishes that this package lacks.
 */
export const RN_OPTION_KEYS: readonly string[] = [];

export function keysFor(platform: 'ios' | 'android'): ReadonlySet<string> {
  return new Set([
    ...RN_OPTION_KEYS,
    ...SHARED_KEYS,
    ...(platform === 'ios' ? IOS_ONLY_KEYS : ANDROID_ONLY_KEYS),
    ...UNDECLARED_KEYS[platform],
  ]);
}
