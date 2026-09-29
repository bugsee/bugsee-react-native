/**
 * Turns a React fiber tree into a privacy-safe "managed view tree": a plain,
 * serialisable description of what is on screen, with no text content and no
 * prop other than `testID`/`nativeID` ever read off a fiber.
 *
 * Pure on purpose: no import of `react` or `react-native`. Everything this
 * module needs to know about the host platform, the renderer and the two
 * component identities it must treat specially (the secure boundary and the
 * wrap component) arrives through `WalkEnv`, so this file is testable with
 * nothing but plain objects (see `__tests__/fakeFibers.ts`) and stays true
 * whether it is walking a fake tree or a real one.
 */
import { FiberTag } from './fiber';
import type { FiberLike, WindowRect } from './fiber';

export const VH_WALK_BUDGET_MS = 250;
export const VH_MAX_NODES = 2000;
export const VH_MAX_DEPTH = 64;
export const VH_TAG_MAX_LENGTH = 99;
export const VH_IOS_DECIMALS = 2;

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
  /** ms; the budget is measured from this function's first call. */
  now(): number;
}

type Bounds = [number, number, number, number];

type StopReason = 'nodes' | 'budget' | null;

interface Ctx {
  env: WalkEnv;
  startedAt: number;
  nextId: number;
  emittedCount: number;
  stopped: boolean;
  stopReason: StopReason;
}

interface ChildrenResult {
  nodes: ManagedNode[];
  /** True when this children list was cut short by VH_MAX_NODES. */
  cutByNodeBudget: boolean;
}

const EMPTY_CHILDREN: ChildrenResult = { nodes: [], cutByNodeBudget: false };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function androidBounds(rect: WindowRect, env: WalkEnv): Bounds {
  return [
    Math.round(rect.x * env.scale) + env.originX,
    Math.round(rect.y * env.scale) + env.originY,
    Math.round(rect.width * env.scale),
    Math.round(rect.height * env.scale),
  ];
}

function iosBounds(rect: WindowRect, env: WalkEnv): Bounds {
  return [
    round2(rect.x + env.originX),
    round2(rect.y + env.originY),
    round2(rect.width),
    round2(rect.height),
  ];
}

function toBounds(rect: WindowRect, env: WalkEnv): Bounds {
  return env.platform === 'android' ? androidBounds(rect, env) : iosBounds(rect, env);
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

/** ForwardRef and Memo/SimpleMemo unwrap to the component they wrap. */
function compositeClassName(fiber: FiberLike): string {
  if (fiber.tag === FiberTag.ForwardRef) {
    const render = (fiber.type as { render?: unknown } | null)?.render;
    return nameOf(render);
  }
  if (fiber.tag === FiberTag.Memo || fiber.tag === FiberTag.SimpleMemo) {
    const inner = (fiber.type as { type?: unknown } | null)?.type;
    return nameOf(inner);
  }
  return nameOf(fiber.type);
}

function hostClassName(fiber: FiberLike): string {
  return String(fiber.type);
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
      // HostRoot, Profiler, Suspense, LegacyHidden: none of these are
      // visual on their own, so their children are flattened into whichever
      // ancestor node ends up containing them.
      return 'transparent';
  }
}

/**
 * `OffscreenComponent`'s visibility is not a prop: it lives on the fiber's
 * `stateNode` as a bitmask (`OffscreenVisible = 1`), which is what lets this
 * check happen without ever reading `memoizedProps.mode` — this module reads
 * no prop but `testID`/`nativeID`, anywhere, including here.
 */
function isHiddenOffscreen(fiber: FiberLike): boolean {
  const stateNode = fiber.stateNode as { _visibility?: number } | null;
  return typeof stateNode?._visibility === 'number' && (stateNode._visibility & 1) === 0;
}

/** Reads `testID`/`nativeID` and nothing else — the only props this module ever touches, and only when the node is not secure. */
function tagOptions(fiber: FiberLike): { tag?: string; native_id?: string } {
  const props = fiber.memoizedProps as { testID?: unknown; nativeID?: unknown } | null | undefined;
  const out: { tag?: string; native_id?: string } = {};
  const testID = props?.testID;
  if (typeof testID === 'string' && testID.length <= VH_TAG_MAX_LENGTH) {
    out.tag = testID;
  }
  const nativeID = props?.nativeID;
  if (typeof nativeID === 'string' && nativeID.length <= VH_TAG_MAX_LENGTH) {
    out.native_id = nativeID;
  }
  return out;
}

function checkStop(ctx: Ctx): boolean {
  if (ctx.stopped) {
    return true;
  }
  if (ctx.env.now() - ctx.startedAt > VH_WALK_BUDGET_MS) {
    ctx.stopped = true;
    ctx.stopReason = 'budget';
    return true;
  }
  if (ctx.emittedCount >= VH_MAX_NODES) {
    ctx.stopped = true;
    ctx.stopReason = 'nodes';
    return true;
  }
  return false;
}

function makeNode(
  ctx: Ctx,
  id: string,
  className: string,
  kind: ManagedNode['options']['kind'],
  bounds: Bounds,
  secure: boolean,
  tagOpts: { tag?: string; native_id?: string },
  children: ManagedNode[],
  truncated: boolean,
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
  const node: ManagedNode = { id, class_name: className, bounds, options };
  if (children.length > 0) {
    node.subitems = children;
  }
  if (truncated) {
    node.truncated = true;
  }
  ctx.emittedCount += 1;
  return node;
}

/**
 * Walks one fiber and everything transparent above the next host/composite
 * boundary, returning the (possibly empty, possibly multi-element —
 * flattening can fan a single fiber out into several sibling nodes) list of
 * managed nodes it produced, plus whether that list was cut short by the
 * node budget (so the caller can mark itself `truncated`).
 */
function walkFiber(fiber: FiberLike, ctx: Ctx, secure: boolean, depthRemaining: number): ChildrenResult {
  // Whether this specifically was a node-budget stop (as opposed to a
  // time-budget one) is not decided here: `walkChildren`'s own `ctx.stopped`
  // fallback, immediately after calling this function, reads `ctx.stopReason`
  // itself once this returns — computing it twice would only ever agree.
  if (checkStop(ctx)) {
    return { nodes: [], cutByNodeBudget: false };
  }

  if (fiber.tag === FiberTag.HostText) {
    return EMPTY_CHILDREN;
  }

  const secureHere = secure || ctx.env.isSecureBoundary(fiber);

  if (ctx.env.isWrapper(fiber)) {
    return walkChildren(fiber.child, ctx, secureHere, depthRemaining);
  }

  if (fiber.tag === FiberTag.Offscreen) {
    if (isHiddenOffscreen(fiber)) {
      return EMPTY_CHILDREN;
    }
    return walkChildren(fiber.child, ctx, secureHere, depthRemaining);
  }

  const kind = classify(fiber.tag);
  if (kind === 'transparent') {
    return walkChildren(fiber.child, ctx, secureHere, depthRemaining);
  }

  const id = String(ctx.nextId);
  ctx.nextId += 1;

  if (kind === 'host') {
    const rect = ctx.env.measure(fiber);
    if (rect === null) {
      return EMPTY_CHILDREN;
    }

    let children = EMPTY_CHILDREN;
    let truncatedByDepth = false;
    if (fiber.child !== null) {
      if (depthRemaining <= 1) {
        truncatedByDepth = true;
      } else {
        children = walkChildren(fiber.child, ctx, secureHere, depthRemaining - 1);
      }
    }

    const tagOpts = secureHere ? {} : tagOptions(fiber);
    const node = makeNode(
      ctx,
      id,
      hostClassName(fiber),
      'host',
      toBounds(rect, ctx.env),
      secureHere,
      tagOpts,
      children.nodes,
      truncatedByDepth || children.cutByNodeBudget,
    );
    return { nodes: [node], cutByNodeBudget: false };
  }

  if (kind === 'composite') {
    // Unlike a host node, a composite's bounds come only from its children's
    // bounds, so hitting the depth limit here (skipping recursion) always
    // leaves `children` empty — which the "nothing measurable" check just
    // below already drops. There is no case where a composite is both
    // depth-truncated and still has something to show, so — unlike the host
    // branch above — only the node-budget cutoff can mark this node truncated.
    let children = EMPTY_CHILDREN;
    if (fiber.child !== null && depthRemaining > 1) {
      children = walkChildren(fiber.child, ctx, secureHere, depthRemaining - 1);
    }

    if (children.nodes.length === 0) {
      return EMPTY_CHILDREN;
    }

    const tagOpts = secureHere ? {} : tagOptions(fiber);
    const node = makeNode(
      ctx,
      id,
      compositeClassName(fiber),
      'composite',
      unionBounds(
        children.nodes.map((n) => n.bounds),
        ctx.env,
      ),
      secureHere,
      tagOpts,
      children.nodes,
      children.cutByNodeBudget,
    );
    return { nodes: [node], cutByNodeBudget: false };
  }

  // Exhaustive given `classify`'s declared return type: 'transparent' is
  // handled above, leaving only 'host' and 'composite'. Reached only if a
  // change to `classify` stops honouring that — caught here loudly, rather
  // than silently returning `undefined` to a caller expecting a ChildrenResult.
  throw new Error(`unreachable view-tree fiber kind: ${String(kind)}`);
}

function walkChildren(firstChild: FiberLike | null, ctx: Ctx, secure: boolean, depthRemaining: number): ChildrenResult {
  const nodes: ManagedNode[] = [];
  let cutByNodeBudget = false;
  let child = firstChild;
  while (child !== null) {
    // No checkStop guard here before calling walkFiber: walkFiber already
    // makes that its own first move, and re-checking here first would only
    // ever reach the same answer it is about to reach anyway.
    const result = walkFiber(child, ctx, secure, depthRemaining);
    nodes.push(...result.nodes);
    if (result.cutByNodeBudget) {
      cutByNodeBudget = true;
      break;
    }
    // A stop that `result` cannot carry: `result.cutByNodeBudget` is only
    // ever true for the node-budget (never the time-budget, by design — see
    // `checkStop`), so a time-budget stop discovered while walking `child`
    // still has to be noticed here, or the loop would run on to the next
    // sibling regardless.
    if (ctx.stopped) {
      cutByNodeBudget = ctx.stopReason === 'nodes';
      break;
    }
    child = child.sibling;
  }
  return { nodes, cutByNodeBudget };
}

/**
 * Builds the single "ReactNative" root of the managed view tree, with one
 * "ReactSurface" child per fiber root that has anything measurable under it.
 * Returns null when nothing was emitted at all (nothing mounted, nothing
 * measurable, or every root was empty).
 */
export function buildViewTree(roots: readonly { current: FiberLike }[], env: WalkEnv): ManagedNode | null {
  const ctx: Ctx = {
    env,
    startedAt: env.now(),
    nextId: 0,
    emittedCount: 0,
    stopped: false,
    stopReason: null,
  };

  const rootId = String(ctx.nextId);
  ctx.nextId += 1;

  const surfaces: ManagedNode[] = [];
  for (const root of roots) {
    const surfaceId = String(ctx.nextId);
    ctx.nextId += 1;
    // `root.current` is walked as a fiber in its own right, not skipped
    // straight to its child: in production it is a HostRoot fiber, which
    // `classify` already treats as transparent (falling through to its
    // child) — but nothing here should assume that, since a root's own
    // fiber can legitimately be anything (a `HostRoot` normally, but this
    // function has no reason to special-case it over any other transparent
    // tag).
    const children = walkFiber(root.current, ctx, false, VH_MAX_DEPTH);
    if (children.nodes.length === 0) {
      continue;
    }
    const surface = makeNode(
      ctx,
      surfaceId,
      'ReactSurface',
      'surface',
      unionBounds(
        children.nodes.map((n) => n.bounds),
        env,
      ),
      false,
      {},
      children.nodes,
      children.cutByNodeBudget,
    );
    surfaces.push(surface);
  }

  if (surfaces.length === 0) {
    return null;
  }

  return makeNode(
    ctx,
    rootId,
    'ReactNative',
    'root',
    unionBounds(
      surfaces.map((s) => s.bounds),
      env,
    ),
    false,
    {},
    surfaces,
    ctx.stopped,
  );
}
