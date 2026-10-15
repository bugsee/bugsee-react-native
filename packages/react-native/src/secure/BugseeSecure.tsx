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
 * Unmounting removes it late too: native draws the view until it mounts the
 * commit that removed it, so what it covered stays published for
 * `SECURE_SHRINK_HOLD_MS`.
 *
 * Native transitions draw it where no measurement can follow, so for
 * `SECURE_TRANSITION_HOLD_MS` from the commit that starts one it also covers
 * where they can. While a react-native-screens stack pushes or pops a
 * screen, a view on that screen, or on the screen it uncovers or covers,
 * covers by the screen's `stackAnimation`: its band across the screen for a
 * sideways slide, the column below it for a slide from the bottom, itself
 * for a fade, and the whole screen for the platform default or anything
 * else. A view in a `<Modal animationType="slide">` covers the band below
 * it while the Modal slides in or out (also when `visible` turns false on a
 * Modal that stays mounted). A screen replaced on its stack (`replace`) is
 * animated out by the incoming screen's animation, and covered by it. A view
 * that mounts, or is shown, in a screen or Modal still within the hold from
 * its push or opening is covered too (content that arrives after a spinner),
 * and re-measured every frame until it settles, so a Modal laid out again
 * once its dialog is up is followed within a frame; so is a view first shown
 * on the screen a pop uncovers (mounted while that screen was hidden, or
 * during the pop), for the rest of the pop's hold. Each stack keeps what any
 * view saw of its recent pushes and pops. When a screen or Modal came or
 * went is known only if a `<BugseeSecure>` saw it (one on it, or on another
 * screen of its stack); otherwise the first view to look takes it as
 * happening then, once per change (a stack read for the first time is
 * compared with its render before).
 *
 * A native-driven `Animated` transform above it (`useNativeDriver: true`)
 * never reaches the shadow tree, so it also covers every place that
 * transform can draw it, joined with where it is measured: translations and
 * scales (about `transformOrigin`) bounded from the animated value, its
 * running timing animation, interpolations, `diffClamp` and arithmetic
 * nodes. A value a native event is attached to (an `Animated.event` in an
 * `Animated` component's props, such as an `Animated.ScrollView`'s
 * `onScroll` or a gesture handler's `onGestureEvent`, or one attached with
 * `Animated.attachNativeEvent`, as React Native's ScrollView does for its
 * sticky headers) moves wherever the scroll or the gesture takes it, for as
 * long as it is attached, idle or not, whatever animated it before. It is
 * bounded only where that is provable: through an interpolation that clamps,
 * or extends a flat last segment, at both ends (within its outputs, eased);
 * through `diffClamp`; and, on Android, as a ScrollView's `contentOffset`
 * (vertical or horizontal), within the offsets the ScrollView can reach
 * (from its measured content and viewport, and a fling's overrun past either
 * end, `SCROLL_OVERRUN`), unless it is under a scale other than 1. What cannot
 * be bounded (any other event's value, an iOS ScrollView's offset, a rotation, a
 * spring, a node React Native renamed) covers the whole surface, cut by the
 * clipping ancestors above it, for as long as it cannot be. A view under a
 * running native animation is re-measured every frame. When JS moves a value
 * above it (starts an animation on it, the first with the native driver
 * included, which makes it native and commits nothing; sets, resets or
 * offsets it), the view is measured and published in that same JS task,
 * before React Native hands the change to the UI thread; what native does to
 * a still native value on its own (an animation ending) is seen by the next
 * JS frame. A transform animated from JS (`useNativeDriver: false`) moves the
 * view every frame through Fabric with no wrapped call: the view is
 * re-measured every frame while the animation runs, and an idle value driven
 * from JS keeps no frame loop running. Other styles a JS animation moves
 * (`top`, `left`, a size) are followed by the 100 ms re-measure only.
 *
 * What drives a native value is followed from when the package is first
 * evaluated (its entry imports `secure/followEvents` for that, so Metro's
 * `inlineRequires` does not defer it to the first `<BugseeSecure>`; it does
 * defer the entry to its first use: import the package, or call
 * `Bugsee.launch`, at the top of `index.js`): the
 * events attached to it, and its being made native. A native value made
 * native before that, or left wherever its last event took it, is unbounded
 * until it next animates. Where React Native's internals cannot be followed
 * (React Native moved them), no still native value is trusted: every one is
 * unbounded.
 *
 * Known limits: Reanimated runs its animations on the UI thread, out of
 * JS's sight; a Reanimated component whose style sets a transform through
 * an animated style, sets a shared value inline, or uses a CSS animation or
 * transition covers the whole surface, cut by the clipping ancestors above
 * it; anything else Reanimated moves (an animated style that adds a
 * transform only later, layout animations, `entering`/`exiting`, shared
 * transitions) is not seen. An interactive back gesture moves a mounted
 * screen with nothing JS sees. The cover published as JS starts a native
 * animation and the animation itself reach native separately; under heavy
 * load the UI thread could still draw its first frame before the cover lands.
 * A native event attached without `Animated` (code that calls React
 * Native's native Animated module itself) is not seen, and its value is
 * taken where JS last had it.
 *
 * Fails closed: a measurement that throws or is rejected leaves the last
 * rectangle published, and an ancestor that cannot be read or measured cuts
 * nothing off it. Only `enabled={false}` removes it at once.
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
/** No dependencies: an effect that runs once per mount. */
// Stryker disable next-line ArrayDeclaration -- any constant list runs it once per mount alike
const ONCE_PER_MOUNT: readonly unknown[] = [];

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

  // Set while the instance unmounts. Declared before the effect below, so on
  // unmount its cleanup runs first; a change of `enabled` alone never runs it.
  // Stryker disable next-line BooleanLiteral -- the effect below sets it before any cleanup can read it
  const unmounting = useRef(false);
  useLayoutEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
    };
  }, ONCE_PER_MOUNT);

  // A layout effect, not a passive one: it runs in the commit, so on Fabric
  // the first rectangle is registered before the first frame is painted
  // rather than after it, and the cleanup of an unmount can still read which
  // fibers that commit deletes.
  useLayoutEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const current = tracker.current as SecureTracker;
    current.start();
    return () => (unmounting.current ? current.depart() : current.stop());
    // Only `enabled`: the tracker is created once per instance.
  }, [enabled]);

  const handleLayout = (event: LayoutChangeEvent): void => {
    onLayout?.(event);
    (tracker.current as SecureTracker).measure();
  };

  return <View {...rest} ref={ref} collapsable={false} onLayout={handleLayout} />;
}
