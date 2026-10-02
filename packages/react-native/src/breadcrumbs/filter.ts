import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { copyBreadcrumbData } from './data';
import { breadcrumbLevelName, breadcrumbLevelValue } from './types';
import type { BreadcrumbFilter, BreadcrumbSnapshot } from './types';

const WRITABLE_STRINGS = ['category', 'message', 'type'] as const;

let current: BreadcrumbFilter | undefined;
let subscribed = false;

/**
 * Registers `callback` as the only breadcrumb filter. A later call replaces
 * it. `undefined` or `null` clears it, which tells native to uninstall the
 * filter so crumbs are recorded without one.
 *
 * The JS listener is subscribed before the native filter is installed, so a
 * crumb filtered on the installing turn still has a listener. The subscription
 * stays: clearing the callback stops native from asking, and a later callback
 * must still be able to answer.
 */
export function setBreadcrumbFilter(callback?: BreadcrumbFilter | null): void {
  if (callback != null && typeof callback !== 'function') {
    throw new TypeError(
      `Bugsee.setBreadcrumbFilter requires a function, got ${typeof callback}`,
    );
  }
  current = callback ?? undefined;
  if (current !== undefined && !subscribed) {
    subscribed = true;
    NativeBugsee.onBreadcrumbFilterRequest(onBreadcrumbFilterRequest);
  }
  NativeBugsee.setBreadcrumbFilterEnabled(current !== undefined);
}

/**
 * Answers one native filter request.
 *
 * The callback is read here, at dispatch, so a `setBreadcrumbFilter` made
 * while this request is in flight changes the next crumb, not this one. The
 * callback itself runs on a later turn.
 *
 * A throw, a rejection, a result that is not an object, or a keep that drops
 * a writable key the snapshot sent (`category`, `level`, `message`, `type`,
 * and `data` when it was present) drops the crumb. A callback that never
 * settles does not reply at all. Neither path replies with the original crumb.
 * `timestamp` is not a writable key, and a key the snapshot omitted stays
 * omitted. `data: null` when the snapshot sent `data` clears it.
 */
function onBreadcrumbFilterRequest(event: { requestId: string; crumbJson: string }): void {
  const callback = current;
  const { requestId } = event;
  if (callback === undefined) {
    reply(requestId, null);
    return;
  }
  const snapshot = snapshotFromJson(event.crumbJson);
  if (snapshot === null) {
    reply(requestId, null);
    return;
  }

  Promise.resolve()
    .then(() => callback(snapshot))
    .then((result) => {
      reply(requestId, keptJson(snapshot, result));
    })
    .catch(() => {
      reply(requestId, null);
    });
}

function snapshotFromJson(json: string): BreadcrumbSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const source = parsed as Record<string, unknown>;
  const snapshot: BreadcrumbSnapshot = Object.create(null);
  for (const key of WRITABLE_STRINGS) {
    if (!Object.hasOwn(source, key)) {
      continue;
    }
    const value = source[key];
    if (typeof value !== 'string') {
      return null;
    }
    snapshot[key] = value;
  }
  if (Object.hasOwn(source, 'level')) {
    const name = breadcrumbLevelName(source.level);
    if (name === undefined) {
      return null;
    }
    snapshot.level = name;
  }
  if (Object.hasOwn(source, 'data')) {
    snapshot.data = source.data;
  }
  if (Object.hasOwn(source, 'timestamp') && typeof source.timestamp === 'number') {
    snapshot.timestamp = source.timestamp;
  }
  return snapshot;
}

/**
 * The JSON to send back, or `null` to drop.
 *
 * Every writable key the snapshot has must be an own key of `result`, and
 * not `undefined`. String keys must be strings. `level` must still be a
 * level name, and is sent as `getValue()`. `data: null` is kept as `null`.
 * `timestamp` is not copied. A key the snapshot does not have is not added.
 */
function keptJson(snapshot: BreadcrumbSnapshot, result: unknown): string | null {
  if (result === null || result === undefined || typeof result !== 'object') {
    return null;
  }
  const record = result as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of WRITABLE_STRINGS) {
    if (!Object.hasOwn(snapshot, key)) {
      continue;
    }
    if (!Object.hasOwn(record, key) || typeof record[key] !== 'string') {
      return null;
    }
    out[key] = record[key];
  }
  if (Object.hasOwn(snapshot, 'level')) {
    if (!Object.hasOwn(record, 'level')) {
      return null;
    }
    const value = breadcrumbLevelValue(record.level);
    if (value === undefined) {
      return null;
    }
    out.level = value;
  }
  if (Object.hasOwn(snapshot, 'data')) {
    if (!Object.hasOwn(record, 'data') || record.data === undefined) {
      return null;
    }
    out.data = record.data === null ? null : copyBreadcrumbData(record.data);
  }
  return encodeBridgeObject(out);
}

function reply(requestId: string, crumbJson: string | null): void {
  try {
    NativeBugsee.replyBreadcrumbFilter(requestId, crumbJson);
  } catch {
    // The bridge is gone. An unanswered request is not recorded.
  }
}
