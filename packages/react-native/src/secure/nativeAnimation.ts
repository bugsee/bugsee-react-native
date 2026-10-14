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
 *    overshoot included; still: its value, but only when JS provably has it.
 *    Natively, only animations (which JS starts, and which hand JS their end
 *    value) and native `Animated.event`s (a scroll, a gesture, whose values
 *    JS never sees) move a value. This module follows `Animated` components
 *    attaching and detaching those events: a value one is attached to is
 *    unbounded for as long as it is attached, animated or not. Where it
 *    cannot follow them (React Native moved its `AnimatedEvent`), any value
 *    is trusted only while the app listens to it;
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
 * a spring or decay; a value a native `Animated.event` is attached to; a
 * Reanimated component whose style can move the view (an animated style
 * that sets a transform, a shared value set inline, a CSS animation or
 * transition: Reanimated keeps its values on the UI thread).
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

/**
 * The values native `Animated.event`s are attached to, with how many each;
 * `null` when attachments cannot be followed. Followed from when this module
 * loads (an app attaches its events as its components mount, after that).
 */
let attachedEvents: WeakMap<object, number> | null = null;

/** How deep in an event's mapping its values are looked for (`{ nativeEvent: { contentOffset: { y } } }`). */
const MAPPING_DEPTH = 8;

/** The `Animated.Value`s in an `Animated.event` mapping (an `Animated.ValueXY`'s two included). */
function valuesIn(mapping: unknown, depth = 0): object[] {
  if (mapping === null || typeof mapping !== 'object' || depth > MAPPING_DEPTH) {
    return [];
  }
  if (isNode(mapping) && '_value' in mapping) {
    return [mapping];
  }
  return Object.values(mapping).flatMap((inner) => valuesIn(inner, depth + 1));
}

interface EventPrototype {
  __attach: (...args: unknown[]) => unknown;
  __detach: (...args: unknown[]) => unknown;
  _argMapping?: unknown;
}

/**
 * Follows the native attachments of every `eventClass` (React Native's
 * `AnimatedEvent`) from now on: an `Animated` component attaches each native
 * event in its props as it mounts, and detaches it as it unmounts or the prop
 * changes. Its prototype is wrapped. Anything else stops following them: a
 * still value is then trusted only while the app listens to it. Returns
 * whether they are followed.
 */
export function followEventAttachments(eventClass: unknown): boolean {
  const prototype = (eventClass as { prototype?: Partial<EventPrototype> } | null | undefined)?.prototype;
  const attach = prototype?.__attach;
  const detach = prototype?.__detach;
  if (typeof attach !== 'function' || typeof detach !== 'function') {
    attachedEvents = null;
    return false;
  }
  const counts = new WeakMap<object, number>();
  attachedEvents = counts;
  // Per event, the values of each attachment still in place, oldest first.
  const attachments = new WeakMap<object, object[][]>();
  const count = (values: readonly object[], by: number): void => {
    for (const value of values) {
      const next = (counts.get(value) ?? 0) + by;
      if (next > 0) {
        counts.set(value, next);
      } else {
        counts.delete(value);
      }
    }
  };
  (prototype as EventPrototype).__attach = function (this: EventPrototype, ...args) {
    const result = attach.apply(this, args);
    const values = valuesIn((this._argMapping as unknown[] | undefined)?.[0]);
    count(values, 1);
    attachments.set(this, [...(attachments.get(this) ?? []), values]);
    return result;
  };
  (prototype as EventPrototype).__detach = function (this: EventPrototype, ...args) {
    // Detached with nothing attached: nothing to count. (A string in either list counts no object.)
    // Stryker disable next-line ArrayDeclaration
    const [values = [], ...rest] = attachments.get(this) ?? [];
    attachments.set(this, rest);
    count(values, -1);
    return detach.apply(this, args);
  };
  return true;
}

// React Native's own class, where an app has it (not under Jest's mocks): an empty catch follows nothing.
// Stryker disable all
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- React Native's internals, where they are
  const module = require('react-native/Libraries/Animated/AnimatedEvent') as { AnimatedEvent?: unknown };
  followEventAttachments(module.AnimatedEvent);
} catch {
  attachedEvents = null;
}
// Stryker restore all

/** Whether a native `Animated.event` is attached to `node`: as far as is known, it may be. */
function eventDriven(node: AnimatedNodeLike): boolean {
  if (attachedEvents === null) {
    // Not known: only the app's listener streams its native value to JS.
    return (node.hasListeners as (() => boolean) | undefined)?.() !== true;
  }
  return attachedEvents.has(node);
}

function isNode(value: unknown): value is AnimatedNodeLike {
  return typeof (value as AnimatedNodeLike | null | undefined)?.__getValue === 'function';
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

/**
 * `values` sampled in order along a curve, widened by {@link TURN_PAD} of its
 * span when an extreme is not at an end: the curve turns back, and its peak
 * can fall between samples.
 */
function sampled(values: readonly number[]): Range {
  const range = hull(values);
  const ends = hull([values[0] as number, values[values.length - 1] as number]);
  if (range.lo === ends.lo && range.hi === ends.hi) {
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
  // An event moves it as well as any animation, wherever the gesture or the scroll takes it.
  if (eventDriven(node)) {
    return { range: undefined, running: animation != null, roots: [node] };
  }
  if (animation == null) {
    return { range: { lo: now, hi: now }, running: false, roots: [node] };
  }
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
  const outputs = config.outputRange;
  const left = config.extrapolateLeft ?? config.extrapolate;
  const right = config.extrapolateRight ?? config.extrapolate;
  const clamped =
    left === 'clamp' && right === 'clamp' && Array.isArray(outputs) && outputs.length > 0 && outputs.every(finiteNumber)
      ? hull(outputs as number[])
      : undefined;
  const interpolate = (node._getInterpolation as (() => unknown) | undefined)?.();
  if (input.range === undefined || typeof interpolate !== 'function') {
    return { ...input, range: clamped };
  }
  const { lo, hi } = input.range;
  // Stryker disable next-line ArrayDeclaration -- the filter below drops anything that is not a number
  const breakpoints = Array.isArray(config.inputRange) ? (config.inputRange as unknown[]) : [];
  // The ends are sampled anyway.
  // Stryker disable next-line EqualityOperator -- so taking them in as breakpoints too changes nothing
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

type Operation = (x: number, y: number) => number;

const divide: Operation = (x, y) => x / y;
const OPERATIONS: readonly Operation[] = [(x, y) => x + y, (x, y) => x - y, (x, y) => x * y, divide];

/**
 * Which operations `node` (with operands `_a` and `_b`) can be: `divide` by
 * its own field; otherwise those whose result on the operands' values now is
 * the node's value now (`add`, `subtract` and `multiply` keep the same
 * fields). Where several match (`x * 1` and `x / 1`), each is taken. None:
 * a kind this module does not know.
 */
function operationsOf(node: AnimatedNodeLike): readonly Operation[] {
  if ('_warnedAboutDivideByZero' in node) {
    return [divide];
  }
  const x = (node._a as AnimatedNodeLike).__getValue();
  const y = (node._b as AnimatedNodeLike).__getValue();
  const value = node.__getValue();
  return OPERATIONS.filter((operation) => operation(x as number, y as number) === value);
}

/** `add`, `subtract`, `multiply`, `divide`: from the operands, by intervals. */
function binaryBound(node: AnimatedNodeLike): NodeBound {
  const a = nodeBound(node._a as AnimatedNodeLike);
  const b = nodeBound(node._b as AnimatedNodeLike);
  const both = join(a, b);
  const operations = isNode(node._a) && isNode(node._b) ? operationsOf(node) : [];
  if (a.range === undefined || b.range === undefined || operations.length === 0) {
    return { range: undefined, ...both };
  }
  const as = [a.range.lo, a.range.hi];
  const bs = [b.range.lo, b.range.hi];
  if (operations.includes(divide) && b.range.lo <= 0 && b.range.hi >= 0) {
    return { range: undefined, ...both };
  }
  const results = as.flatMap((x) => bs.flatMap((y) => operations.map((operation) => operation(x, y))));
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
    if ('_min' in node) {
      const input = nodeBound(node._a);
      const { _min: min, _max: max } = node;
      return { ...input, range: finiteNumber(min) && finiteNumber(max) ? { lo: min, hi: max } : undefined };
    }
    if ('_modulus' in node) {
      const input = nodeBound(node._a);
      const modulus = node._modulus;
      return { ...input, range: finiteNumber(modulus) ? hull([0, modulus]) : undefined };
    }
    if ('_b' in node) {
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
  const keyword = KEYWORDS[part as string];
  if (keyword !== undefined) {
    return keyword;
  }
  const match = /^(-?\d+(?:\.\d+)?)(%|px)?$/.exec(String(part));
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
  if (!Array.isArray(origin) && typeof origin !== 'string') {
    return undefined;
  }
  const parts: unknown[] = Array.isArray(origin) ? origin : origin.trim().split(/\s+/);
  // An empty list names no axis, as an unknown word does, below.
  if (parts.length > 3) {
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
  /** A translation; otherwise a scale. */
  shift: boolean;
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
      step.shift
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
      step.shift
        ? { lo: range.lo + by.lo, hi: range.hi + by.hi }
        : hull([range.lo * by.lo, range.lo * by.hi, range.hi * by.lo, range.hi * by.hi]);
  }
  return range;
}

/**
 * The motion of one `Animated` component's transform; `null` when it has no
 * `Animated` node in it. Nodes none of which is native yet move nothing now,
 * but the first animation with the native driver makes them native and
 * commits nothing: they are only watched (and with nothing to watch, the view
 * is re-measured every frame).
 */
function levelOf(ancestry: Ancestry, fibers: readonly FiberLike[], index: number): NotNative | Level | Pending {
  const fiber = fibers[index] as FiberLike;
  if (isReanimatedComponent(fiber)) {
    return reanimatedMoves(fiber.memoizedProps) ? UNBOUNDED_LEVEL : NOT_NATIVE;
  }
  const entries = transformOf(fiber.memoizedProps);
  if (entries === null) {
    return NOT_NATIVE;
  }
  const nodes = entries.filter(([, value]) => isNode(value));
  if (nodes.length === 0) {
    return NOT_NATIVE;
  }
  if (!nodes.some(([, value]) => isNativeNode(value))) {
    const roots = nodes.flatMap(([, value]) => nodeBound(value).roots);
    return { running: roots.length === 0, roots, move: undefined };
  }
  const host = hostBelow(ancestry, fibers, index);
  // By place: a function can come twice (`translateX` twice), each with its own value.
  // A string in place of the list, or of an entry, names no transform function.
  // Stryker disable next-line ArrayDeclaration
  const rendered = transformOf(host.memoizedProps) ?? [];
  const steps: Step[] = [];
  const bounds: NodeBound[] = [];
  let bounded = true;
  for (const [place, [name, value]] of entries.entries()) {
    const bound = nodeBound(value);
    bounds.push(bound);
    const axes = TRANSLATE_AXES[name] !== undefined ? [TRANSLATE_AXES[name]] : SCALE_AXES[name];
    if (axes === undefined) {
      bounded &&= name in IDENTITY && value === IDENTITY[name];
      continue;
    }
    // Without this, sweeping a missing range throws, which reads as unbounded too.
    // Stryker disable next-line AssignmentOperator,ConditionalExpression -- so its mutants are equivalent
    bounded &&= bound.range !== undefined;
    // Stryker disable next-line ArrayDeclaration -- as above
    const [renderedName, at] = rendered[place] ?? [];
    const now = isNode(value) ? value.__getValue() : value;
    for (const axis of axes) {
      steps.push({
        axis,
        shift: TRANSLATE_AXES[name] !== undefined,
        bound,
        rendered: renderedName === name && finiteNumber(at) ? at : undefined,
        current: finiteNumber(now) ? now : undefined,
      });
    }
  }
  const { running, roots } = join(...bounds);
  // Scaled up in the shadow tree: the levels inside it move the view by more than their own values.
  const scaled = steps.some(
    (step) => !step.shift && [step.rendered, step.current].some((at) => Math.abs(at ?? 1) > 1),
  );
  // The host is rendered with the component's style, `transformOrigin` included.
  const origin = originOf(host.memoizedProps);
  // Without the second test, reading a missing origin throws, which reads as unbounded too.
  // Stryker disable next-line ConditionalExpression -- so its mutant is equivalent
  if (!bounded || origin === undefined) {
    return { running, roots, move: () => undefined, scaled };
  }
  return { running, roots, move: (rect) => moveThrough(rect, host, steps, origin), scaled };
}

interface Level {
  running: boolean;
  roots: readonly AnimatedNodeLike[];
  move: (rect: WindowRect) => WindowRect | undefined;
  /** Its transform scales the view up in the shadow tree (by more than 1, or less than -1). */
  scaled: boolean;
}
/** Nodes not native yet: watched, moving nothing. */
interface Pending {
  running: boolean;
  roots: readonly AnimatedNodeLike[];
  move: undefined;
}
type NotNative = null;
const NOT_NATIVE: NotNative = null;
const UNBOUNDED_LEVEL: Level = { running: false, roots: [], move: () => undefined, scaled: false };

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
  // Without this, reading a missing box throws, which reads as unbounded too.
  // Stryker disable next-line ConditionalExpression,BlockStatement -- so its mutants are equivalent
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
    // No value of the shadow tree to go back from: nothing is known.
    if (out.length === 2) {
      return undefined;
    }
    axes.push(hull(out));
  }
  const [x, y] = axes as [Range, Range];
  return { x: x.lo, y: y.lo, width: x.hi - x.lo, height: y.hi - y.lo };
}

/** Whether `value` looks like a Reanimated shared value, which moves on the UI thread. */
function sharedValueLike(value: unknown): boolean {
  const shared = value as { _isReanimatedSharedValue?: unknown; modify?: unknown } | null | undefined;
  return (
    shared != null &&
    typeof shared === 'object' &&
    (shared._isReanimatedSharedValue === true || typeof shared.modify === 'function')
  );
}

/** CSS animations and transitions (Reanimated 4) can move the view without a commit. */
// No React Native style name has these words anywhere but at its start.
// Stryker disable next-line Regex
const CSS_MOTION = /^(transition|animation)/;

/**
 * Whether a Reanimated component's style can move the view natively: an
 * animated style that sets a transform, a shared value set inline (in the
 * style or its transform), or a CSS animation or transition.
 */
function reanimatedMoves(props: unknown): boolean {
  const style = (props as { style?: unknown } | null | undefined)?.style;
  const entries = Array.isArray(style) ? style.flat(Infinity) : [style];
  return entries.some((entry) => {
    const animated = entry as { viewDescriptors?: unknown; initial?: { value?: unknown } } | null | undefined;
    if (animated == null || typeof animated !== 'object') {
      return false;
    }
    if (!('viewDescriptors' in animated)) {
      const fields = Object.entries(animated as Record<string, unknown>);
      const transform = (animated as { transform?: unknown }).transform;
      // Not a list: no shared value in it. (A string in its place is none either.)
      // Stryker disable next-line ArrayDeclaration
      const functions = Array.isArray(transform) ? transform.flatMap((step) => Object.values(Object(step))) : [];
      return (
        fields.some(([key, value]) => CSS_MOTION.test(key) || sharedValueLike(value)) || functions.some(sharedValueLike)
      );
    }
    // Not readable: it may well move the view (a read that throws is read as unbounded, too).
    // Stryker disable next-line OptionalChaining,ConditionalExpression,LogicalOperator -- so these are equivalent
    const initial = animated.initial?.value;
    // Stryker disable next-line ConditionalExpression,LogicalOperator -- as above
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
  // Scaled levels' places in `levels`, to unbound the levels inside them.
  const scaledAt: number[] = [];
  for (const index of ancestry.animated) {
    let level: Level | Pending | null;
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
    if (level.move === undefined) {
      continue;
    }
    if (level.scaled) {
      scaledAt.push(levels.length);
    }
    const { move } = level;
    levels.push({
      index,
      // An empty catch returns undefined all the same.
      // Stryker disable all
      move: (rect) => {
        try {
          return move(rect);
        } catch {
          return undefined;
        }
      },
      // Stryker restore all
    });
  }
  // A level inside one the shadow tree scales is bounded in units that scale does not apply to.
  const outermost = Math.max(0, ...scaledAt);
  for (let inner = 0; inner < outermost; inner += 1) {
    levels[inner] = { index: (levels[inner] as MotionLevel).index, move: () => undefined };
  }
  return levels.length === 0 && roots.length === 0 && !running ? null : { levels, running, roots };
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
