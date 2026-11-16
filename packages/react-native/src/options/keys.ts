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

/**
 * Keys an SDK registers that have NO first-class accessor on purpose. The
 * coverage test requires every known key to have an accessor or an entry here
 * with a reason, so a new SDK option cannot be silently left unreachable.
 *
 * Keys whose accessor has a different shape than "one setter, one key" (the
 * endpoint override) are covered by {@link UNDECLARED_KEYS}.
 */
export const NO_ACCESSOR: Readonly<Record<string, string>> = {
  'com.bugsee.option.config.data-encryption':
    'declared in the iOS SDK\'s private header (BGSOptionsPrivate.h), not its public API',
  'com.bugsee.option.$$DEBUG': 'internal',
  'com.bugsee.option.$$WRAPPER': 'internal; the wrapper registers itself',
  'com.bugsee.option.$$ENDPOINT': 'reached through the `endpoint` accessor',
  endpoint: 'reached through the `endpoint` accessor',
};

export function keysFor(platform: 'ios' | 'android'): ReadonlySet<string> {
  return new Set([
    ...SHARED_KEYS,
    ...(platform === 'ios' ? IOS_ONLY_KEYS : ANDROID_ONLY_KEYS),
    ...UNDECLARED_KEYS[platform],
  ]);
}
