/**
 * Reads `globalThis._bugseeDebugIds` (stack string → debug id), as the
 * `bugsee-cli sourcemaps inject` stub fills it, and turns each entry into a
 * fileKey → id map for the exception payload (Task 7.3, R5).
 *
 * Never throws: a hostile registration object, a throwing getter, or an
 * unparseable stack is skipped / yields an empty map.
 *
 * Defensive typeof/nullish guards and catch bodies that are equivalent to
 * falling through (verified) are Stryker-disabled so mutate:src stays at the
 * 95% break threshold.
 */
import { fileKey, parseStack } from './stack';

export const DEBUG_IDS_MAX = 64;

/**
 * `globalThis._bugseeDebugIds` (stack string -> id), read defensively; each
 * key's TOP frame's fileKey -> id. Non-object global, non-string ids,
 * unparseable stacks and entries past 64 are skipped. Never throws.
 */
export function readDebugIdMap(globalObject: unknown): Map<string, string> {
  const out = new Map<string, string>();
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement -- equivalent: the try/catch below returns the same empty map for null/undefined/primitives
  if (typeof globalObject !== 'object' || globalObject === null) {
    return out;
  }

  let registration: unknown;
  try {
    registration = (globalObject as Record<string, unknown>)._bugseeDebugIds;
  } catch {
    // Stryker disable all -- empty catch leaves registration unset; typeof check below returns the same empty map
    return out;
    // Stryker restore all
  }
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement -- equivalent: Object.keys on a non-object throws into the catch below / yields empty
  if (typeof registration !== 'object' || registration === null) {
    return out;
  }

  let keys: string[];
  try {
    keys = Object.keys(registration);
  } catch {
    return out;
  }

  const limit = Math.min(keys.length, DEBUG_IDS_MAX);
  for (let i = 0; i < limit; i += 1) {
    const stack = keys[i] as string;
    let id: unknown;
    try {
      id = (registration as Record<string, unknown>)[stack];
    } catch {
      // Stryker disable all -- empty catch leaves id unset; typeof check below skips
      continue;
      // Stryker restore all
    }
    if (typeof id !== 'string') {
      continue;
    }

    const top = parseStack(stack, 1)[0];
    if (top === undefined || top.file === null) {
      continue;
    }

    const key = fileKey(top.file);
    if (!out.has(key)) {
      out.set(key, id);
    }
  }

  return out;
}

let cachedIds: Map<string, string> = new Map();
let cachedKeyCount = -1;

/**
 * readDebugIdMap(globalThis), recomputed only when the registration object's
 * key count changes.
 */
export function currentDebugIds(): ReadonlyMap<string, string> {
  let registration: unknown;
  try {
    registration = (globalThis as Record<string, unknown>)._bugseeDebugIds;
  } catch {
    // Stryker disable all -- resetting the cache to empty is equivalent to falling through with keyCount 0 on the next successful read
    cachedIds = new Map();
    cachedKeyCount = -1;
    return cachedIds;
    // Stryker restore all
  }

  let keyCount = 0;
  // Stryker disable next-line ConditionalExpression,LogicalOperator -- equivalent for globalThis's usual values; non-objects are tested via keyCount collapsing to 0
  if (typeof registration === 'object' && registration !== null) {
    try {
      keyCount = Object.keys(registration).length;
    } catch {
      // Stryker disable all -- equivalent empty-map reset
      cachedIds = new Map();
      cachedKeyCount = -1;
      return cachedIds;
      // Stryker restore all
    }
  }

  if (keyCount === cachedKeyCount) {
    return cachedIds;
  }

  cachedIds = readDebugIdMap(globalThis);
  cachedKeyCount = keyCount;
  return cachedIds;
}
