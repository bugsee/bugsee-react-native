/**
 * Reading the campaign API scenarios' markers (scenarios/api-common.ts):
 * `BUGSEE_E2E api <what> nonce=<n> key=value ...`, where a value is a word or
 * a JSON object/array (which may hold spaces).
 */
import { must } from './harness';
import { type DeviceLog, type LogLine } from './scenario';

/** Waits for `BUGSEE_E2E api <what> nonce=<nonce>` (`what` is a regex source). */
export async function apiMarker(
  log: DeviceLog,
  what: string,
  nonce: string,
  timeoutMs: number,
  from: number,
  start = from,
): Promise<LogLine> {
  return must(
    await log.waitFor(new RegExp(`BUGSEE_E2E api ${what} nonce=${nonce}\\b`), timeoutMs, from),
    `the scenario's "${what}" marker`,
    start,
  );
}

/** The JSON value after `key=` in `text` (balanced braces, strings honoured). */
export function jsonAfter<T = unknown>(text: string, key: string): T {
  const at = text.indexOf(` ${key}=`);
  if (at === -1) {
    throw new Error(`no ${key}= in: ${text}`);
  }
  const begin = at + key.length + 2;
  const open = text[begin];
  if (open !== '{' && open !== '[') {
    throw new Error(`${key}= is not JSON in: ${text}`);
  }
  let depth = 0;
  let inString = false;
  for (let i = begin; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(begin, i + 1)) as T;
      }
    }
  }
  throw new Error(`unbalanced JSON after ${key}= in: ${text}`);
}

/** The word after `key=` in `text`. */
export function wordAfter(text: string, key: string): string {
  const found = new RegExp(`\\b${key}=(\\S+)`).exec(text);
  if (found === null) {
    throw new Error(`no ${key}= in: ${text}`);
  }
  return found[1]!;
}

/** What `settle()` (scenarios/api-common.ts) logs: how a call settled. */
export interface Settled {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { name?: string; code?: unknown; message?: string; thrown?: string };
}
