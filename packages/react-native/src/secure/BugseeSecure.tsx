import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent, ViewProps } from 'react-native';
import { ancestryOfInstance, clipToAncestors, isHidden } from './ancestry';
import type { Ancestry } from './ancestry';
import { addFrameMeasurer, addMeasurer } from './measureLoop';
import { clearOwner, setOwnerRectangles } from './registry';
import { surfaceOfInstance } from './surface';
import { errorName } from '../errorName';

export interface BugseeSecureProps extends ViewProps {
  /** While false, nothing is redacted and nothing is measured. Default true. */
  enabled?: boolean;
  children?: ReactNode;
}

/**
 * Keeps Bugsee from recording whatever it wraps, for as long as it is mounted
 * and enabled.
 *
 * It measures its own view in the window on mount, on every layout and every
 * `SECURE_REMEASURE_MS` (an ancestor scrolling moves it without a layout
 * event), and publishes that rectangle through the shared registry, so it
 * never disturbs what `Bugsee.setSecureRectangles` set or another instance
 * holds.
 *
 * Only the part that is on screen is published: the rectangle is cut to every
 * ancestor that clips it, up to its surface's root (a ScrollView's viewport,
 * or a view styled `overflow: 'hidden'`). A view scrolled fully out of sight
 * publishes nothing, so it does not mask, or drop the taps on, whatever is
 * shown there instead (a bottom tab bar, say).
 *
 * Nothing is published, and nothing measured, while a react-native-screens
 * screen above it is inactive in the committed tree (`activityState` 0, such
 * as an inactive tab that stays mounted): that hides a view without changing
 * its layout. While withdrawn it checks every frame, reading props only, so
 * the rectangle is back within a frame of the screen showing again. While it
 * is clipped it re-measures every frame too, so a part scrolling into view is
 * masked within a frame; once wholly visible it goes back to the tick. A view
 * hidden by `display: 'none'` or a hidden `<Activity>` measures 0x0, which
 * publishes nothing anyway.
 *
 * Fails closed: a measurement that throws or is rejected leaves the last
 * rectangle published, and an ancestor that cannot be read or measured cuts
 * nothing off it. Only unmounting or `enabled={false}` removes it for good.
 *
 * Fabric `measureInWindow` is relative to the measured node's nearest
 * `RootNodeKind` ancestor: the app's root, or the content of the `<Modal>`
 * it is in. The rectangle is published under that surface's key (the Modal
 * host's tag, read off the fiber tree once per mount), so native translates
 * it by that surface's origin at pull time. No native call is made to find
 * the surface. On iOS that origin includes the window's place on its screen
 * (Stage Manager, Split View, iPhone Duo side by side), where the SDK draws.
 *
 * A plain function component on purpose (no `memo`, no `forwardRef`): the view
 * tree walk recognises it by identity.
 */
export function BugseeSecure(props: BugseeSecureProps): ReactElement {
  const { enabled = true, onLayout, ...rest } = props;
  const ref = useRef<ComponentRef<typeof View>>(null);
  // This instance's registry key. An object, so it can never collide with a
  // manual owner or with another instance.
  const token = useRef<object>({}).current;
  // Whether a measurement arriving now may still publish. Paper answers
  // measureInWindow asynchronously; an answer landing after unmount or
  // disable must not bring the region back.
  const active = useRef(false);
  const warned = useRef(false);
  // The surface this view is measured in, and the ancestors that can clip or
  // hide it. Read once per mount: a mounted host never changes ancestors.
  const surface = useRef<number | null>(null);
  const ancestry = useRef<Ancestry | null>(null);
  // Removes this instance from the per-frame re-measure, while it is on it:
  // while withdrawn as hidden or clipped, so it is back, or follows a scroll
  // into view, within a frame rather than a tick.
  const everyFrame = useRef<(() => void) | null>(null);

  // Reads refs only, so every render's copy does the same thing; the loop
  // keeps the one from the render that enabled it.
  const measure = (): void => {
    const failed = (error: unknown): void => {
      if (!warned.current) {
        warned.current = true;
        console.warn('[Bugsee] BugseeSecure could not measure', errorName(error));
      }
    };

    const view = ref.current;
    if (!active.current || view === null) {
      return;
    }
    try {
      surface.current ??= surfaceOfInstance(view);
      ancestry.current ??= ancestryOfInstance(view);
      const measuredIn = surface.current;
      const above = ancestry.current;
      if (isHidden(above)) {
        setOwnerRectangles(token, 0, [], measuredIn);
        // Every frame while it stays hidden: prop reads and an unchanged
        // (skipped) publish; once it shows, a measurement.
        everyFrame.current ??= addFrameMeasurer(measure);
        return;
      }
      // Fabric answers every measurement at once, so the view and its
      // clipping ancestors are measured in the same layout and published
      // once. Paper answers later, and its ancestors then cut nothing.
      view.measureInWindow((x, y, width, height) => {
        if (!active.current) {
          return;
        }
        try {
          const visible = clipToAncestors({ x, y, width, height }, above);
          setOwnerRectangles(token, 0, visible === null ? [] : [visible], measuredIn);
          // Clipped (or cut away entirely): what scrolls into view next must
          // be masked within a frame. Wholly visible: the tick is enough.
          if (visible === null || visible.width < width || visible.height < height) {
            everyFrame.current ??= addFrameMeasurer(measure);
          } else {
            everyFrame.current?.();
            everyFrame.current = null;
          }
        } catch (error) {
          failed(error);
        }
      });
    } catch (error) {
      failed(error);
    }
  };

  // A layout effect, not a passive one: it runs in the commit, so on Fabric
  // the first rectangle is registered before the first frame is painted
  // rather than after it. Cleanup semantics are the same either way.
  useLayoutEffect(() => {
    if (!enabled) {
      return undefined;
    }
    active.current = true;
    measure();
    // On the tick only while not on the per-frame re-measure, which covers it.
    const removeMeasurer = addMeasurer(() => {
      if (everyFrame.current === null) {
        measure();
      }
    });
    return () => {
      active.current = false;
      everyFrame.current?.();
      everyFrame.current = null;
      surface.current = null;
      ancestry.current = null;
      removeMeasurer();
      clearOwner(token);
    };
    // Only `enabled`: `measure` and `token` read refs, so the first copy of
    // each is as good as any later one.
  }, [enabled]);

  const handleLayout = (event: LayoutChangeEvent): void => {
    onLayout?.(event);
    measure();
  };

  return <View {...rest} ref={ref} collapsable={false} onLayout={handleLayout} />;
}
