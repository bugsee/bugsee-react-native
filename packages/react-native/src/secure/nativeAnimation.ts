import { measureFiber, styleValue } from './ancestry';
import type { Ancestry } from './ancestry';
import { WHOLE_SURFACE } from './transition';
import { FiberTag } from '../viewtree/fiber';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/**
 * Where a native-driven `Animated` transform above a `<BugseeSecure>` can draw
 * it.
 *
 * With `useNativeDriver: true` the animated value is applied natively, every
 * frame, and never reaches the shadow tree: `measureInWindow` keeps reading
 * the transform React last rendered, while the view is drawn somewhere else,
 * during the animation and after it stops. What JS does know is the
 * `Animated` node itself, in the props of the `Animated` component that
 * renders the transformed host: its current value (synced back when a native
 * animation ends), the running animation's start, end and easing, and an
 * interpolation's mapping. From those this module bounds every value the
 * node can take until the next re-measure, and so every place the view can
 * be drawn.
 *
 * Bounded exactly: `translateX`/`translateY`, and `scale`/`scaleX`/`scaleY`
 * about the host's centre, each on its own, driven by an `Animated.Value`
 * (still, or in a timing animation) or an interpolation of one. Anything else
 * driven natively (a rotation, a spring or decay, `Animated.add` and the
 * like, a transform mixing translation with other functions) cannot be
 * bounded from JS, and covers the whole surface, cut only by the clipping
 * ancestors above it: masking too much beats drawing the view where nothing
 * masks it. A JS-driven animation needs none of this: Fabric commits its
 * values to the shadow tree, and `measureInWindow` follows it.
 */

interface Range {
  lo: number;
  hi: number;
}

/** What one native transform (or a run of them, nearest first) does to the view. */
export interface NativeMotion {
  /** Every place the view can be drawn, before the clipping ancestors above `above` cut it. */
  readonly rect: WindowRect;
  /** The outermost `Animated` component in `Ancestry.path`: clipping below it is moved with it. */
  readonly above: number;
}

/** How finely an easing is sampled to find how far past its ends it can go. */
const EASING_SAMPLES = 20;

const TRANSLATE_KEYS: ReadonlySet<string> = new Set(['translateX', 'translateY']);
const SCALE_KEYS: ReadonlySet<string> = new Set(['scale', 'scaleX', 'scaleY']);

interface AnimatedNodeLike {
  __getValue: () => unknown;
  __isNative?: unknown;
  _parent?: unknown;
  _config?: { inputRange?: unknown };
  _getInterpolation?: () => (input: number) => unknown;
  _value?: unknown;
  _offset?: unknown;
  _animation?: {
    _fromValue?: unknown;
    _toValue?: unknown;
    _easing?: unknown;
  } | null;
}

function isNode(value: unknown): value is AnimatedNodeLike {
  return value !== null && typeof value === 'object' && typeof (value as AnimatedNodeLike).__getValue === 'function';
}

function isNativeNode(value: unknown): value is AnimatedNodeLike {
  return isNode(value) && value.__isNative === true;
}

function finiteNumber(value: unknown): value is number {
  // Never coerces: a string or a missing value is not finite.
  return Number.isFinite(value as number);
}

function widen(range: Range, value: number): void {
  range.lo = Math.min(range.lo, value);
  range.hi = Math.max(range.hi, value);
}

/**
 * Every value an `Animated.Value` takes until its running animation (if any)
 * ends: its value now, and a timing animation's whole path. `undefined` for
 * any other animation.
 */
function valueRange(node: AnimatedNodeLike): Range | undefined {
  const now = node.__getValue();
  if (!finiteNumber(now)) {
    return undefined;
  }
  const range = { lo: now, hi: now };
  const animation = node._animation;
  if (animation == null) {
    return range;
  }
  const { _fromValue: from, _toValue: to, _easing: easing } = animation;
  if (!finiteNumber(from) || !finiteNumber(to) || typeof easing !== 'function') {
    return undefined;
  }
  const offset = finiteNumber(node._offset) ? node._offset : 0;
  for (let step = 0; step <= EASING_SAMPLES; step += 1) {
    const eased = (easing as (t: number) => unknown)(step / EASING_SAMPLES);
    if (!finiteNumber(eased)) {
      return undefined;
    }
    widen(range, offset + from + eased * (to - from));
  }
  return range;
}

/** Every value an interpolation of a bounded node takes, sampled at its breakpoints and between. */
function interpolationRange(node: AnimatedNodeLike, parent: AnimatedNodeLike): Range | undefined {
  const input = nodeRange(parent);
  const interpolate = node._getInterpolation?.();
  if (input === undefined || typeof interpolate !== 'function') {
    return undefined;
  }
  // Stryker disable next-line ArrayDeclaration -- the filter below drops anything that is not a number
  const breakpoints = Array.isArray(node._config?.inputRange) ? (node._config.inputRange as unknown[]) : [];
  const samples = breakpoints.filter(
    // The ends are sampled anyway, and a value that is not a number never compares greater.
    // Stryker disable next-line EqualityOperator,ConditionalExpression -- so these mutants sample the same
    (point): point is number => finiteNumber(point) && point > input.lo && point < input.hi,
  );
  for (let step = 0; step <= EASING_SAMPLES; step += 1) {
    samples.push(input.lo + ((input.hi - input.lo) * step) / EASING_SAMPLES);
  }
  const outputs = samples.map((sample) => interpolate(sample));
  if (!outputs.every(finiteNumber)) {
    return undefined;
  }
  return { lo: Math.min(...outputs), hi: Math.max(...outputs) };
}

/** Every value `node` can take until the next re-measure, or `undefined` when that cannot be bounded. */
export function nodeRange(node: AnimatedNodeLike): Range | undefined {
  if (isNode(node._parent)) {
    return interpolationRange(node, node._parent);
  }
  if (finiteNumber(node._value)) {
    return valueRange(node);
  }
  return undefined;
}

/** The transform functions of `style`, as `[name, value]`, or `undefined` when it has none. */
function transformOf(props: unknown): Array<[string, unknown]> | undefined {
  const transform = styleValue((props as { style?: unknown } | null | undefined)?.style, 'transform');
  if (!Array.isArray(transform)) {
    return undefined;
  }
  const entries: Array<[string, unknown]> = [];
  for (const entry of transform) {
    if (entry === null || typeof entry !== 'object') {
      return undefined;
    }
    entries.push(...Object.entries(entry as Record<string, unknown>));
  }
  return entries;
}

/** The value `name` has in the host's rendered transform: what the shadow tree measured with. */
function rendered(host: FiberLike, name: string): number | undefined {
  const value = transformOf(host.memoizedProps)?.find(([key]) => key === name)?.[1];
  return finiteNumber(value) ? value : undefined;
}

/** `rect` moved by up to `dx` and `dy`. */
function translated(rect: WindowRect, dx: Range, dy: Range): WindowRect {
  return {
    x: rect.x + dx.lo,
    y: rect.y + dy.lo,
    width: rect.width + dx.hi - dx.lo,
    height: rect.height + dy.hi - dy.lo,
  };
}

/** Every place `rect` can be scaled to about `centre`, by factors in `kx` and `ky` (from what was measured). */
function scaled(rect: WindowRect, centre: { x: number; y: number }, kx: Range, ky: Range): WindowRect {
  const span = (from: number, to: number, at: number, k: Range): [number, number] => {
    const ends = [at + k.lo * (from - at), at + k.hi * (from - at), at + k.lo * (to - at), at + k.hi * (to - at)];
    return [Math.min(...ends), Math.max(...ends)];
  };
  const [left, right] = span(rect.x, rect.x + rect.width, centre.x, kx);
  const [top, bottom] = span(rect.y, rect.y + rect.height, centre.y, ky);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * What the native transform in `entries` does to `rect`, with `host` the
 * view it transforms; `undefined` when it cannot be bounded.
 */
function moved(rect: WindowRect, entries: Array<[string, unknown]>, host: FiberLike): WindowRect | undefined {
  const names = entries.map(([name]) => name);
  if (names.every((name) => TRANSLATE_KEYS.has(name))) {
    const dx = { lo: 0, hi: 0 };
    const dy = { lo: 0, hi: 0 };
    for (const [name, value] of entries) {
      if (!isNativeNode(value)) {
        continue;
      }
      const range = nodeRange(value);
      // Without this, reading the missing range throws, which reads as unbounded too.
      // Stryker disable next-line ConditionalExpression,BlockStatement -- so its mutants are equivalent
      if (range === undefined) {
        return undefined;
      }
      // Measured with the value rendered; without it, any value the node can take.
      const at = rendered(host, name);
      const delta =
        at === undefined
          ? { lo: range.lo - range.hi, hi: range.hi - range.lo }
          : { lo: range.lo - at, hi: range.hi - at };
      const axis = name === 'translateX' ? dx : dy;
      axis.lo += delta.lo;
      axis.hi += delta.hi;
    }
    return translated(rect, dx, dy);
  }
  if (names.every((name) => SCALE_KEYS.has(name))) {
    const kx = { lo: 1, hi: 1 };
    const ky = { lo: 1, hi: 1 };
    for (const [name, value] of entries) {
      if (!isNativeNode(value)) {
        continue;
      }
      const range = nodeRange(value);
      const at = rendered(host, name);
      // Stryker disable next-line ConditionalExpression -- as above: a missing range throws, read as unbounded
      if (range === undefined || at === undefined || at <= 0 || range.lo < 0) {
        return undefined;
      }
      for (const axis of name === 'scaleY' ? [ky] : name === 'scaleX' ? [kx] : [kx, ky]) {
        axis.lo *= range.lo / at;
        axis.hi *= range.hi / at;
      }
    }
    const box = measureFiber(host);
    // Without this, reading the missing box throws, which reads as unbounded too.
    // Stryker disable next-line ConditionalExpression,BlockStatement -- so its mutants are equivalent
    if (box == null) {
      return undefined;
    }
    return scaled(rect, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, kx, ky);
  }
  return undefined;
}

/** The host an `Animated` component at `index` renders: the nearest host below it. */
function hostBelow(ancestry: Ancestry, fibers: readonly FiberLike[], index: number): FiberLike {
  for (let below = index - 1; below >= 0; below -= 1) {
    if ((fibers[below] as FiberLike).tag === FiberTag.HostComponent) {
      return fibers[below] as FiberLike;
    }
  }
  return ancestry.self as FiberLike;
}

/**
 * Where native-driven `Animated` transforms above the view can draw it,
 * measured at `self`; `null` when nothing above it is driven natively.
 * Reads the props the last `isHidden` resolved as committed.
 */
export function nativeMotion(self: WindowRect, ancestry: Ancestry): NativeMotion | null {
  if (ancestry.animated.length === 0) {
    return null;
  }
  const fibers = ancestry.resolved ?? ancestry.path;
  let rect = self;
  let above = -1;
  for (const index of ancestry.animated) {
    let next: WindowRect | undefined;
    // Props and nodes are the app's: a getter on one can throw.
    try {
      const entries = transformOf((fibers[index] as FiberLike).memoizedProps);
      if (entries === undefined || !entries.some(([, value]) => isNativeNode(value))) {
        continue;
      }
      above = index;
      next = moved(rect, entries, hostBelow(ancestry, fibers, index));
    } catch {
      // Unbounded: `next` stays undefined.
    }
    if (next === undefined) {
      return { rect: WHOLE_SURFACE, above: ancestry.animated[ancestry.animated.length - 1] as number };
    }
    rect = next;
  }
  return above < 0 ? null : { rect, above };
}
