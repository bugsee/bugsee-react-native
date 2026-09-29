import { useEffect, useRef } from 'react';
import type { ComponentRef, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent, ViewProps } from 'react-native';
import { addMeasurer } from './measureLoop';
import { clearOwner, setOwnerRectangles } from './registry';

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
        console.warn('[Bugsee] BugseeSecure could not measure', error);
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
          setOwnerRectangles(token, 0, [{ x, y, width, height }]);
        } catch (error) {
          failed(error);
        }
      });
    } catch (error) {
      failed(error);
    }
  };

  useEffect(() => {
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
