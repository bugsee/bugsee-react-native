/**
 * The plugin's `endpoint` option: a self-hosted, staging or regional Bugsee
 * API base. Unset (the default) leaves every tool and both SDKs on their own
 * default, production.
 *
 * The value is the version-EXCLUSIVE base, as `plugin.endpoint` in
 * bugsee.properties and bugsee-cli's BUGSEE_ENDPOINT take it: both add the
 * API version themselves. Only the iOS SDK's runtime option wants the
 * version in it, and `iosRuntimeEndpoint` adds it.
 *
 * The shape is narrow on purpose. The value is written into a properties
 * file, a single-quoted shell word in the bundle phase and the Archive
 * post-action, an Info.plist and AndroidManifest.xml; a value that is safe
 * in all of them, and a URL every one of their readers parses the same way,
 * is https, a host of letters, digits, dots and dashes, an optional port and
 * an optional plain path. Nothing in the error echoes the value.
 */

const ENDPOINT_SHAPE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;
const VERSION_SUFFIX = /\/v2$/i;

export const ENDPOINT_NOT_VALID =
  '@bugsee/react-native: endpoint must be an https URL with a host, an optional port and an optional path, ' +
  'and no credentials, query or fragment (for example https://bugsee.example.com)';

export const ENDPOINT_HAS_VERSION =
  '@bugsee/react-native: endpoint must not end in /v2. Give the API base: the Gradle plugin, bugsee-cli ' +
  'and the SDKs add the API version themselves';

/**
 * The validated endpoint, without trailing slashes, or undefined when the
 * option is unset or empty. Throws for anything else.
 */
export function pluginEndpoint(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(ENDPOINT_NOT_VALID);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!ENDPOINT_SHAPE.test(trimmed)) {
    throw new Error(ENDPOINT_NOT_VALID);
  }
  // The shape already means https and a host; the parser adds what a regular
  // expression does not say, such as a port above 65535.
  try {
    new URL(trimmed);
  } catch {
    throw new Error(ENDPOINT_NOT_VALID);
  }
  const base = trimmed.replace(/\/+$/, '');
  if (VERSION_SUFFIX.test(base)) {
    throw new Error(ENDPOINT_HAS_VERSION);
  }
  return base;
}

/**
 * The iOS SDK's `endpoint` launch option for a validated base. It reads the
 * value verbatim as the versioned API base (src/options/endpoint.ts
 * `endpointFor`), so the version segment is added here.
 */
export function iosRuntimeEndpoint(base: string): string {
  return `${base}/v2`;
}
