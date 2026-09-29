/**
 * `Bugsee.wrap`: the app's own opt-in for view-hierarchy ("vh") capture. See
 * `./requests.ts` for what actually answers the native SDK's `'vh'` data
 * request once this is in place.
 */
import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef, ComponentType, ReactElement } from 'react';
import { View } from 'react-native';
import { markWrapComponent, registerAnchor, unregisterAnchor } from './requests';

/**
 * The `nativeID` carried by the invisible anchor view `wrap` renders below,
 * so `./requests.ts`'s view-tree walk can recognise that view's own fiber by
 * its props (the same `nativeID` a host fiber's own props may legitimately
 * carry, per the walk's privacy rule) and leave it out of the captured tree,
 * rather than by trying to keep hold of the fiber itself across renders.
 */
export const VH_ANCHOR_NATIVE_ID = '__bugsee_view_tree_anchor';

/**
 * `displayName`, then `name`, then `'Anonymous'` -- the same rule `walk.ts`'s
 * own `nameOf` uses for a composite fiber, and for the same reason: an
 * anonymous function's `.name` is `''`, not `undefined`, so `??` alone would
 * never fall through to `'Anonymous'` for it.
 */
function nameOf(component: { displayName?: unknown; name?: unknown }): string {
  if (typeof component.displayName === 'string' && component.displayName.length > 0) {
    return component.displayName;
  }
  if (typeof component.name === 'string' && component.name.length > 0) {
    return component.name;
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
