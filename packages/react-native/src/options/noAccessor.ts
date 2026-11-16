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
