import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { copyBreadcrumbData } from './data';
import { isBreadcrumbLevel } from './types';
import type { BreadcrumbFilter, BreadcrumbSnapshot } from './types';

const WRITABLE_STRINGS = ['category', 'message', 'type'] as const;

let current: BreadcrumbFilter | undefined;
let subscribed = false;

/**
 * One `addBreadcrumb` submitted while `current` was set. iOS records on the
 * main queue, so a later `setBreadcrumbFilter` on that turn runs before the
 * record asks JS. The callback installed at the add still answers that crumb.
 * The id is not the crumb's message: two adds with the same message, and an
 * SDK crumb that happens to repeat it, must not take each other's callback.
 * An add native did not ask about is removed, so it cannot be claimed later.
 */
let nextAddId = 0;
const owed: Array<{ id: string; callback: BreadcrumbFilter }> = [];

/**
 * Called from `addBreadcrumb` after validation, before the native call.
 * Returns the id native echoes on that add's filter request, or `null` when
 * nothing is installed and there is nothing to retain.
 */
export function retainBreadcrumbFilterForAdd(): string | null {
  if (current === undefined) {
    return null;
  }
  nextAddId += 1;
  const id = String(nextAddId);
  owed.push({ id, callback: current });
  return id;
}

/** Drops an id native reported it will not ask about. */
export function releaseBreadcrumbFilterForAdd(id: string): void {
  const index = owed.findIndex((item) => item.id === id);
  if (index >= 0) {
    owed.splice(index, 1);
  }
}

function claimBreadcrumbFilter(id: string | undefined): BreadcrumbFilter | undefined {
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  const index = owed.findIndex((item) => item.id === id);
  if (index < 0) {
    return undefined;
  }
  const [item] = owed.splice(index, 1);
  return item?.callback;
}

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
 * while this request is in flight changes the next crumb, not this one.
 * A request that carries the id from `addBreadcrumb` is answered by the
 * callback that was installed for that add, including when this turn then
 * cleared the filter or replaced it with another function. A request with
 * no id is an SDK crumb: it uses whatever is installed now and does not
 * take an owed callback. The callback itself runs on a later turn.
 *
 * A throw, a rejection, a result that is not an object, or a keep that drops
 * a writable key the snapshot sent (`category`, `level`, `message`, `type`,
 * and `data` when it was present) drops the crumb. A callback that never
 * settles does not reply at all. Neither path replies with the original crumb.
 * `timestamp` is not a writable key, and a key the snapshot omitted stays
 * omitted. `data: null` when the snapshot sent `data` clears it.
 */
function onBreadcrumbFilterRequest(event: {
  requestId: string;
  crumbJson: string;
  addId?: string;
}): void {
  const { requestId } = event;
  // Claim before parsing. A release for an add that never asked has an id
  // and a crumb JSON that is not a snapshot; the slot has to go, and the
  // callback must not run.
  const reserved = claimBreadcrumbFilter(event.addId);
  const snapshot = snapshotFromJson(event.crumbJson);
  if (snapshot === null) {
    reply(requestId, null);
    return;
  }
  const callback = reserved ?? current;
  if (callback === undefined) {
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
    if (!isBreadcrumbLevel(source.level)) {
      return null;
    }
    snapshot.level = source.level;
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
 * level name, and that name is what is sent. `data: null` is kept as `null`.
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
    if (!isBreadcrumbLevel(record.level)) {
      return null;
    }
    out.level = record.level;
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
