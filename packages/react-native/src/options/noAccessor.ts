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

/**
 * Internal (hidden) SDK options this package's code really uses, with what it uses them for. When an SDK
 * drops one of these the package breaks, so the removal check reports it; an internal option that is not
 * listed here (`$$DEBUG`, `$$WRAPPER`: the wrapper registers itself through `setWrapper`, not the option)
 * is not this package's concern when it disappears.
 *
 * Add an entry when code starts to depend on another internal option.
 */
export const RELIES_ON_INTERNAL: Readonly<Record<string, string>> = {
  'com.bugsee.option.$$ENDPOINT':
    'the endpoint override: the `endpoint` accessor, the Expo plugin and the Android manifest meta-data path',
};
