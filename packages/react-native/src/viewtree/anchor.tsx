/**
 * `Bugsee.wrap`: the app's own opt-in for view-hierarchy ("vh") capture. See
 * `./requests.ts` for what actually answers the native SDK's `'vh'` data
 * request once this is in place.
 */
import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef, ComponentType, ReactElement } from 'react';
import { View } from 'react-native';
import { VH_ANCHOR_NATIVE_ID } from './constants';
import { markWrapComponent, registerAnchor, unregisterAnchor } from './requests';

// Re-exported from the leaf `./constants` module (see its own doc comment
// for why the constant does not live here directly): `anchor.tsx` is this
// value's documented public home, per the brief, even though `requests.ts`
// no longer needs to import THIS module to read it.
export { VH_ANCHOR_NATIVE_ID };

/**
 * `displayName`, then a plain function's `.name`, then -- for `React.memo`
 * and `React.forwardRef`, which are plain OBJECTS, not functions, and so
 * have no `.name` of their own -- the same unwrap `walk.ts`'s own
 * `compositeClassName` does for a fiber: `.type` (what `memo(...)` wraps) or
 * `.render` (what `forwardRef(...)` wraps), recursively. `'Anonymous'` only
 * once none of those resolves to a non-empty string.
 *
 * Never `??`: an anonymous function's `.name` is `''`, not `undefined`, so
 * `??` alone would never fall through past it to `'Anonymous'`.
 */
function nameOf(component: unknown): string {
  if (typeof component === 'function' || (typeof component === 'object' && component !== null)) {
    const named = component as { displayName?: unknown; name?: unknown; type?: unknown; render?: unknown };
    if (typeof named.displayName === 'string' && named.displayName.length > 0) {
      return named.displayName;
    }
    if (typeof named.name === 'string' && named.name.length > 0) {
      return named.name;
    }
    if (named.type !== undefined) {
      return nameOf(named.type);
    }
    if (named.render !== undefined) {
      return nameOf(named.render);
    }
  }
  return 'Anonymous';
}

/**
 * Wraps the app's root component so the native SDK can capture the on-screen
 * view hierarchy ("vh") -- the anonymised tree of what is on screen (no text,
 * no prop but `testID`/`nativeID`) that the SDK attaches to a report or pulls
 * for a live capture. Without `Bugsee.wrap`, the SDK's `'vh'` request always
 * answers with nothing: there is no registered root for the walk to start
 * from.
 *
 * Renders `Root` completely unchanged, alongside an invisible, zero-size
 * anchor view that is never drawn and never intercepts a touch. Mounting the
 * wrapped tree registers that anchor with the view-tree walk; unmounting it
 * unregisters it -- see `./requests.ts`'s `registerAnchor`/`unregisterAnchor`,
 * which is what turns the native request on and off.
 *
 * Usage: `AppRegistry.registerComponent(appName, () => Bugsee.wrap(App))`.
 */
export function wrap<P extends object>(Root: ComponentType<P>): ComponentType<P> {
  function BugseeRoot(props: P): ReactElement {
    const anchorRef = useRef<ComponentRef<typeof View>>(null);

    // A layout effect, not a passive one, for the same reason `BugseeSecure`
    // uses one: it runs in the commit, so the anchor is registered before the
    // first frame paints rather than after it. `[]`: the anchor instance
    // registered here does not change across `BugseeRoot`'s own re-renders.
    useLayoutEffect(() => {
      const instance = anchorRef.current;
      if (instance === null) {
        return undefined;
      }
      registerAnchor(instance);
      return () => {
        unregisterAnchor(instance);
      };
    }, []);

    return (
      <>
        <Root {...props} />
        <View
          ref={anchorRef}
          nativeID={VH_ANCHOR_NATIVE_ID}
          collapsable={false}
          pointerEvents="none"
          style={{ position: 'absolute', width: 0, height: 0 }}
        />
      </>
    );
  }

  BugseeRoot.displayName = `BugseeRoot(${nameOf(Root)})`;
  markWrapComponent(BugseeRoot);

  return BugseeRoot;
}
