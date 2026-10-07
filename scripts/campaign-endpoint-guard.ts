/**
 * The beta campaign's endpoint guard (plan N-30, item S-0).
 *
 * Two modes, and nothing else may reach a device:
 *   offline  (the default) the placeholder token and the dead loopback
 *            endpoint `https://127.0.0.1:9`: nothing leaves the device.
 *   staging  (`E2E_STAGING=1`, lane STAGING only) a real token and exactly
 *            `https://apidev.bugsee.com`.
 * Production -- `api.bugsee.com` in any spelling, or any other Bugsee host --
 * is refused in both, and so is anything the guard cannot read.
 *
 * Pure: the harness (examples/bare/e2e/harness.ts) applies it to the app's
 * own `BUGSEE_E2E scenario=...` line at every launch, and
 * scripts/cli-campaign-guard.ts applies it to an app's credential files
 * before a build. Neither ever prints a token: the reasons here name the
 * token's kind, never its value.
 */

export type CampaignMode = 'offline' | 'staging';

export const DEAD_ENDPOINT = 'https://127.0.0.1:9';
export const STAGING_ENDPOINT = 'https://apidev.bugsee.com';

/** `E2E_STAGING`: unset or `0` is offline, `1` is staging; anything else throws. */
export function parseCampaignMode(raw: string | undefined): CampaignMode {
  if (raw === undefined || raw === '' || raw === '0') {
    return 'offline';
  }
  if (raw === '1') {
    return 'staging';
  }
  throw new Error(`E2E_STAGING must be "1" or "0", got ${JSON.stringify(raw)}`);
}

export interface GuardResult {
  readonly ok: boolean;
  readonly reason: string;
}

const PASS: GuardResult = { ok: true, reason: 'ok' };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

/**
 * Whether `text` names Bugsee's production API in any form: the host
 * `api.bugsee.com` (any case, trailing dot, port, path, scheme or none), or
 * that string anywhere in the text.
 */
export function namesProduction(text: string): boolean {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Not percent-encoded text: the raw form is all there is.
  }
  return [text, decoded].some(form => PRODUCTION.test(form));
}

/** `api.bugsee.com` not preceded by a host character: `apidev.` and `xapi.` are other hosts. */
const PRODUCTION = /(^|[^a-z0-9.-])api\.bugsee\.com(?![a-z0-9-])/i;

/** The endpoint as `launch()` was given it, and whether its token is the placeholder. */
export interface LaunchFacts {
  /** `default` when the SDK's own endpoint was left in place. */
  readonly endpoint: string;
  readonly token: 'placeholder' | 'set';
}

/**
 * Whether a launch may go ahead in `mode`. `default` (the SDK's own
 * endpoint, which is production) is refused in both modes.
 */
export function checkLaunch(mode: CampaignMode, facts: LaunchFacts): GuardResult {
  const endpoint = facts.endpoint.trim();
  if (endpoint === 'default' || endpoint === '') {
    return fail("the SDK's default endpoint (production) was left in place");
  }
  if (namesProduction(endpoint)) {
    return fail('the endpoint names the production API');
  }
  if (mode === 'offline') {
    if (facts.token !== 'placeholder') {
      return fail('a real token outside the staging lane (E2E_STAGING is not 1)');
    }
    if (endpoint !== DEAD_ENDPOINT) {
      return fail(`offline mode launches only against ${DEAD_ENDPOINT}`);
    }
    return PASS;
  }
  if (endpoint !== STAGING_ENDPOINT) {
    return fail(`staging mode launches only against exactly ${STAGING_ENDPOINT}`);
  }
  if (facts.token !== 'set') {
    return fail('staging mode with the placeholder token: nothing would reach staging');
  }
  return PASS;
}

/** The app's own launch line: `BUGSEE_E2E scenario=... token=<kind> endpoint=<e>`. */
export function launchFactsOf(line: string): LaunchFacts | undefined {
  const match = / token=(placeholder|set) endpoint=(\S+)/.exec(line);
  if (match === null) {
    return undefined;
  }
  return { token: match[1] as LaunchFacts['token'], endpoint: match[2]! };
}

/** Same rule as examples/bare/endpoint.ts `isPlaceholderToken`. */
export function isPlaceholderToken(token: string): boolean {
  return /^0{12}[0-9a-f]0{3}[0-9a-f]0{15}$/i.test(token.replace(/-/g, ''));
}

/** What an app's credential files hold, as the build and the app will read them. */
export interface CredentialFacts {
  /** credentials.json: `ios`, `android`, `endpoint`. */
  readonly json?: { readonly ios?: unknown; readonly android?: unknown; readonly endpoint?: unknown };
  /** android/bugsee.properties text, if present. */
  readonly properties?: string;
}

/**
 * Pre-build check of an app's credential files. Offline: every token is the
 * placeholder (or empty), and no endpoint other than none or the dead one.
 * Staging: the endpoint is exactly the staging one, wherever one is given.
 * Production is refused anywhere in either file.
 */
export function checkCredentials(mode: CampaignMode, facts: CredentialFacts): GuardResult {
  const json = facts.json ?? {};
  const tokens: Array<[string, unknown]> = [
    ['credentials.json ios', json.ios],
    ['credentials.json android', json.android],
  ];
  const endpoints: Array<[string, unknown]> = [['credentials.json endpoint', json.endpoint]];
  for (const line of (facts.properties ?? '').split(/\r?\n/)) {
    const entry = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (entry === null || line.trim().startsWith('#')) {
      continue;
    }
    if (entry[1] === 'app_token' || entry[1] === 'plugin.appToken') {
      tokens.push([`bugsee.properties ${entry[1]}`, entry[2]]);
    }
    if (/endpoint/i.test(entry[1]!)) {
      endpoints.push([`bugsee.properties ${entry[1]}`, entry[2]]);
    }
  }
  for (const [where, value] of [...tokens, ...endpoints]) {
    if (value !== undefined && typeof value !== 'string') {
      return fail(`${where} is not a string`);
    }
  }
  const all = `${JSON.stringify(json)}\n${facts.properties ?? ''}`;
  if (namesProduction(all)) {
    return fail('a credential file names the production API');
  }
  for (const [where, value] of endpoints) {
    const endpoint = ((value as string | undefined) ?? '').trim();
    if (endpoint === '') {
      continue;
    }
    const allowed = mode === 'offline' ? DEAD_ENDPOINT : STAGING_ENDPOINT;
    if (endpoint !== allowed) {
      return fail(`${where} is not ${allowed}`);
    }
  }
  const real = tokens.filter(([, value]) => typeof value === 'string' && value !== '' && !isPlaceholderToken(value));
  if (mode === 'offline' && real.length > 0) {
    return fail(`a real token outside the staging lane: ${real.map(([where]) => where).join(', ')}`);
  }
  if (mode === 'staging') {
    if (real.length === 0) {
      return fail('staging mode with no real token');
    }
    if (typeof json.endpoint !== 'string' || json.endpoint.trim() === '') {
      return fail(`staging mode with no credentials.json endpoint: the SDK default is production; set ${STAGING_ENDPOINT}`);
    }
    const propertiesToken = real.some(([where]) => where.startsWith('bugsee.properties'));
    const propertiesEndpoint = endpoints.some(
      ([where, value]) => where.startsWith('bugsee.properties') && typeof value === 'string' && value.trim() !== '',
    );
    if (propertiesToken && !propertiesEndpoint) {
      return fail('bugsee.properties has a real app_token but no plugin.endpoint: the Gradle plugin would upload to production');
    }
  }
  return PASS;
}
