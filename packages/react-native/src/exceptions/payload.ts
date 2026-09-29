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
import { cleanSource, fileKey, parseStack, type ParsedFrame } from './stack';
import { sha1Hex } from './sha1';

export const EXCEPTION_MAX_FRAMES = 256;
export const EXCEPTION_MAX_CAUSE_DEPTH = 10;
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
 * `getCleanStack`. Hermes and V8 prepend `<name>: <message>` (or just
 * `<name>` for an empty message) before the real frames; JSC does not, so
 * this is a no-op there. Tried longest-candidate-first so a message that
 * itself starts with the bare name does not cause a partial strip.
 *
 * `message` may contain newlines; matching it as one literal prefix (rather
 * than only its first line) strips a multi-line message in one step,
 * including any later line that happens to look like a frame.
 */
function stripKnownHeader(stack: string, name: string, message: string): string {
  const candidates = message.length > 0 ? [`${name}: ${message}`, name] : [name];

  for (const candidate of candidates) {
    if (candidate.length > 0 && stack.startsWith(candidate)) {
      const rest = stack.slice(candidate.length);
      if (rest.startsWith('\r\n')) {
        return rest.slice(2);
      }
      if (rest.startsWith('\n')) {
        return rest.slice(1);
      }
      return rest;
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
    // five steps can remove `node_modules`, `native code` or `(native)`.
    exceptionFrame.user = line !== null && column !== null && isUserSource(frame.file);

    const debugId = debugIds?.get(fileKey(frame.file));
    if (debugId !== undefined) {
      exceptionFrame.debug_id = debugId;
    }
  }

  return exceptionFrame;
}

function buildFrames(
  stack: string | undefined,
  debugIds: ReadonlyMap<string, string> | undefined,
): ExceptionFrame[] {
  if (typeof stack !== 'string') {
    return [];
  }

  return parseStack(stack, EXCEPTION_MAX_FRAMES).map((frame) => toExceptionFrame(frame, debugIds));
}

function buildNode(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  fallbackStack: string | undefined,
  debugIds: ReadonlyMap<string, string> | undefined,
): ExceptionNode {
  let name: string;
  let rawReason: string;
  let frames: ExceptionFrame[];
  let rawCause: unknown;

  if (safeIsError(value)) {
    const errorName = safeGetString(value, 'name');
    const effectiveName = errorName || 'Error';
    name = effectiveName;
    rawReason = safeGetString(value, 'message') ?? '';
    const stackVal = safeGetString(value, 'stack');
    const strippedStack =
      stackVal !== undefined ? stripKnownHeader(stackVal, effectiveName, rawReason) : undefined;
    frames = buildFrames(strippedStack, debugIds);
    rawCause = safeGet(value, 'cause');
  } else {
    const described = describeThrown(value);
    name = described.name;
    rawReason = described.reason;
    // Recursive calls (building a cause) never pass a fallback stack -- it is
    // only ever meaningful for the top-level thrown value.
    frames = buildFrames(fallbackStack, debugIds);
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
      node.cause = buildNode(rawCause, depth + 1, seen, undefined, debugIds);
    }
  }

  return node;
}

/** Appends the R10 boundary node after the deepest node already in `root`'s chain. */
function attachBoundaryNode(
  root: ExceptionNode,
  componentStack: string,
  debugIds: ReadonlyMap<string, string> | undefined,
): void {
  let tail = root;
  while (tail.cause !== undefined) {
    tail = tail.cause;
  }

  tail.cause = {
    name: ERROR_BOUNDARY_CAUSE_NAME,
    reason: '',
    frames: buildFrames(componentStack, debugIds),
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

  const root = buildNode(input.error, 0, seen, input.fallbackStack, input.debugIds);

  if (input.componentStack) {
    attachBoundaryNode(root, input.componentStack, input.debugIds);
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
    payload.debug_ids = Object.fromEntries(input.debugIds.entries());
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
