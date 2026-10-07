/**
 * Builds the exception payload the wrapper sends to the native SDKs (design
 * §9.1, Phase 7 "The payload (exact)"). This is pure JS: both natives forward
 * it verbatim, never parsing, logging, truncating or re-encoding it.
 *
 * `buildExceptionPayload` never throws. It reads no property of a thrown
 * value except `name`, `message`, `stack` and `cause` -- every read goes
 * through a helper that treats a throwing getter as if the property were
 * absent -- so a hostile getter, a `Proxy` or a revoked `Proxy` cannot break
 * it. A thrown non-`Error` is described (R9), never serialised: nothing else
 * it carries is read, so nothing else it carries can leak into the payload.
 */
import { cleanSource, fileKey, parseStack, STACK_MAX_INPUT_LENGTH, type ParsedFrame } from './stack';
import { sha1Hex } from './sha1';

export const EXCEPTION_MAX_FRAMES = 256;
export const EXCEPTION_MAX_CAUSE_DEPTH = 10;
/**
 * The most stack content (`error.stack`, `componentStack`, `fallbackStack`
 * combined, in UTF-16 units) `buildExceptionPayload` will hand to
 * `parseStack` for one call. `STACK_MAX_INPUT_LENGTH` bounds a single
 * stack; nothing on its own bounded the *sum* across a cause chain's up to
 * 11 nodes plus `componentStack`, so that total could still reach 12x a
 * single node's own worst case (review N1). Shared across the whole tree
 * via one mutable counter (`ParseBudget`): once it reaches zero, every
 * later node's frames are `[]`, the same as if it had no stack at all.
 */
export const EXCEPTION_MAX_TOTAL_STACK_LENGTH = 128 * 1024;
/**
 * The most a trimmed `reason` keeps of the original content, in UTF-16
 * units. A reason actually cut is one unit longer than this: the appended
 * `…` (`TRUNCATION_ELLIPSIS`) is not counted against the cap, so it is
 * always visible evidence that a cut happened, matching 6.x.
 */
export const EXCEPTION_MAX_REASON_LENGTH = 8192;
/** `name`, trimmed to this many UTF-16 units (same surrogate-safe cut as `reason`). */
export const EXCEPTION_MAX_NAME_LENGTH = 256;
/** `traceRaw`, `data.source` and `data.member`, each trimmed to this many UTF-16 units. */
export const EXCEPTION_MAX_FIELD_LENGTH = 1024;
export const ERROR_BOUNDARY_CAUSE_NAME = 'ErrorBoundary Error';

const UNKNOWN_MEMBER = '<unknown>';
const TRUNCATION_ELLIPSIS = '…';

export interface ExceptionFrame {
  traceRaw: string;
  trace: string;
  data: {
    member: string;
    source: string;
    line: number | null;
    column: number | null;
  };
  user?: boolean;
  debug_id?: string;
}

export interface ExceptionNode {
  name: string;
  reason: string;
  frames: ExceptionFrame[];
  cause?: ExceptionNode;
}

export interface ExceptionPayload extends ExceptionNode {
  signature: string;
  platform_os: 'android' | 'ios';
  debug_ids?: Record<string, string>;
}

export interface PayloadInput {
  error: unknown;
  platformOS: 'android' | 'ios';
  /** R10: the innermost cause, named `ERROR_BOUNDARY_CAUSE_NAME`. */
  componentStack?: string;
  /** A stack captured by the caller; used only when `error` is not an `Error` (Task 7.1b). */
  fallbackStack?: string;
  /** File key -> debug id (Task 7.3). Empty (or absent) until then. */
  debugIds?: ReadonlyMap<string, string>;
}

/** Reads `obj[key]`, treating a throwing getter (or any other failure) as absent. */
function safeGet(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeGetString(obj: object, key: string): string | undefined {
  const value = safeGet(obj, key);
  return typeof value === 'string' ? value : undefined;
}

function safeIsError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isReferenceType(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * R9: a thrown non-`Error`'s name and reason. A string is the reason itself;
 * an object (or function) with a string `message` gives that message, plus
 * its `name` when that is also a string; anything else is
 * `Non-Error thrown: <typeof>`.
 */
export function describeThrown(value: unknown): { name: string; reason: string } {
  if (typeof value === 'string') {
    return { name: 'Error', reason: value };
  }

  if (isReferenceType(value)) {
    const message = safeGetString(value, 'message');
    if (message !== undefined) {
      const name = safeGetString(value, 'name');
      return { name: name || 'Error', reason: message };
    }
  }

  return { name: 'Error', reason: `Non-Error thrown: ${typeof value}` };
}

/** Truncates to `max` UTF-16 units, appending `TRUNCATION_ELLIPSIS`, never splitting a surrogate pair. */
function truncate(raw: string, max: number): string {
  if (raw.length <= max) {
    return raw;
  }

  let cut = max;
  const codeBeforeCut = raw.charCodeAt(cut - 1);
  if (codeBeforeCut >= 0xd800 && codeBeforeCut <= 0xdbff) {
    cut -= 1;
  }

  return raw.slice(0, cut) + TRUNCATION_ELLIPSIS;
}

/** Trims and truncates to `EXCEPTION_MAX_REASON_LENGTH`, never splitting a surrogate pair. */
function normalizeReason(raw: string): string {
  return truncate(raw.trim(), EXCEPTION_MAX_REASON_LENGTH);
}

/**
 * Truncates to `EXCEPTION_MAX_NAME_LENGTH`. Not trimmed: the payload table
 * defines `name` as "the error's `name` if it is a non-empty string", and a
 * whitespace-only name is still non-empty by that definition (M7).
 */
function normalizeName(raw: string): string {
  return truncate(raw, EXCEPTION_MAX_NAME_LENGTH);
}

/** Truncates `traceRaw`/`data.source`/`data.member` to `EXCEPTION_MAX_FIELD_LENGTH` (I1). */
function normalizeField(raw: string): string {
  return truncate(raw, EXCEPTION_MAX_FIELD_LENGTH);
}

/**
 * Strips a stack's own "Name: message" header (I2), matching 6.x's
 * `getCleanStack`. Hermes and V8 prepend `<name>: <message>` before the
 * real frames (or just `<message>` when `name` is `''`, or just `<name>`
 * when `message` is `''`); JSC does not, so this is a no-op there. Tried
 * longest-candidate-first so a message that itself starts with the bare
 * name does not cause a partial strip.
 *
 * `name` here is the *raw* value read off the error (via `safeGetString`,
 * so `''` when absent or non-string) -- not the display name `'Error'`
 * falls back to -- because that fallback is exactly the case where V8 and
 * Hermes write no name at all, only `message`, as the header (review N2).
 *
 * A candidate is accepted only when it is followed by the end of the
 * string, `\n` or `\r`: `stack.startsWith(name)` alone is not enough,
 * because a real frame's own function name can start with the error's
 * name as plain text -- captured with JSC: `new TypeError('boom')` thrown
 * from a function named `TypeErrorFactory` gives a stack whose first (and
 * only) line is `TypeErrorFactory@file:2:22`, and `name` is `'TypeError'`.
 * Without this check that line becomes `Factory@file:2:22`, a wrong
 * member name.
 *
 * `message` may contain newlines; matching it as one literal prefix (rather
 * than only its first line) strips a multi-line message in one step,
 * including any later line that happens to look like a frame.
 *
 * Deliberately does not also strip the newline (`\n` or `\r\n`) left right
 * after the header: `parseStack` already `trim()`s every line and skips a
 * blank one, so whatever that leftover newline turns into -- an empty
 * first "line", or a lone `\r` that trims to empty -- is silently absorbed
 * there. Stripping it here too would be untestable dead weight, not extra
 * safety.
 */
function stripKnownHeader(stack: string, name: string, message: string): string {
  const candidates: string[] = [];
  if (name.length > 0 && message.length > 0) {
    candidates.push(`${name}: ${message}`);
  }
  if (name.length > 0) {
    candidates.push(name);
  } else if (message.length > 0) {
    candidates.push(message);
  }

  for (const candidate of candidates) {
    if (stack.startsWith(candidate)) {
      const next = stack.charAt(candidate.length);
      if (next === '' || next === '\n' || next === '\r') {
        return stack.slice(candidate.length);
      }
    }
  }

  return stack;
}

function buildTrace(member: string, source: string, line: number | null, column: number | null): string {
  let location = source;
  if (line !== null) {
    location += `:${line}`;
  }
  if (column !== null) {
    location += `:${column}`;
  }
  return `${member} () (${location})`;
}

function isUserSource(source: string): boolean {
  return !source.includes('node_modules') && !source.includes('native code') && !source.includes('(native)');
}

/**
 * React 19's `describeBuiltInComponentFrame` (`ReactFabric-dev.js`) emits a
 * synthetic frame for a built-in host component (`View`, `Text`, ...) with
 * no real source: `"View (<anonymous>)"` on an engine whose own stacks say
 * "at" (Hermes, V8 -- `file` is the literal string `<anonymous>`, with no
 * line/column at all, so `user` is already `false` there); `"View@unknown:0:0"`
 * on one that does not (JSC -- `file` is the literal string `unknown`, with
 * line and column both `0`, which are *not* `null`). Only the second shape
 * needs an explicit check: `0` is a real number, so without it this parses
 * as a user frame (review N4).
 */
function isBuiltInComponentSentinel(file: string, line: number | null, column: number | null): boolean {
  return file === 'unknown' && line === 0 && column === 0;
}

function toExceptionFrame(frame: ParsedFrame, debugIds: ReadonlyMap<string, string> | undefined): ExceptionFrame {
  const source = normalizeField(cleanSource(frame.file));
  const member = normalizeField(frame.methodName || UNKNOWN_MEMBER);
  const { lineNumber: line, column } = frame;

  const exceptionFrame: ExceptionFrame = {
    traceRaw: normalizeField(frame.raw),
    trace: buildTrace(member, source, line, column),
    data: { member, source, line, column },
  };

  if (frame.file !== null) {
    // "its file" (the payload table's `user` row) -- checked on the frame's
    // own file, not the cleaned `source`, matching the spec's wording (M6).
    // In practice this never changes the result: none of `cleanSource`'s
    // five steps can remove `node_modules`, `native code`, `(native)` or
    // the built-in-component sentinel `unknown` (review N4).
    exceptionFrame.user =
      line !== null &&
      column !== null &&
      !isBuiltInComponentSentinel(frame.file, line, column) &&
      isUserSource(frame.file);

    const debugId = debugIds?.get(fileKey(frame.file));
    if (debugId !== undefined) {
      exceptionFrame.debug_id = debugId;
    }
  }

  return exceptionFrame;
}

/** A mutable counter shared across one `buildExceptionPayload` call's whole node tree. */
interface ParseBudget {
  remaining: number;
}

function buildFrames(
  stack: string | undefined,
  debugIds: ReadonlyMap<string, string> | undefined,
  budget: ParseBudget,
): ExceptionFrame[] {
  if (typeof stack !== 'string' || budget.remaining <= 0) {
    return [];
  }

  const takeLength = Math.min(stack.length, budget.remaining, STACK_MAX_INPUT_LENGTH);
  budget.remaining -= takeLength;

  return parseStack(stack.slice(0, takeLength), EXCEPTION_MAX_FRAMES).map((frame) =>
    toExceptionFrame(frame, debugIds),
  );
}

function buildNode(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  fallbackStack: string | undefined,
  debugIds: ReadonlyMap<string, string> | undefined,
  budget: ParseBudget,
): ExceptionNode {
  let name: string;
  let rawReason: string;
  let frames: ExceptionFrame[];
  let rawCause: unknown;

  if (safeIsError(value)) {
    const errorName = safeGetString(value, 'name') ?? '';
    name = errorName || 'Error';
    rawReason = safeGetString(value, 'message') ?? '';
    const stackVal = safeGetString(value, 'stack');
    // The *raw* name (which may be '') goes to stripKnownHeader, not the
    // display fallback `name` above -- see its own comment (review N2).
    const strippedStack =
      stackVal !== undefined ? stripKnownHeader(stackVal, errorName, rawReason) : undefined;
    frames = buildFrames(strippedStack, debugIds, budget);
    rawCause = safeGet(value, 'cause');
  } else {
    const described = describeThrown(value);
    name = described.name;
    rawReason = described.reason;
    // Recursive calls (building a cause) never pass a fallback stack -- it is
    // only ever meaningful for the top-level thrown value.
    frames = buildFrames(fallbackStack, debugIds, budget);
    rawCause = undefined;
  }

  const node: ExceptionNode = {
    name: normalizeName(name),
    reason: normalizeReason(rawReason),
    frames,
  };

  if (rawCause !== undefined && depth < EXCEPTION_MAX_CAUSE_DEPTH) {
    const repeatKey = isReferenceType(rawCause) ? rawCause : undefined;
    const isRepeat = repeatKey !== undefined && seen.has(repeatKey);
    if (!isRepeat) {
      if (repeatKey !== undefined) {
        seen.add(repeatKey);
      }
      node.cause = buildNode(rawCause, depth + 1, seen, undefined, debugIds, budget);
    }
  }

  return node;
}

/** Appends the R10 boundary node after the deepest node already in `root`'s chain. */
function attachBoundaryNode(
  root: ExceptionNode,
  componentStack: string,
  debugIds: ReadonlyMap<string, string> | undefined,
  budget: ParseBudget,
): void {
  let tail = root;
  while (tail.cause !== undefined) {
    tail = tail.cause;
  }

  tail.cause = {
    name: ERROR_BOUNDARY_CAUSE_NAME,
    reason: '',
    frames: buildFrames(componentStack, debugIds, budget),
  };
}

function signatureInput(node: ExceptionNode): string {
  let input = node.name;
  for (const frame of node.frames) {
    input += frame.trace;
  }
  if (node.cause) {
    input += signatureInput(node.cause);
  }
  return input;
}

function buildPayloadUnsafe(input: PayloadInput): ExceptionPayload {
  const seen = new WeakSet<object>();
  if (isReferenceType(input.error)) {
    seen.add(input.error);
  }
  const budget: ParseBudget = { remaining: EXCEPTION_MAX_TOTAL_STACK_LENGTH };

  const root = buildNode(input.error, 0, seen, input.fallbackStack, input.debugIds, budget);

  if (input.componentStack) {
    attachBoundaryNode(root, input.componentStack, input.debugIds, budget);
  }

  const payload: ExceptionPayload = {
    name: root.name,
    reason: root.reason,
    frames: root.frames,
    ...(root.cause !== undefined ? { cause: root.cause } : {}),
    signature: sha1Hex(signatureInput(root)),
    platform_os: input.platformOS,
  };

  if (input.debugIds && input.debugIds.size > 0) {
    // Keyed by the cleaned source, exactly as frames[].data.source is, so a
    // consumer can join the two. The per-frame lookup above stays on fileKey
    // (the registration's join key); two raw paths that clean to one source
    // keep the first id.
    const keyed: Record<string, string> = {};
    for (const [file, id] of input.debugIds) {
      const key = cleanSource(file);
      if (!(key in keyed)) {
        keyed[key] = id;
      }
    }
    payload.debug_ids = keyed;
  }

  return payload;
}

/** A minimal, always-constructible payload for the (unreachable in practice) case where `input` itself cannot be read. */
function buildFallbackPayload(input: PayloadInput): ExceptionPayload {
  let platformOS: 'android' | 'ios' = 'ios';
  try {
    const candidate = input.platformOS;
    if (candidate === 'android' || candidate === 'ios') {
      platformOS = candidate;
    }
  } catch {
    // Keep the default.
  }

  const name = 'Error';
  return {
    name,
    reason: `Non-Error thrown: object`,
    frames: [],
    signature: sha1Hex(name),
    platform_os: platformOS,
  };
}

export function buildExceptionPayload(input: PayloadInput): ExceptionPayload {
  try {
    return buildPayloadUnsafe(input);
  } catch {
    return buildFallbackPayload(input);
  }
}
