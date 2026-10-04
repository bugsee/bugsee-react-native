import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent, ViewProps } from 'react-native';
import NativeBugsee from '../NativeBugsee';
import { addMeasurer } from './measureLoop';
import { clearOwner, MAIN_SURFACE, setOwnerRectangles } from './registry';
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
 * Fails closed: a measurement that throws or is rejected leaves the last
 * rectangle published. Only unmounting or `enabled={false}` removes it.
 *
 * Fabric `measureInWindow` is relative to the measured node's nearest
 * `RootNodeKind` ancestor (the activity React root, or a `<Modal>`'s
 * `DialogRootViewGroup` / `ModalHostView`). The rectangle is published under
 * that surface's key so native can translate it by that surface's display
 * origin at pull time — not the activity root's origin alone.
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
      view.measureInWindow((x, y, width, height) => {
        if (!active.current) {
          return;
        }
        try {
          setOwnerRectangles(token, 0, [{ x, y, width, height }], surfaceOf(view));
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
    const removeMeasurer = addMeasurer(measure);
    return () => {
      active.current = false;
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

/**
 * The surface key native resolves for the React root holding `view`; the
 * main surface when the view has no tag or native answers something that is
 * not a key. Throws whatever the lookup throws: the caller treats that as a
 * failed measurement and keeps the last rectangle.
 */
function surfaceOf(view: object): number {
  const tag = (view as { __nativeTag?: unknown }).__nativeTag;
  // Number.isFinite never coerces: a string or a missing tag is not finite.
  if (!Number.isFinite(tag)) {
    return MAIN_SURFACE;
  }
  const surface: unknown = NativeBugsee.secureSurfaceKey(tag as number);
  return Number.isInteger(surface) ? (surface as number) : MAIN_SURFACE;
}
