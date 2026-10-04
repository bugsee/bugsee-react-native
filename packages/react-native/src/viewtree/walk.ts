/**
 * Turns a React fiber tree into a privacy-safe "managed view tree": a plain,
 * serialisable description of what is on screen, with no text content and no
 * prop other than `testID`/`nativeID` ever read off a fiber (and, per the
 * plan's payload contract, `testID`/`nativeID` only on host nodes).
 *
 * Pure on purpose: no import of `react` or `react-native`. Everything this
 * module needs to know about the host platform, the renderer and the two
 * component identities it must treat specially (the secure boundary and the
 * wrap component) arrives through `WalkEnv`, so this file is testable with
 * nothing but plain objects (see `__tests__/fakeFibers.ts`) and stays true
 * whether it is walking a fake tree or a real one.
 *
 * The walk itself is iterative (an explicit stack, not recursion): a fiber
 * tree is untrusted input as far as this module is concerned (it did not
 * build it), and a long transparent chain — thousands of Fragments, or a
 * pathological `Suspense`/context nesting — must not exhaust the JS call
 * stack the way naive recursion would. Cycles (a `.child` or `.sibling` that
 * loops back on itself) are detected with a visited set rather than assumed
 * away, and `.child`/`.sibling`/`.return` being `undefined` or some other
 * non-object value is tolerated the same as `null` throughout.
 */
import { FiberTag } from './fiber';
import type { FiberLike, WindowRect } from './fiber';

export const VH_WALK_BUDGET_MS = 250;
export const VH_MAX_NODES = 2000;
export const VH_MAX_DEPTH = 64;
export const VH_TAG_MAX_LENGTH = 99;
export const VH_IOS_DECIMALS = 2;

// Not part of the public contract: a ceiling on the total number of fibers
// *visited* (emitted or not — Fragments, providers, HostText, wrappers...).
// Generous relative to VH_MAX_NODES, since most visited fibers are never
// emitted, but it exists so a pathological shape (a very long transparent
// chain, a wide fan-out, or either under a frozen `now()`) cannot make the
// walk do unbounded work even though it can no longer overflow the stack.
const VH_FIBER_VISIT_BUDGET = VH_MAX_NODES * 8;

// A defensive bound on `fiberRootOf`-adjacent list-walks this module itself
// does (see `hasVisibleContentChild`): never more than a sanity check on a
// sibling chain, so a cyclic `.sibling` there cannot hang either.
const SIBLING_PEEK_CAP = 10_000;

export interface ManagedNode {
  id: string;
  class_name: string;
  bounds: [number, number, number, number];
  options: {
    kind: 'root' | 'surface' | 'composite' | 'host';
    secure?: true;
    tag?: string;
    native_id?: string;
  };
  subitems?: ManagedNode[];
  truncated?: true;
}

export interface WalkEnv {
  measure(fiber: FiberLike): WindowRect | null;
  /** True for the fiber that is the `<BugseeSecure>` boundary itself. */
  isSecureBoundary(fiber: FiberLike): boolean;
  /** True for the wrap component's own fiber, or the anchor it renders. */
  isWrapper(fiber: FiberLike): boolean;
  platform: 'android' | 'ios';
  scale: number;
  originX: number;
  originY: number;
  /**
   * Display origin of the React root that hosts `nativeTag`, when known.
   * A `<Modal>`'s dialog root must not inherit the activity root's origin.
   * Falls back to {@link originX}/{@link originY} when absent or null.
   */
  originForNativeTag?: (nativeTag: number) => { x: number; y: number } | null;
  /** Native tag of a host fiber's public instance, when measurable. */
  nativeTagOf?: (fiber: FiberLike) => number | null;
  /** ms; the budget is measured from this function's first call. */
  now(): number;
}

type Bounds = [number, number, number, number];

interface Ctx {
  env: WalkEnv;
  startedAt: number;
  emittedCount: number;
  fiberVisits: number;
  /** Why doesn't matter beyond this: every stop, whatever tripped it, marks whichever fiber was mid-visit truncated the same way (see the payload contract — "depth, node cap or budget" are one case, not three). */
  stopped: boolean;
  /** Set the moment any node (host, composite, surface or root) is marked `truncated`, so the root can carry it too regardless of where it happened. */
  anyTruncated: boolean;
  /** Every fiber visited so far, across every root — a repeat means a cycle, not a legitimate second visit (a well-formed tree never revisits a fiber). */
  visited: Set<FiberLike>;
}

/** The children collected for one fiber (or one fiber root), plus whether that list is known to be incomplete. */
interface Frame {
  nodes: ManagedNode[];
  truncated: boolean;
}

type Task =
  | { kind: 'visit'; fiber: FiberLike; secure: boolean; depthRemaining: number; frame: Frame }
  | {
      kind: 'finishHost';
      frame: Frame;
      parentFrame: Frame;
      className: string;
      bounds: Bounds;
      secureHere: boolean;
      tagOpts: TagOpts;
      depthCut: boolean;
    }
  | { kind: 'finishComposite'; frame: Frame; parentFrame: Frame; className: string; secureHere: boolean }
  | { kind: 'finishFlatten'; frame: Frame; parentFrame: Frame };

type TagOpts = { tag?: string; native_id?: string };

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** Loose on purpose: a malformed fiber's link being `undefined` (or anything else non-object) ends a walk the same way `null` does. */
function linkOf(value: unknown): FiberLike | null {
  return isObject(value) ? (value as unknown as FiberLike) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function androidBounds(rect: WindowRect, env: WalkEnv, originX: number, originY: number): Bounds {
  return [
    Math.round(rect.x * env.scale) + originX,
    Math.round(rect.y * env.scale) + originY,
    Math.round(rect.width * env.scale),
    Math.round(rect.height * env.scale),
  ];
}

function iosBounds(rect: WindowRect, env: WalkEnv, originX: number, originY: number): Bounds {
  return [
    round2(rect.x + originX),
    round2(rect.y + originY),
    round2(rect.width),
    round2(rect.height),
  ];
}

function originForFiber(fiber: FiberLike, env: WalkEnv): { x: number; y: number } {
  const tag = env.nativeTagOf?.(fiber) ?? null;
  if (tag != null && env.originForNativeTag) {
    const resolved = env.originForNativeTag(tag);
    if (resolved != null) {
      return resolved;
    }
  }
  return { x: env.originX, y: env.originY };
}

function toBounds(rect: WindowRect, env: WalkEnv, fiber: FiberLike): Bounds {
  const origin = originForFiber(fiber, env);
  return env.platform === 'android'
    ? androidBounds(rect, env, origin.x, origin.y)
    : iosBounds(rect, env, origin.x, origin.y);
}

function unionBounds(boxes: readonly Bounds[], env: WalkEnv): Bounds {
  // Every call site only builds a composite, surface or root node (and thus
  // only ever calls this) once it already knows there is at least one child
  // to draw bounds from, so `boxes` is never empty here.
  const first = boxes[0] as Bounds;
  let minX = first[0];
  let minY = first[1];
  let maxX = first[0] + first[2];
  let maxY = first[1] + first[3];
  for (let i = 1; i < boxes.length; i += 1) {
    const box = boxes[i] as Bounds;
    minX = Math.min(minX, box[0]);
    minY = Math.min(minY, box[1]);
    maxX = Math.max(maxX, box[0] + box[2]);
    maxY = Math.max(maxY, box[1] + box[3]);
  }
  const bounds: Bounds = [minX, minY, maxX - minX, maxY - minY];
  return env.platform === 'ios' ? (bounds.map(round2) as Bounds) : bounds;
}

/** `displayName`, then `name`, then `'Anonymous'` — never the fiber's props. */
function nameOf(candidate: unknown): string {
  if (typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)) {
    const named = candidate as { displayName?: unknown; name?: unknown };
    if (typeof named.displayName === 'string' && named.displayName.length > 0) {
      return named.displayName;
    }
    if (typeof named.name === 'string' && named.name.length > 0) {
      return named.name;
    }
  }
  return 'Anonymous';
}

/** The object's own `displayName`, if it has a non-empty string one — `null` otherwise. Factored out of `preferOuterName` so a multi-level unwrap (`memo(forwardRef(fn))`, see `compositeClassName`) can check each level's own `displayName` before falling all the way through to the innermost function's `.name`. */
function displayNameOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const displayName = (value as { displayName?: unknown }).displayName;
    if (typeof displayName === 'string' && displayName.length > 0) {
      return displayName;
    }
  }
  return null;
}

/** A manually-set `displayName` on the outer (wrapper) object wins over the inner component's own name — the same preference `getComponentNameFromType` and DevTools use. */
function preferOuterName(outer: unknown, inner: unknown): string {
  return displayNameOf(outer) ?? nameOf(inner);
}

/**
 * ForwardRef and Memo/SimpleMemo unwrap to the component they wrap — but the
 * two shapes React actually builds are different, verified against a real
 * fiber tree (`__tests__/realFiberNaming.test.ts`) and against
 * `updateMemoComponent`/`updateMemoComponent`'s SimpleMemo downgrade in the
 * bundled renderer:
 * - `ForwardRef` (11): `fiber.type` is the wrapper `{ $$typeof, render }`.
 * - `Memo` (14): `fiber.type` is the wrapper `{ $$typeof, type, compare }` —
 *   React only downgrades a *plain-function, comparator-less* `memo(...)` to
 *   SimpleMemo; a class component, a custom `compare`, or `defaultProps`
 *   keeps the fiber at this tag, with the wrapped component on `.type.type`.
 * - `SimpleMemo` (15): React reassigns `fiber.type` to the inner function
 *   *directly* the first time such a fiber renders; the memo wrapper itself
 *   survives only on `fiber.elementType`.
 *
 * `memo(forwardRef(fn))` (a very common React Native pattern) is a Memo
 * fiber that does NOT downgrade (its wrapped type, a ForwardRef wrapper
 * object, is not a plain function) — so `.type.type` is the ForwardRef
 * wrapper `{ $$typeof, render }` itself, not `fn`. Left alone, naming that
 * wrapper object the same way as any other "inner" value gives
 * `'Anonymous'` (it has no `.name`, and usually no `.displayName` either).
 * DevTools' own `resolveFiberType` unwraps this one level further, the same
 * way it already unwraps a bare ForwardRef fiber, so this does too: any
 * `displayName` set on the Memo wrapper wins first, then any `displayName`
 * set on the ForwardRef wrapper itself, then finally `fn`'s own name.
 */
function compositeClassName(fiber: FiberLike): string {
  if (fiber.tag === FiberTag.ForwardRef) {
    const render = (fiber.type as { render?: unknown } | null)?.render;
    return preferOuterName(fiber.type, render);
  }
  if (fiber.tag === FiberTag.Memo) {
    const inner = (fiber.type as { type?: unknown } | null)?.type;
    if (typeof inner === 'object' && inner !== null && 'render' in inner) {
      const render = (inner as { render?: unknown }).render;
      return displayNameOf(fiber.type) ?? displayNameOf(inner) ?? nameOf(render);
    }
    return preferOuterName(fiber.type, inner);
  }
  if (fiber.tag === FiberTag.SimpleMemo) {
    return preferOuterName(fiber.elementType, fiber.type);
  }
  return nameOf(fiber.type);
}

/**
 * `compositeClassName` guarded against a throwing `displayName`/`name`/
 * `render`/`type` getter anywhere along its (potentially multi-level) read
 * path: falls back to `'Anonymous'` rather than losing the whole node (see
 * `runWalk`'s per-fiber `try` for the rest of the "one throw drops only its
 * own contribution" contract — this is the one call within it that gets its
 * own dedicated fallback, per the review, rather than the generic one).
 */
function safeCompositeClassName(fiber: FiberLike): string {
  try {
    return compositeClassName(fiber);
  } catch {
    return 'Anonymous';
  }
}

/** Real host types are always strings (the native component name). Anything else is a malformed or hostile fiber, and `String(x)` would run an arbitrary `toString` this module has no business invoking. Also guarded against a throwing `.type` getter, same reasoning as `safeCompositeClassName`. */
function safeHostClassName(fiber: FiberLike): string {
  try {
    return typeof fiber.type === 'string' ? fiber.type : 'Unknown';
  } catch {
    return 'Unknown';
  }
}

type Kind = 'host' | 'composite' | 'transparent';

function classify(tag: number): Kind {
  switch (tag) {
    case FiberTag.HostComponent:
      return 'host';
    case FiberTag.FunctionComponent:
    case FiberTag.ClassComponent:
    case FiberTag.ForwardRef:
    case FiberTag.Memo:
    case FiberTag.SimpleMemo:
      return 'composite';
    default:
      // Fragment, Mode, ContextConsumer, ContextProvider, HostPortal,
      // HostRoot, Profiler, Suspense: none of these are visual on their own,
      // so their children are flattened into whichever ancestor node ends up
      // containing them. Offscreen and LegacyHidden are handled before this
      // is ever called (see `isHidden`).
      return 'transparent';
  }
}

/**
 * Offscreen/LegacyHidden visibility is not a prop: React's own commit phase
 * reads `memoizedState` for it (see `FiberLike.memoizedState`'s doc comment
 * in `fiber.ts`) — hidden while it holds a `{ baseLanes, cachePool }` object,
 * visible once it is `null` again. This never touches `memoizedProps`.
 *
 * Fails closed: `LegacyHidden` is an unstable, internal-only tag with no
 * shape this module has verified against a real renderer, so it is always
 * treated as hidden — privacy over completeness for a tag OSS React does not
 * even expose. For `Offscreen`, anything other than exactly `null` (the one
 * value React's own "visible" branch produces) is likewise treated as
 * hidden, so an unrecognised future shape drops the subtree instead of
 * showing it.
 */
function isHidden(fiber: FiberLike): boolean {
  if (fiber.tag === FiberTag.LegacyHidden) {
    return true;
  }
  return fiber.memoizedState !== null;
}

/** Reads `testID`/`nativeID` and nothing else — the only props this module ever touches, only for host nodes (the plan's payload contract), and only when the node is not secure. Never throws: a throwing prop getter yields no tag, not a crashed walk. */
function tagOptions(fiber: FiberLike): TagOpts {
  try {
    const props = fiber.memoizedProps as { testID?: unknown; nativeID?: unknown } | null | undefined;
    const out: TagOpts = {};
    const testID = props?.testID;
    if (typeof testID === 'string' && testID.length <= VH_TAG_MAX_LENGTH) {
      out.tag = testID;
    }
    const nativeID = props?.nativeID;
    if (typeof nativeID === 'string' && nativeID.length <= VH_TAG_MAX_LENGTH) {
      out.native_id = nativeID;
    }
    return out;
  } catch {
    return {};
  }
}

function safeNow(env: WalkEnv): number {
  try {
    // `Number.isFinite` (unlike the global `isFinite`) never coerces its
    // argument — it is already `false` for anything that is not a plain
    // finite number, including every non-number value, so a separate
    // `typeof value === 'number'` guard ahead of it would only ever agree.
    const value = env.now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safeMeasure(env: WalkEnv, fiber: FiberLike): WindowRect | null {
  try {
    return env.measure(fiber);
  } catch {
    return null;
  }
}

/**
 * Fails closed (N2): a throwing `env.isSecureBoundary` is treated as though
 * the boundary *is* there, not as though it were absent. This is the one
 * `safe*` wrapper in this file whose failure mode does not default to "skip
 * it" — every other guarded call degrades to a smaller payload (no tag, no
 * measurement, not the wrapper), but defaulting *this* one to "not secure"
 * would mean a throwing predicate leaks `testID`/`nativeID` from whatever is
 * inside `<BugseeSecure>`, which is a privacy regression, not merely a
 * smaller payload. Consistent with `isHidden`'s own fail-closed stance for
 * Offscreen/LegacyHidden.
 */
function safeIsSecureBoundary(env: WalkEnv, fiber: FiberLike): boolean {
  try {
    return env.isSecureBoundary(fiber);
  } catch {
    return true;
  }
}

/**
 * A throwing `env.isWrapper` is treated as "this is not the wrap component",
 * which is the *opposite* failure direction from `safeIsSecureBoundary`
 * above, deliberately: `isWrapper` decides whether to skip a node while
 * still keeping its children (`pushFlatten`), never whether to withhold
 * anything, so there is no privacy reason to fail toward "yes, treat this as
 * the wrapper" — and doing so would be actively wrong, since the wrapper's
 * *content* (the anchor's children) is the one thing the walk must not lose
 * just because a predicate broke. Failing to `false` here means the fiber is
 * simply emitted as a normal node instead — nothing is dropped, unlike a
 * failure in `safeIsSecureBoundary`, where failing "open" would drop
 * privacy protection instead of dropping data.
 */
function safeIsWrapper(env: WalkEnv, fiber: FiberLike): boolean {
  try {
    return env.isWrapper(fiber);
  } catch {
    return false;
  }
}

/**
 * Whether a depth cut at `firstChild` would actually hide anything: a host
 * whose only child is `HostText` (`<Text>plain string</Text>`, the common
 * case) never emits that child anyway, so cutting it off is not a loss worth
 * flagging. Only looks at `.tag` and `.sibling` — never `.child` (that would
 * defeat the point of not recursing) and never a prop.
 *
 * Bounded and cycle-safe: an inconclusive walk (a cyclic or implausibly long
 * sibling chain) reports "yes, something real might be there" rather than
 * silently swallowing a truncation that may be genuine.
 */
function hasVisibleContentChild(firstChild: FiberLike): boolean {
  const seen = new Set<FiberLike>();
  let child: FiberLike | null = firstChild;
  let steps = 0;
  while (child !== null) {
    if (steps >= SIBLING_PEEK_CAP || seen.has(child)) {
      return true;
    }
    seen.add(child);
    if (child.tag !== FiberTag.HostText) {
      return true;
    }
    child = linkOf(child.sibling);
    steps += 1;
  }
  return false;
}

function checkStop(ctx: Ctx): boolean {
  if (ctx.stopped) {
    return true;
  }
  const overTimeBudget = safeNow(ctx.env) - ctx.startedAt > VH_WALK_BUDGET_MS;
  const overNodeBudget = ctx.emittedCount >= VH_MAX_NODES;
  const overFiberVisitBudget = ctx.fiberVisits > VH_FIBER_VISIT_BUDGET;
  if (overTimeBudget || overNodeBudget || overFiberVisitBudget) {
    ctx.stopped = true;
    return true;
  }
  return false;
}

// Every node's real `id` is assigned by `renumberPreorder`, unconditionally,
// once the whole tree is built — nothing before that point reads a node's
// `id`, so `makeNode` never takes one; it always starts a node off with this
// same placeholder, which final id it ends up with is simply not this
// function's concern.
const PLACEHOLDER_ID = '';

function makeNode(
  className: string,
  kind: ManagedNode['options']['kind'],
  bounds: Bounds,
  secure: boolean,
  tagOpts: TagOpts,
  children: ManagedNode[],
  truncated: boolean,
  ctx: Ctx,
): ManagedNode {
  const options: ManagedNode['options'] = { kind };
  if (secure) {
    options.secure = true;
  } else {
    if (tagOpts.tag !== undefined) {
      options.tag = tagOpts.tag;
    }
    if (tagOpts.native_id !== undefined) {
      options.native_id = tagOpts.native_id;
    }
  }
  const node: ManagedNode = { id: PLACEHOLDER_ID, class_name: className, bounds, options };
  if (children.length > 0) {
    node.subitems = children;
  }
  if (truncated) {
    node.truncated = true;
    ctx.anyTruncated = true;
  }
  return node;
}

/** Pushes the work to flatten `fiber`'s children directly into `parentFrame` — used for every "this fiber emits nothing of its own" case (transparent tags, the wrap component/anchor, a visible Offscreen/LegacyHidden, and an unmeasurable host promoting its children per the plan's "no measurable host" rule). */
function pushFlatten(stack: Task[], fiber: FiberLike, secure: boolean, depthRemaining: number, parentFrame: Frame): void {
  const child = linkOf(fiber.child);
  if (child === null) {
    return;
  }
  const frame: Frame = { nodes: [], truncated: false };
  stack.push({ kind: 'finishFlatten', frame, parentFrame });
  stack.push({ kind: 'visit', fiber: child, secure, depthRemaining, frame });
}

/**
 * Walks every fiber reachable from `rootFiber` (its siblings included, so it
 * can be called directly on what a fiber root's `.current` is), collecting
 * emitted nodes into `outerFrame`. Iterative: an explicit stack instead of
 * recursion, so neither a long transparent chain nor a cycle can exhaust the
 * JS call stack or loop forever.
 */
function runWalk(rootFiber: FiberLike, ctx: Ctx, outerFrame: Frame): void {
  const stack: Task[] = [{ kind: 'visit', fiber: rootFiber, secure: false, depthRemaining: VH_MAX_DEPTH, frame: outerFrame }];

  while (stack.length > 0) {
    const task = stack.pop() as Task;

    if (task.kind === 'finishFlatten') {
      task.parentFrame.nodes.push(...task.frame.nodes);
      task.parentFrame.truncated = task.parentFrame.truncated || task.frame.truncated;
      continue;
    }

    if (task.kind === 'finishHost') {
      const truncatedHere = task.depthCut || task.frame.truncated;
      const node = makeNode(task.className, 'host', task.bounds, task.secureHere, task.tagOpts, task.frame.nodes, truncatedHere, ctx);
      task.parentFrame.nodes.push(node);
      continue;
    }

    if (task.kind === 'finishComposite') {
      if (task.frame.nodes.length === 0) {
        // Nothing measurable under this composite (or a depth cut that never
        // got to recurse at all): it contributes no node of its own, so
        // whatever was cut bubbles to whichever ancestor DOES get emitted,
        // instead of being reported on a composite that was never there.
        task.parentFrame.truncated = task.parentFrame.truncated || task.frame.truncated;
        continue;
      }
      const node = makeNode(
        task.className,
        'composite',
        unionBounds(
          task.frame.nodes.map((n) => n.bounds),
          ctx.env,
        ),
        task.secureHere,
        {},
        task.frame.nodes,
        task.frame.truncated,
        ctx,
      );
      task.parentFrame.nodes.push(node);
      continue;
    }

    // Exhaustive given `Task`'s declared shape: 'finishFlatten', 'finishHost'
    // and 'finishComposite' are handled (and `continue`d past) above,
    // leaving only 'visit' — checked explicitly, rather than assumed by
    // falling through, so a `Task` built with any other `kind` is caught
    // here instead of silently being treated as a fiber to visit.
    if ((task as { kind: unknown }).kind !== 'visit') {
      throw new Error('unreachable view-tree task kind');
    }
    const { fiber, secure, depthRemaining, frame } = task;

    // N5 (fix round 2): everything from here on reads fields off `fiber`
    // itself — `.tag`, `.sibling`, `.child`, `.type`, `.elementType`,
    // `.memoizedState`, and (inside `safeCompositeClassName`/`nameOf`) a
    // `displayName`/`name`/`render` getter one or two levels down. A fiber
    // tree is untrusted input (this module did not build it), so any one of
    // those can be a throwing getter without the whole walk being allowed to
    // die for it. This `try` is scoped to exactly one fiber's own visit: if
    // it throws, only THIS fiber's contribution is lost (`frame.truncated`
    // is set on the frame it would have contributed to, and the loop moves
    // on) — every sibling already pushed, and every ancestor's pending
    // `finish*` task lower on the stack, is unaffected and still runs
    // normally afterward. `safeCompositeClassName`/`safeHostClassName`
    // additionally catch their own, narrower throw first, so a bad
    // `displayName` alone degrades to `'Anonymous'`/`'Unknown'` on an
    // otherwise-normal node instead of losing the node at all — this outer
    // `try` is the backstop for everything neither of those, nor
    // `safeMeasure`/`safeIsSecureBoundary`/`safeIsWrapper`/`tagOptions`
    // (each already self-guarded), catches on its own.
    try {
      if (ctx.visited.has(fiber)) {
        // A repeat visit only happens via a `.child`/`.sibling` cycle in a
        // well-formed walk (nothing legitimate revisits the same fiber): stop
        // this path rather than loop forever, and say so.
        frame.truncated = true;
        continue;
      }
      ctx.visited.add(fiber);

      // The sibling chain continues after this fiber (and everything it
      // produces) is fully resolved — pushed now, ahead of whatever this
      // fiber itself pushes next, so the LIFO stack only reaches it once
      // this fiber's own subtree is done. Skipped once the walk has already
      // stopped (a budget tripped by an earlier fiber): pushing it would
      // only have it immediately self-terminate via `checkStop` the moment
      // it is popped, one sibling at a time — checking here instead drops
      // the whole remaining sibling chain in one step, not `O(siblings)`.
      // Not marking `frame.truncated` here on the skip: `checkStop(ctx)`,
      // two lines below, already returns `true` immediately whenever
      // `ctx.stopped` is set (its very first check), which marks this same
      // `frame` truncated for THIS fiber regardless — doing it here too
      // would only be the identical write a second time, not a different
      // outcome for anything this walk produces.
      const sibling = linkOf(fiber.sibling);
      if (sibling !== null && !ctx.stopped) {
        stack.push({ kind: 'visit', fiber: sibling, secure, depthRemaining, frame });
      }

      ctx.fiberVisits += 1;
      if (checkStop(ctx)) {
        frame.truncated = true;
        continue;
      }

      if (fiber.tag === FiberTag.HostText) {
        continue;
      }

      const secureHere = secure || safeIsSecureBoundary(ctx.env, fiber);

      if (safeIsWrapper(ctx.env, fiber)) {
        pushFlatten(stack, fiber, secureHere, depthRemaining, frame);
        continue;
      }

      if (fiber.tag === FiberTag.Offscreen || fiber.tag === FiberTag.LegacyHidden) {
        if (isHidden(fiber)) {
          continue;
        }
        pushFlatten(stack, fiber, secureHere, depthRemaining, frame);
        continue;
      }

      const kind = classify(fiber.tag);

      if (kind === 'transparent') {
        pushFlatten(stack, fiber, secureHere, depthRemaining, frame);
        continue;
      }

      if (kind === 'host') {
        const rect = safeMeasure(ctx.env, fiber);
        if (rect === null) {
          // No measurable host here — promote whatever children it has
          // (as if this fiber were transparent) rather than dropping a
          // subtree that might still have something to show underneath.
          pushFlatten(stack, fiber, secureHere, depthRemaining, frame);
          continue;
        }

        ctx.emittedCount += 1;

        const child = linkOf(fiber.child);
        const atDepthLimit = child !== null && depthRemaining <= 1;
        const depthCut = atDepthLimit && hasVisibleContentChild(child as FiberLike);
        const bounds = toBounds(rect, ctx.env, fiber);
        const tagOpts = secureHere ? {} : tagOptions(fiber);
        const className = safeHostClassName(fiber);

        if (child !== null && !atDepthLimit) {
          const childFrame: Frame = { nodes: [], truncated: false };
          stack.push({ kind: 'finishHost', frame: childFrame, parentFrame: frame, className, bounds, secureHere, tagOpts, depthCut: false });
          stack.push({ kind: 'visit', fiber: child, secure: secureHere, depthRemaining: depthRemaining - 1, frame: childFrame });
        } else {
          stack.push({
            kind: 'finishHost',
            frame: { nodes: [], truncated: false },
            parentFrame: frame,
            className,
            bounds,
            secureHere,
            tagOpts,
            depthCut,
          });
        }
        continue;
      }

      if (kind === 'composite') {
        ctx.emittedCount += 1;

        const child = linkOf(fiber.child);
        const atDepthLimit = child !== null && depthRemaining <= 1;
        const depthCut = atDepthLimit && hasVisibleContentChild(child as FiberLike);
        const className = safeCompositeClassName(fiber);

        if (child !== null && !atDepthLimit) {
          const childFrame: Frame = { nodes: [], truncated: false };
          stack.push({ kind: 'finishComposite', frame: childFrame, parentFrame: frame, className, secureHere });
          stack.push({ kind: 'visit', fiber: child, secure: secureHere, depthRemaining: depthRemaining - 1, frame: childFrame });
        } else {
          stack.push({
            kind: 'finishComposite',
            frame: { nodes: [], truncated: depthCut },
            parentFrame: frame,
            className,
            secureHere,
          });
        }
        continue;
      }

      // Exhaustive given `classify`'s declared return type: 'transparent' is
      // handled above, leaving only 'host' and 'composite'. Reached only if
      // a change to `classify` stops honouring that.
      throw new Error('unreachable view-tree fiber kind');
    } catch {
      frame.truncated = true;
      continue;
    }
  }
}

/** Renumbers every node's `id` to its preorder index in the final, already-emitted tree — decoupled from however many candidate fibers were visited and dropped along the way, so ids stay gap-free ("0" for the root, then depth-first) as the plan requires. */
function renumberPreorder(root: ManagedNode): void {
  let counter = 0;
  const visit = (node: ManagedNode): void => {
    node.id = String(counter);
    counter += 1;
    if (node.subitems) {
      for (const child of node.subitems) {
        visit(child);
      }
    }
  };
  visit(root);
}

/**
 * Builds the single "ReactNative" root of the managed view tree, with one
 * "ReactSurface" child per fiber root that has anything measurable under it.
 * Returns null when nothing was emitted at all (nothing mounted, nothing
 * measurable, or every root was empty) — including the one case this cannot
 * distinguish from that: an all-composite chain cut off past `VH_MAX_DEPTH`
 * with no host anywhere in it. There is no node left to *carry* `truncated`
 * in that case (every composite in the chain contributes nothing of its own
 * and bubbles the cut further up, all the way past the root), and inventing
 * a placeholder node just to hold the flag would mean fabricating a `bounds`
 * rectangle with nothing real to draw it from — worse than the information
 * loss it would be covering for. `depth truncation on an all-composite chain
 * drops content well past VH_MAX_DEPTH` (`walk.test.ts`) pins this as
 * accepted, known behaviour rather than an untested gap.
 *
 * Never throws, even on hostile input (not just a malformed-but-plain fiber
 * tree): every call out to `env` and into a fiber's own props/type/name is
 * individually guarded (see `safeMeasure`/`safeIsSecureBoundary`/
 * `safeIsWrapper`/`tagOptions`/`safeHostClassName`/`safeCompositeClassName`,
 * and `runWalk`'s own per-fiber `try`, which keeps one throwing fiber from
 * losing more than its own contribution). What is left here is the outer
 * backstop per root — covering `root.current` itself, read inside this
 * `try`, not before it — for whatever none of those anticipated; a root that
 * still hits something unanticipated is reported truncated instead of
 * losing the whole tree (the other roots, and whatever that root already
 * emitted before the throw, still stand).
 */
export function buildViewTree(roots: readonly { current: FiberLike }[], env: WalkEnv): ManagedNode | null {
  const ctx: Ctx = {
    env,
    startedAt: safeNow(env),
    emittedCount: 0,
    fiberVisits: 0,
    stopped: false,
    anyTruncated: false,
    visited: new Set<FiberLike>(),
  };

  const surfaces: ManagedNode[] = [];

  // Reserved up front, not as each is committed: the root and every surface
  // are ancestors open for the whole walk beneath them, exactly the case
  // that let the node cap overshoot when only emitted nodes were counted,
  // post hoc, as `makeNode` ran.
  ctx.emittedCount += 1 + roots.length;

  for (const root of roots) {
    if (!isObject(root)) {
      continue;
    }

    const frame: Frame = { nodes: [], truncated: false };
    try {
      // Reading `.current` inside the `try` too, not just calling `runWalk`
      // (N5/I6(a)): a throwing `.current` getter, or `root` itself being a
      // revoked `Proxy`, used to escape this function uncaught — the same
      // "never throws even on hostile input" gap `fiberRootOf` had before
      // N1. `runWalk` no longer needs a broad defence of its own for
      // anything fiber-shaped: every fiber-field read inside it is now
      // individually guarded, most of them narrowly enough that only the
      // one fiber that broke loses its own contribution rather than the
      // whole root (see `runWalk`'s per-fiber `try`). What remains here is
      // the outer backstop for `.current` itself and for whatever neither
      // of those anticipated — a `linkOf(...) === null` (a legitimately
      // absent or malformed root) is not an error and does not enter it.
      const rootFiber = linkOf((root as { current?: unknown }).current);
      if (rootFiber !== null) {
        runWalk(rootFiber, ctx, frame);
      }
    } catch {
      frame.truncated = true;
    }

    if (frame.nodes.length === 0) {
      if (frame.truncated) {
        ctx.anyTruncated = true;
      }
      continue;
    }

    const surface = makeNode(
      'ReactSurface',
      'surface',
      unionBounds(
        frame.nodes.map((n) => n.bounds),
        env,
      ),
      false,
      {},
      frame.nodes,
      frame.truncated,
      ctx,
    );
    surfaces.push(surface);
  }

  if (surfaces.length === 0) {
    return null;
  }

  const root = makeNode(
    'ReactNative',
    'root',
    unionBounds(
      surfaces.map((s) => s.bounds),
      env,
    ),
    false,
    {},
    surfaces,
    ctx.stopped || ctx.anyTruncated,
    ctx,
  );
  renumberPreorder(root);
  return root;
}
