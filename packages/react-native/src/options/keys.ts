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

export function keysFor(platform: 'ios' | 'android'): ReadonlySet<string> {
  return new Set([
    ...SHARED_KEYS,
    ...(platform === 'ios' ? IOS_ONLY_KEYS : ANDROID_ONLY_KEYS),
  ]);
}
