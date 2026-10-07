/**
 * Which endpoint the example app launches the SDK against.
 *
 * The committed credentials are placeholders: `credentials.json` holds the
 * all-zero UUID `00000000-0000-4000-8000-000000000000` for both platforms and
 * no endpoint. The real Bugsee server rejects that token, and the iOS SDK
 * then stores a stopped flag for it (`BugseeKilledSdkKey`) that refuses every
 * later launch until the app's container is wiped -- and each such launch is
 * a pointless contact with the real server. So a placeholder token never
 * reaches it: the app launches against the closed loopback port the e2e
 * already retains reports with (e2e/bundles.ts), where the SDK still reaches
 * Launched. A real token keeps the credentials' (or the scenario's)
 * endpoint.
 *
 * Plain TypeScript, no React Native import, so the rule is unit-tested
 * (scripts/__tests__/example-endpoint.test.ts).
 */

/** A closed port on the device's own loopback: every connection is refused at once. */
export const DEAD_ENDPOINT = 'https://127.0.0.1:9';

/**
 * Whether `token` is the placeholder: every hex digit zero, except that the
 * UUID's version and variant digits may be anything (`…-4000-8000-…` is
 * what write-credentials leaves).
 */
export function isPlaceholderToken(token: string): boolean {
  return /^0{12}[0-9a-f]0{3}[0-9a-f]0{15}$/i.test(token.replace(/-/g, ''));
}

export interface LaunchEndpoint {
  /** What to pass as the launch option; `''` means the SDK's own default. */
  readonly endpoint: string;
  /** Whether the placeholder rule chose it over what was asked for. */
  readonly forced: boolean;
}

/**
 * The endpoint to launch with. `requested` is the scenario's override, if
 * any; `configured` is the credentials' endpoint (`''` for the SDK default).
 */
export function launchEndpoint(token: string, requested: string | undefined, configured: string): LaunchEndpoint {
  const wanted = requested ?? configured;
  if (isPlaceholderToken(token)) {
    return { endpoint: DEAD_ENDPOINT, forced: wanted !== DEAD_ENDPOINT };
  }
  return { endpoint: wanted, forced: false };
}

/**
 * A url on `DEAD_ENDPOINT` for a request the e2e expects native network
 * capture to record. Through 7.0.0-beta4 the iOS SDK's release build dropped
 * every request whose url contained "bugsee", taking it for the SDK's own
 * traffic (`BGSNetworkInterceptionIsBugseeURL`); 7.0.0-beta5 tells its own
 * traffic apart by session instead (bugsee-cocoa #192) and records such a
 * request. Android never had the rule. The guard stays for the probes that
 * are about something else, so that none of them silently depends on that
 * word being recorded (or not) on one SDK version; the test of the word
 * itself builds its url with `bugseeNamedUrl`.
 */
export function deadEndpointUrl(path: string): string {
  const url = `${DEAD_ENDPOINT}/${path}`;
  if (/bugsee/i.test(url)) {
    throw new Error(`${url} contains "bugsee"; use bugseeNamedUrl for a request that is meant to carry it`);
  }
  return url;
}

/**
 * A customer request whose url deliberately contains the lowercase word
 * "bugsee" in both the path and the query, on `DEAD_ENDPOINT`. It exists for
 * the one test that asserts such a request IS recorded (bugsee-cocoa #192):
 * a host app's own endpoint may well look like that, and the SDK must not
 * mistake it for its traffic. `tag` keeps it distinct per run and must not
 * itself carry the word, so the word's presence is always this helper's doing.
 */
export function bugseeNamedUrl(tag: string): string {
  if (/bugsee/i.test(tag)) {
    throw new Error(`${tag} already contains "bugsee"; the helper adds it itself`);
  }
  return `${DEAD_ENDPOINT}/bugsee-e2e-named/${tag}?client=bugsee&tag=${tag}`;
}
