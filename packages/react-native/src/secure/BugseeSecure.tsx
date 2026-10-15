import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent, ViewProps } from 'react-native';
import { SecureTracker } from './tracker';

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
 * Nothing is measured, and in the end nothing published, while a
 * react-native-screens screen above it is inactive in the committed tree
 * (`activityState` 0 under a screens container, such as an inactive tab that
 * stays mounted): that hides a view without changing its layout. A view
 * hidden by `display: 'none'` or a hidden `<Activity>` measures 0x0, which
 * publishes nothing anyway.
 *
 * Coverage is added at once and removed late. What it measures describes the
 * shadow tree, which native draws a frame or more later (a LayoutAnimation
 * only at its end), so what it stopped covering, by shrinking, moving or
 * being hidden, stays published for `SECURE_SHRINK_HOLD_MS`. Growth is never
 * delayed.
 *
 * Kept up to date within a frame where it matters, at a cost bounded by what
 * moves: a view that moves, was just shown or is clipped re-measures every
 * frame until it has stayed put for `STEADY_FRAMES` frames; a clipped view
 * that is still is woken the frame its ScrollView's content (watched once a
 * frame for every view under it) moves; a withdrawn view asks every frame,
 * once per screen, whether its screens still hide it, and is back the frame
 * they do not.
 *
 * Fails closed: a measurement that throws or is rejected leaves the last
 * rectangle published, and an ancestor that cannot be read or measured cuts
 * nothing off it. Only unmounting or `enabled={false}` removes it at once.
 *
 * Known limit: how an ancestor clips is read from its committed React props.
 * An `overflow` changed natively, through `setNativeProps` or a native-driven
 * style, is not seen: a view still believed clipped by an ancestor that no
 * longer clips publishes only the part inside the old clip.
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
  // Measures and publishes for this instance while it is mounted and
  // enabled. It reads the view through the ref, so one is as good as any.
  const tracker = useRef<SecureTracker | null>(null);
  tracker.current ??= new SecureTracker(() => ref.current, token);

  // A layout effect, not a passive one: it runs in the commit, so on Fabric
  // the first rectangle is registered before the first frame is painted
  // rather than after it. Cleanup semantics are the same either way.
  useLayoutEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const current = tracker.current as SecureTracker;
    current.start();
    return () => current.stop();
    // Only `enabled`: the tracker is created once per instance.
  }, [enabled]);

  const handleLayout = (event: LayoutChangeEvent): void => {
    onLayout?.(event);
    (tracker.current as SecureTracker).measure();
  };

  return <View {...rest} ref={ref} collapsable={false} onLayout={handleLayout} />;
}
