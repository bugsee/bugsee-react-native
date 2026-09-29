/**
 * A leaf module (no imports of its own) so that both `anchor.tsx` and
 * `requests.ts` can read `VH_ANCHOR_NATIVE_ID` without importing each other
 * for it. Before this file existed, `requests.ts` imported the constant
 * straight from `anchor.tsx`, which also imports `registerAnchor`/
 * `unregisterAnchor`/`markWrapComponent` from `requests.ts` -- a circular
 * import that happened to be safe (every cross-reference was read inside a
 * function body, never at module top level) but would silently break the
 * moment either side read the other's export at its own top level instead.
 */

/**
 * The `nativeID` carried by the invisible anchor view `wrap` (`anchor.tsx`)
 * renders, so `requests.ts`'s view-tree walk can recognise that view's own
 * fiber by its props (the same `nativeID` a host fiber's own props may
 * legitimately carry, per the walk's privacy rule) and leave it out of the
 * captured tree, rather than by trying to keep hold of the fiber itself
 * across renders.
 */
export const VH_ANCHOR_NATIVE_ID = '__bugsee_view_tree_anchor';
