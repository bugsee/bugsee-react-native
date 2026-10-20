import { isPlaceholderToken } from './properties';

export interface AutoLaunchInput {
  readonly appToken?: string;
  /** Off unless set. Manifest auto-launch starts the native SDK before JS. */
  readonly autoLaunch?: boolean;
}

/**
 * The `com.bugsee.app-token` meta-data value, or null when the manifest
 * should be left alone. A placeholder token is not written: the native SDK
 * would launch it against the production API.
 */
export function manifestAutoLaunchToken(input: AutoLaunchInput): string | null {
  if (input.autoLaunch !== true) {
    return null;
  }
  const token = input.appToken ?? '';
  if (token.length === 0 || isPlaceholderToken(token)) {
    return null;
  }
  return token;
}

/**
 * The wrapper's own meta-data: the `endpoint` option, which the native module
 * applies when `launch()` or `relaunch()` is given no endpoint
 * (BugseeModule.java, `PluginEndpoint`). The name is the wrapper's, so a
 * value found under it is this plugin's and is replaced or removed freely.
 */
export const RN_ENDPOINT_META_DATA = 'com.bugsee.reactnative.endpoint';

/**
 * The Android SDK's own option, read on the manifest auto-launch path. The
 * customer may have written it, so it is touched only when
 * `SDK_ENDPOINT_MARKER` says this plugin wrote that exact value.
 */
export const SDK_ENDPOINT_META_DATA = 'com.bugsee.option.$$ENDPOINT';
export const SDK_ENDPOINT_MARKER = 'com.bugsee.reactnative.sdk-endpoint';

export interface EndpointMetaDataInput {
  /** The validated `endpoint` option, if set. */
  readonly endpoint?: string;
  /** What `manifestAutoLaunchToken` returned: non-null when auto-launch is written. */
  readonly autoLaunchToken: string | null;
  /** The value of a meta-data item already in the manifest, by name. */
  readonly existing: (name: string) => string | undefined;
}

export interface EndpointMetaDataEdit {
  /** Removed first, by name. */
  readonly remove: readonly string[];
  /** Then added or replaced. */
  readonly set: Readonly<Record<string, string>>;
  /** Said once when the customer's own SDK endpoint is left in place. */
  readonly warning?: string;
}

export const SDK_ENDPOINT_KEPT =
  `@bugsee/react-native: AndroidManifest.xml already sets ${SDK_ENDPOINT_META_DATA}, which this plugin did ` +
  'not write. It is left as it is, and the auto-launched SDK uses it rather than the endpoint option';

/**
 * The meta-data edits for the `endpoint` option. Every earlier edit of this
 * plugin is undone first, so a later prebuild without the option leaves no
 * endpoint behind, and one with a new value replaces the old one.
 */
export function endpointMetaData(input: EndpointMetaDataInput): EndpointMetaDataEdit {
  const remove: string[] = [RN_ENDPOINT_META_DATA];
  const set: Record<string, string> = {};
  const marker = input.existing(SDK_ENDPOINT_MARKER);
  const sdk = input.existing(SDK_ENDPOINT_META_DATA);
  const sdkIsOurs = marker !== undefined && sdk === marker;
  if (marker !== undefined) {
    remove.push(SDK_ENDPOINT_MARKER);
  }
  if (sdkIsOurs) {
    remove.push(SDK_ENDPOINT_META_DATA);
  }
  if (!input.endpoint) {
    return { remove, set };
  }
  set[RN_ENDPOINT_META_DATA] = input.endpoint;
  if (input.autoLaunchToken === null) {
    return { remove, set };
  }
  if (sdk !== undefined && !sdkIsOurs) {
    return { remove, set, warning: SDK_ENDPOINT_KEPT };
  }
  set[SDK_ENDPOINT_META_DATA] = input.endpoint;
  set[SDK_ENDPOINT_MARKER] = input.endpoint;
  return { remove, set };
}

/**
 * The wrapper's own meta-data for the startup filter hold: a comma list of
 * the filters the Android native module installs, fail closed, in its init
 * provider, before the SDK can launch. See `ReactNativeWrapperInitProvider`.
 * The name is the wrapper's, so a value found under it is this plugin's and is
 * replaced or removed freely.
 */
export const RN_HOLD_FILTERS_META_DATA = 'com.bugsee.reactnative.hold-filters';

export const HOLDABLE_FILTERS = ['network', 'log', 'breadcrumb'] as const;
export type HoldableFilter = (typeof HOLDABLE_FILTERS)[number];

export const HOLD_FILTERS_NOT_VALID =
  `@bugsee/react-native: holdFilters must be true, false, or a list of ${HOLDABLE_FILTERS.join(', ')}`;

/**
 * The `holdFilters` option as the meta-data value, or null when none is
 * written (unset, `false` or an empty list). `true` holds all three. Anything
 * else is refused, so a typo cannot silently leave a filter open.
 */
export function holdFiltersValue(option: unknown): string | null {
  if (option === undefined || option === null || option === false) {
    return null;
  }
  if (option === true) {
    return HOLDABLE_FILTERS.join(',');
  }
  if (!Array.isArray(option)) {
    throw new Error(HOLD_FILTERS_NOT_VALID);
  }
  const held = new Set<string>();
  for (const name of option) {
    if (!(HOLDABLE_FILTERS as readonly unknown[]).includes(name)) {
      throw new Error(HOLD_FILTERS_NOT_VALID);
    }
    held.add(name as string);
  }
  const ordered = HOLDABLE_FILTERS.filter((name) => held.has(name));
  return ordered.length === 0 ? null : ordered.join(',');
}
