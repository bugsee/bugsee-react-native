/**
 * The endpoint override, which the two SDKs spell differently.
 *
 * iOS reads a plain `endpoint` key — not namespaced — and uses it VERBATIM as
 * the API base. Its own default is `https://api.bugsee.com/v2`, so a supplied
 * value must carry the version segment or every request loses it.
 *
 * Android reads `com.bugsee.option.$$ENDPOINT`, whose default base is
 * version-EXCLUSIVE (`https://api.bugsee.com`, with `/v2/<resource>` appended
 * per request). Its `apiUrl()` normalises either form, so the value passes
 * through untouched and a caller who supplied `/v2` is not punished for it.
 *
 * This is why one endpoint string from the caller becomes two different
 * payloads: the same value cannot be correct for both SDKs.
 */

/** Android's key. Namespaced, and one of the `$$` internal options. */
export const ANDROID_ENDPOINT_KEY = 'com.bugsee.option.$$ENDPOINT';

/** iOS's key. Deliberately NOT `com.bugsee.option.*` — the SDK reads it flat. */
export const IOS_ENDPOINT_KEY = 'endpoint';

const VERSION_SEGMENT = '/v2';

/** The payload for one platform, or `{}` when there is nothing to send. */
export function endpointFor(
  platform: 'ios' | 'android',
  endpoint: string | undefined,
): Record<string, string> {
  // Not `endpoint?.trim()`: the signature says string, but the call arrives
  // from untyped JS as often as from TypeScript, and a non-string would throw
  // here rather than being read as "no endpoint supplied".
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (trimmed === '') {
    // Not `{ key: '' }`: an empty override would replace the SDK's own
    // default with nothing rather than leaving it alone.
    return {};
  }

  if (platform === 'android') {
    return { [ANDROID_ENDPOINT_KEY]: trimmed };
  }

  // Strip a trailing slash first, so a value ending in "/" does not become
  // "…//v2" and one ending in "/v2/" is recognised as already versioned.
  const base = trimmed.replace(/\/+$/, '');
  return {
    [IOS_ENDPOINT_KEY]: base.endsWith(VERSION_SEGMENT)
      ? base
      : `${base}${VERSION_SEGMENT}`,
  };
}
