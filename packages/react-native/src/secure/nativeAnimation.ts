import { clipToAncestors, isReanimatedComponent, measureFiber, passMemo, styleValue } from './ancestry';
import { WHOLE_SURFACE } from './transition';
import type { Ancestry } from './ancestry';
import { FiberTag } from '../viewtree/fiber';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/**
 * Where native-driven transforms above a `<BugseeSecure>` can draw it.
 *
 * With `useNativeDriver: true` an `Animated` value is applied natively, every
 * frame, and never reaches the shadow tree as it moves: `measureInWindow`
 * keeps reading what React last rendered (or, with React Native's C++
 * Animated, the value the last animation ended at), while the view is drawn
 * somewhere else. What JS does know is the `Animated` nodes themselves, in
 * the props of the `Animated` component that renders the transformed host.
 * From them this module bounds every value a node can take until the next
 * re-measure, by interval arithmetic:
 *  - an `Animated.Value` in a timing animation: its whole path, easing
 *    overshoot included; still: its value, but only when JS provably has it
 *    (this module saw it animate, or the app listens to it). A native value
 *    nobody animated from JS may be driven by a native `Animated.event` (a
 *    scroll, a gesture) whose values JS never sees: unbounded;
 *  - `diffClamp` between its bounds; `add`, `subtract`, `multiply`, `divide`
 *    and `modulo` from their operands; an interpolation through its mapping,
 *    or within its output range when it clamps both ends, whatever its input.
 *
 * A transform of translations and scales (in any order, about its
 * `transformOrigin`) is then bounded exactly: the view's measured rectangle is
 * taken back to the host's own frame under each value the shadow tree may
 * hold (the rendered one, or the current one), and carried through every
 * value the nodes can take. The result is joined with the measured rectangle,
 * so a mask is only ever widened, never moved off the view.
 *
 * Anything else is unbounded and covers the whole surface, cut by the
 * clipping ancestors above it: a rotation, skew or matrix; a node of a kind,
 * or with fields, this module does not know (React Native renamed something);
 * a spring or decay; a Reanimated component whose animated style sets a
 * transform (Reanimated's worklets keep their values on the UI thread).
 * Masking too much beats drawing the view where nothing masks it.
 *
 * A JS-driven animation needs none of this: Fabric commits its values to the
 * shadow tree, and `measureInWindow` follows it.
 */

export interface Range {
  lo: number;
  hi: number;
}

/** A node's bound, and what about it calls for watching. */
interface NodeBound {
  /** Every value it can take until the next re-measure; `undefined`: unbounded. */
  readonly range: Range | undefined;
  /** A timing animation drives it: its value changes every frame. */
  readonly running: boolean;
  /** The native `Animated.Value`s it is computed from. */
  readonly roots: readonly AnimatedNodeLike[];
}

/** One `Animated` component's transform, as it can move the view. */
export interface MotionLevel {
  /** Where the component is in `Ancestry.path`: clippers below it move with it. */
  readonly index: number;
  /** Every place `rect` (measured, in the window) can be drawn; `undefined`: anywhere. */
  readonly move: (rect: WindowRect) => WindowRect | undefined;
}

/** What native-driven transforms above the view do to it. */
export interface NativeMotion {
  /** Nearest first. */
  readonly levels: readonly MotionLevel[];
  /** A native animation is running: where the view can be keeps changing. */
  readonly running: boolean;
  /** The native values the bounds came from, to watch for an animation starting. */
  readonly roots: readonly AnimatedNodeLike[];
}

/** How finely an easing or an interpolation is sampled. */
const SAMPLES = 20;
/** How much wider a sampled curve that turns back is taken to reach: a peak can fall between samples. */
const TURN_PAD = 0.1;

const TRANSLATE_AXES: Readonly<Record<string, 'x' | 'y'>> = { translateX: 'x', translateY: 'y' };
const SCALE_AXES: Readonly<Record<string, ReadonlyArray<'x' | 'y'>>> = {
  scale: ['x', 'y'],
  scaleX: ['x'],
  scaleY: ['y'],
};
/** Functions that, at these values, do nothing; anything else they do is unbounded. */
const IDENTITY: Readonly<Record<string, unknown>> = {
  rotate: '0deg',
  rotateX: '0deg',
  rotateY: '0deg',
  rotateZ: '0deg',
  skewX: '0deg',
  skewY: '0deg',
};

export interface AnimatedNodeLike {
  __getValue: () => unknown;
  [field: string]: unknown;
}

/** Values this module has seen in a running animation: still since, their JS value is the native one. */
const seenAnimating = new WeakSet<object>();

function isNode(value: unknown): value is AnimatedNodeLike {
  return value !== null && typeof value === 'object' && typeof (value as AnimatedNodeLike).__getValue === 'function';
}

/**
 * Whether `node` may be driven natively. A node without the flag at all is
 * of a kind this module does not know: taken as native.
 */
function isNativeNode(value: unknown): value is AnimatedNodeLike {
  return isNode(value) && (!('__isNative' in value) || value.__isNative === true);
}

function finiteNumber(value: unknown): value is number {
  return Number.isFinite(value as number);
}

function hull(values: readonly number[]): Range {
  return { lo: Math.min(...values), hi: Math.max(...values) };
}

/** `values` sampled along a curve, widened by {@link TURN_PAD} of its span when the curve turns back. */
function sampled(values: readonly number[]): Range {
  const range = hull(values);
  let rising = 0;
  let falling = 0;
  for (let index = 1; index < values.length; index += 1) {
    const step = (values[index] as number) - (values[index - 1] as number);
    rising ||= step > 0 ? 1 : 0;
    falling ||= step < 0 ? 1 : 0;
  }
  if (rising + falling < 2) {
    return range;
  }
  const pad = (range.hi - range.lo) * TURN_PAD;
  return { lo: range.lo - pad, hi: range.hi + pad };
}

const UNBOUNDED: NodeBound = { range: undefined, running: false, roots: [] };

/** An `Animated.Value`: its running timing animation's path, or its value if JS provably has it. */
function valueBound(node: AnimatedNodeLike): NodeBound {
  // Fields this module depends on, by name: renamed, nothing here can be trusted.
  if (!('_value' in node) || !('_offset' in node) || !('_animation' in node)) {
    return UNBOUNDED;
  }
  const now = node.__getValue();
  const offset = node._offset;
  if (!finiteNumber(now) || !finiteNumber(offset) || node._tracking != null) {
    return { ...UNBOUNDED, roots: [node] };
  }
  const animation = node._animation as Record<string, unknown> | null;
  if (animation == null) {
    const synced = seenAnimating.has(node) || (node.hasListeners as (() => boolean) | undefined)?.() === true;
    return { range: synced ? { lo: now, hi: now } : undefined, running: false, roots: [node] };
  }
  seenAnimating.add(node);
  const { _fromValue: from, _toValue: to, _easing: easing } = animation;
  if (!finiteNumber(from) || !finiteNumber(to) || typeof easing !== 'function') {
    return { range: undefined, running: true, roots: [node] };
  }
  const values = [now];
  const path: number[] = [];
  for (let step = 0; step <= SAMPLES; step += 1) {
    const eased = (easing as (t: number) => unknown)(step / SAMPLES);
    if (!finiteNumber(eased)) {
      return { range: undefined, running: true, roots: [node] };
    }
    path.push(offset + from + eased * (to - from));
  }
  const along = sampled(path);
  values.push(along.lo, along.hi);
  return { range: hull(values), running: true, roots: [node] };
}

/** An interpolation: through its mapping, or within its output range when it clamps both ends. */
function interpolationBound(node: AnimatedNodeLike): NodeBound {
  const input = nodeBound(node._parent as AnimatedNodeLike);
  const config = (node._config ?? {}) as Record<string, unknown>;
  const outputs = Array.isArray(config.outputRange) ? (config.outputRange as unknown[]) : [];
  const left = config.extrapolateLeft ?? config.extrapolate;
  const right = config.extrapolateRight ?? config.extrapolate;
  const clamped =
    left === 'clamp' && right === 'clamp' && outputs.length > 0 && outputs.every(finiteNumber)
      ? hull(outputs as number[])
      : undefined;
  const interpolate = (node._getInterpolation as (() => unknown) | undefined)?.();
  if (input.range === undefined || typeof interpolate !== 'function') {
    return { ...input, range: clamped };
  }
  const { lo, hi } = input.range;
  const breakpoints = Array.isArray(config.inputRange) ? (config.inputRange as unknown[]) : [];
  const samples = breakpoints.filter((point): point is number => finiteNumber(point) && point > lo && point < hi);
  for (let step = 0; step <= SAMPLES; step += 1) {
    samples.push(lo + ((hi - lo) * step) / SAMPLES);
  }
  samples.sort((a, b) => a - b);
  const values = samples.map((sample) => (interpolate as (input: number) => unknown)(sample));
  if (!values.every(finiteNumber)) {
    return { ...input, range: clamped };
  }
  return { ...input, range: sampled(values as number[]) };
}

function join(...bounds: NodeBound[]): Pick<NodeBound, 'running' | 'roots'> {
  return { running: bounds.some((bound) => bound.running), roots: bounds.flatMap((bound) => bound.roots) };
}

/** `add`, `subtract`, `multiply` (which keep the same fields), `divide`: from the operands, by intervals. */
function binaryBound(node: AnimatedNodeLike): NodeBound {
  const a = nodeBound(node._a as AnimatedNodeLike);
  const b = nodeBound(node._b as AnimatedNodeLike);
  const both = join(a, b);
  if (a.range === undefined || b.range === undefined) {
    return { range: undefined, ...both };
  }
  const as = [a.range.lo, a.range.hi];
  const bs = [b.range.lo, b.range.hi];
  const division = '_warnedAboutDivideByZero' in node;
  if (division && b.range.lo <= 0 && b.range.hi >= 0) {
    return { range: undefined, ...both };
  }
  const results = as.flatMap((x) => bs.map((y) => (division ? [x / y] : [x + y, x - y, x * y])).flat());
  return { range: hull(results), ...both };
}

/**
 * Every value `node` (a number or an `Animated` node) can take until the next
 * re-measure, whether a timing animation drives it, and the native values it
 * comes from. Computed once per node a measure pass.
 */
export function nodeBound(node: unknown): NodeBound {
  if (finiteNumber(node)) {
    return { range: { lo: node, hi: node }, running: false, roots: [] };
  }
  if (!isNode(node)) {
    return UNBOUNDED;
  }
  return passMemo(node, () => {
    // Every kind told apart by the fields that are its own.
    if ('_parent' in node) {
      return interpolationBound(node);
    }
    if ('_min' in node && '_max' in node) {
      const input = nodeBound(node._a);
      const { _min: min, _max: max } = node;
      return { ...input, range: finiteNumber(min) && finiteNumber(max) ? { lo: min, hi: max } : undefined };
    }
    if ('_modulus' in node) {
      const input = nodeBound(node._a);
      const modulus = node._modulus;
      return { ...input, range: finiteNumber(modulus) ? hull([0, modulus]) : undefined };
    }
    if ('_a' in node && '_b' in node) {
      return binaryBound(node);
    }
    return valueBound(node);
  });
}

/** The transform functions of `props.style`, as `[name, value]`; `null` when there is no list. */
function transformOf(props: unknown): Array<[string, unknown]> | null {
  const transform = styleValue((props as { style?: unknown } | null | undefined)?.style, 'transform');
  if (!Array.isArray(transform)) {
    return null;
  }
  return transform.flatMap((entry) =>
    entry !== null && typeof entry === 'object' ? Object.entries(entry as Record<string, unknown>) : [['?', entry]],
  ) as Array<[string, unknown]>;
}

/** One axis of an axis-aligned affine map: `q -> scale * q + shift`. */
interface Affine {
  scale: number;
  shift: number;
}

/** A transform origin on one axis: a fraction of the size plus a length. */
interface Origin {
  fraction: number;
  length: number;
}

const KEYWORDS: Readonly<Record<string, Origin>> = {
  left: { fraction: 0, length: 0 },
  top: { fraction: 0, length: 0 },
  center: { fraction: 0.5, length: 0 },
  right: { fraction: 1, length: 0 },
  bottom: { fraction: 1, length: 0 },
};

function originPart(part: unknown): Origin | undefined {
  if (finiteNumber(part)) {
    return { fraction: 0, length: part };
  }
  if (typeof part !== 'string') {
    return undefined;
  }
  const keyword = KEYWORDS[part];
  if (keyword !== undefined) {
    return keyword;
  }
  const match = /^(-?\d+(?:\.\d+)?)(%|px)?$/.exec(part);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  return match[2] === '%' ? { fraction: amount / 100, length: 0 } : { fraction: 0, length: amount };
}

/** The host's `transformOrigin`, per axis (the centre when unset); `undefined` when it cannot be read. */
export function originOf(props: unknown): { x: Origin; y: Origin } | undefined {
  const origin = styleValue((props as { style?: unknown } | null | undefined)?.style, 'transformOrigin');
  if (origin === undefined) {
    return { x: KEYWORDS.center as Origin, y: KEYWORDS.center as Origin };
  }
  const parts: unknown[] = Array.isArray(origin)
    ? origin
    : typeof origin === 'string'
      ? origin.trim().split(/\s+/)
      : [];
  if (parts.length === 0 || parts.length > 3) {
    return undefined;
  }
  const [first, second = 'center'] = parts;
  // CSS lets the keywords come either way round, and one alone name either axis.
  const swapped = first === 'top' || first === 'bottom' || second === 'left' || second === 'right';
  const x = originPart(swapped ? second : first);
  const y = originPart(swapped ? first : second);
  return x === undefined || y === undefined ? undefined : { x, y };
}

interface Step {
  axis: 'x' | 'y';
  kind: 'shift' | 'scale';
  bound: NodeBound;
  /** The value the host was rendered with; `undefined`: not in its props. */
  rendered: number | undefined;
  /** The value its node holds in JS now. */
  current: number | undefined;
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

/** Composes `steps` (innermost last, as CSS applies them) on one axis, each at `pick`'s value. */
function compose(steps: readonly Step[], axis: 'x' | 'y', pick: (step: Step) => number): Affine {
  let map: Affine = { scale: 1, shift: 0 };
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as Step;
    if (step.axis !== axis) {
      continue;
    }
    const value = pick(step);
    map =
      step.kind === 'shift'
        ? { scale: map.scale, shift: map.shift + value }
        : { scale: map.scale * value, shift: map.shift * value };
  }
  return map;
}

/** `[lo, hi]` carried through `steps` on one axis, every value of every step. */
function sweep(lo: number, hi: number, steps: readonly Step[], axis: 'x' | 'y'): Range {
  let range = { lo, hi };
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as Step;
    if (step.axis !== axis) {
      continue;
    }
    const by = step.bound.range as Range;
    range =
      step.kind === 'shift'
        ? { lo: range.lo + by.lo, hi: range.hi + by.hi }
        : hull([range.lo * by.lo, range.lo * by.hi, range.hi * by.lo, range.hi * by.hi]);
  }
  return range;
}

/**
 * The motion of one `Animated` component's transform, or `null` when it has
 * no native node in it.
 */
function levelOf(ancestry: Ancestry, fibers: readonly FiberLike[], index: number): NotNative | Level {
  const fiber = fibers[index] as FiberLike;
  if (isReanimatedComponent(fiber)) {
    return reanimatedTransform(fiber.memoizedProps) ? UNBOUNDED_LEVEL : NOT_NATIVE;
  }
  const entries = transformOf(fiber.memoizedProps);
  if (entries === null || !entries.some(([, value]) => isNativeNode(value))) {
    return NOT_NATIVE;
  }
  const host = hostBelow(ancestry, fibers, index);
  const rendered = new Map(transformOf(host.memoizedProps) ?? []);
  const steps: Step[] = [];
  const bounds: NodeBound[] = [];
  let bounded = true;
  for (const [name, value] of entries) {
    const bound = nodeBound(value);
    bounds.push(bound);
    const axes = TRANSLATE_AXES[name] !== undefined ? [TRANSLATE_AXES[name]] : SCALE_AXES[name];
    if (axes === undefined) {
      bounded &&= name in IDENTITY && value === IDENTITY[name];
      continue;
    }
    bounded &&= bound.range !== undefined;
    const at = rendered.get(name);
    const now = isNode(value) ? value.__getValue() : value;
    for (const axis of axes) {
      steps.push({
        axis,
        kind: TRANSLATE_AXES[name] !== undefined ? 'shift' : 'scale',
        bound,
        rendered: finiteNumber(at) ? at : undefined,
        current: finiteNumber(now) ? now : undefined,
      });
    }
  }
  const { running, roots } = join(...bounds);
  // The host is rendered with the component's style, `transformOrigin` included.
  const origin = originOf(host.memoizedProps);
  if (!bounded || origin === undefined) {
    return { running, roots, move: () => undefined };
  }
  return { running, roots, move: (rect) => moveThrough(rect, host, steps, origin) };
}

interface Level {
  running: boolean;
  roots: readonly AnimatedNodeLike[];
  move: (rect: WindowRect) => WindowRect | undefined;
}
type NotNative = null;
const NOT_NATIVE: NotNative = null;
const UNBOUNDED_LEVEL: Level = { running: false, roots: [], move: () => undefined };

/**
 * Every place `rect` (measured with the host's transform at whichever value
 * the shadow tree holds) can be drawn as `steps` take every value they can.
 */
function moveThrough(
  rect: WindowRect,
  host: FiberLike,
  steps: readonly Step[],
  origin: { x: Origin; y: Origin },
): WindowRect | undefined {
  const box = measureFiber(host);
  if (box == null) {
    return undefined;
  }
  // What the shadow tree may hold: the value React rendered, or the one the last animation ended at.
  const bases: Array<(step: Step) => number | undefined> = [(step) => step.rendered, (step) => step.current];
  const axes: Range[] = [];
  for (const axis of ['x', 'y'] as const) {
    const start = axis === 'x' ? rect.x : rect.y;
    const end = start + (axis === 'x' ? rect.width : rect.height);
    const hostStart = axis === 'x' ? box.x : box.y;
    const hostSize = axis === 'x' ? box.width : box.height;
    const out = [start, end];
    for (const base of bases) {
      if (steps.some((step) => base(step) === undefined)) {
        continue;
      }
      const map = compose(steps, axis, (step) => base(step) as number);
      // A scale of nothing, or a mirror: no frame to go back to.
      if (map.scale <= 0) {
        continue;
      }
      const at = origin[axis];
      // The origin, in the window: the host's measured box is its frame under `map` about it.
      const pivot = hostStart + at.fraction * hostSize + map.scale * at.length - map.shift;
      const local = [(start - pivot - map.shift) / map.scale, (end - pivot - map.shift) / map.scale];
      const reach = sweep(Math.min(...local), Math.max(...local), steps, axis);
      out.push(pivot + reach.lo, pivot + reach.hi);
    }
    if (out.length === 2 && steps.some((step) => step.axis === axis)) {
      return undefined;
    }
    axes.push(hull(out));
  }
  const [x, y] = axes as [Range, Range];
  return { x: x.lo, y: y.lo, width: x.hi - x.lo, height: y.hi - y.lo };
}

/** Whether a Reanimated component's animated style sets a transform. */
function reanimatedTransform(props: unknown): boolean {
  const style = (props as { style?: unknown } | null | undefined)?.style;
  const entries = Array.isArray(style) ? style.flat(Infinity) : [style];
  return entries.some((entry) => {
    const animated = entry as { viewDescriptors?: unknown; initial?: { value?: unknown } } | null | undefined;
    if (animated == null || typeof animated !== 'object' || !('viewDescriptors' in animated)) {
      return false;
    }
    const initial = animated.initial?.value;
    // Not readable: it may well move the view.
    return initial == null || typeof initial !== 'object' || 'transform' in initial;
  });
}

/**
 * The native-driven transforms above the view, nearest first, or `null`
 * when nothing above it is driven natively. Reads the props the last
 * `isHidden` resolved as committed.
 */
export function nativeMotion(ancestry: Ancestry): NativeMotion | null {
  if (ancestry.animated.length === 0) {
    return null;
  }
  const fibers = ancestry.resolved ?? ancestry.path;
  const levels: MotionLevel[] = [];
  let running = false;
  const roots: AnimatedNodeLike[] = [];
  for (const index of ancestry.animated) {
    let level: Level | null;
    // Props and nodes are the app's: a getter on one can throw.
    try {
      level = levelOf(ancestry, fibers, index);
    } catch {
      level = UNBOUNDED_LEVEL;
    }
    if (level === null) {
      continue;
    }
    running ||= level.running;
    roots.push(...level.roots);
    const { move } = level;
    levels.push({
      index,
      move: (rect) => {
        try {
          return move(rect);
        } catch {
          return undefined;
        }
      },
    });
  }
  return levels.length === 0 ? null : { levels, running, roots };
}


/**
 * Where the view, measured at `self`, can be drawn (`drawn`, before any
 * clipping) and what of that is on screen (`visible`): each native transform
 * level, nearest first, moves what the clippers below it left, and the
 * clippers above it cut that. A level that cannot be bounded draws it anywhere
 * on its surface.
 */
export function throughMotion(
  self: WindowRect,
  ancestry: Ancestry,
  motion: NativeMotion,
): { drawn: WindowRect; visible: WindowRect | null } {
  let drawn = self;
  let visible: WindowRect | null = self;
  let above = -1;
  for (const level of motion.levels) {
    drawn = level.move(drawn) ?? WHOLE_SURFACE;
    if (visible !== null) {
      visible = clipToAncestors(visible, ancestry, above, level.index);
    }
    if (visible !== null) {
      visible = level.move(visible) ?? WHOLE_SURFACE;
    }
    above = level.index;
  }
  return { drawn, visible: visible === null ? null : clipToAncestors(visible, ancestry, above) };
}
