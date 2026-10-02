import NativeBugsee from '../NativeBugsee';

/**
 * One network event in, the event to keep out.
 *
 * The native keep-value is the event object (`Callback1<NetworkEvent>` on
 * Android, `BugseeNetworkFilterDecisionBlock` on iOS), so a replacement is
 * that object — not a string. `null` and `undefined` drop it. A promise is
 * waited on; the native SDK is what bounds that wait. This function does not
 * add a timeout of its own: a timeout here that then passed the original
 * event would leak exactly what the filter exists to remove.
 */
export interface NetworkFilterEvent {
  id: string | null;
  url: string | null;
  method: string | null;
  /** Omitted when the native snapshot left the key out (iOS binary body). */
  body?: string | null;
  /** Omitted when the native snapshot left the key out. */
  headers?: Record<string, string> | null;
  mechanism: string | null;
  type: string | null;
  websocketEvent: string | null;
  responseCode: number;
  /** Android. Present, including `null`, when the snapshot sent the key. */
  errorDescription?: string | null;
  /** Android. Present, including `null`, when the snapshot sent the key. */
  errorShortMessage?: string | null;
  /** Android. Present, including `null`, when the snapshot sent the key. */
  statusText?: string | null;
  /** iOS. Present, including `null`, when the snapshot sent the key. */
  redirectedFromURL?: string | null;
  /** iOS. A dictionary, or `null`, when the snapshot sent the key. */
  error?: Record<string, unknown> | null;
}

export type NetworkFilter = (
  event: NetworkFilterEvent,
) =>
  | NetworkFilterEvent
  | null
  | undefined
  | Promise<NetworkFilterEvent | null | undefined>;

let current: NetworkFilter | undefined;
let subscribed = false;

/**
 * Registers `callback` as the only network filter. A later call replaces it.
 * `undefined` or `null` clears it, which tells native to uninstall the filter
 * so events are recorded without one.
 *
 * The native request is subscribed to once and stays subscribed: clearing the
 * callback stops native from asking, and a later callback must still be able
 * to answer.
 */
export function setNetworkFilter(callback?: NetworkFilter | null): void {
  if (callback != null && typeof callback !== 'function') {
    throw new TypeError(
      `Bugsee.setNetworkFilter requires a function, got ${typeof callback}`,
    );
  }
  // Subscribe before the native filter is installed. An event that arrives
  // in the gap is emitted to nobody and then dropped, which is how the
  // session's `before` stage was lost on a device.
  if (callback != null && !subscribed) {
    subscribed = true;
    NativeBugsee.onNetworkFilterRequest(onNetworkFilterRequest);
  }
  current = callback ?? undefined;
  NativeBugsee.setNetworkFilterEnabled(current !== undefined);
}

/**
 * Answers one native filter request.
 *
 * The callback is read here, at dispatch, so a `setNetworkFilter` made while
 * this request is in flight changes the next event, not this one. The
 * callback itself runs on a later turn: the native side has already returned,
 * and waiting for the callback on this turn would block the JS thread.
 *
 * A throw, a rejection, a result that is not the event object, or a result
 * that omits a writable key the snapshot sent drops the event. `url` is
 * always one of those keys. `body`, `headers`, `errorDescription`,
 * `errorShortMessage`, `statusText`, `redirectedFromURL`, and `error` are
 * too, when the snapshot sent that key, including when the value was
 * `null`. A `null` value on a key the snapshot sent is an explicit clear.
 * A key the snapshot omitted stays omitted: a `null` the callback wrote
 * for that key is left out of the reply, so `body: event.body ?? null`
 * does not clear a body the snapshot never had. A callback that never
 * settles does not reply at all — the SDK's own timeout drops it.
 * Neither path replies with the original event.
 */
function onNetworkFilterRequest(event: { requestId: string; eventJson: string }): void {
  const callback = current;
  const { requestId } = event;
  if (callback === undefined) {
    reply(requestId, null);
    return;
  }

  let parsed: NetworkFilterEvent;
  try {
    parsed = JSON.parse(event.eventJson) as NetworkFilterEvent;
  } catch {
    reply(requestId, null);
    return;
  }

  Promise.resolve()
    .then(() => callback(parsed))
    .then((result) => {
      reply(requestId, replacementJson(parsed, result));
    })
    .catch(() => {
      reply(requestId, null);
    });
}

/** Writable when the snapshot sent them. `url` is always required. */
const OPTIONAL_WRITABLE = [
  'body',
  'headers',
  'errorDescription',
  'errorShortMessage',
  'statusText',
  'redirectedFromURL',
  'error',
] as const;

/**
 * The event object, as JSON, or `null` when the result cannot be kept.
 *
 * A keep has to name every writable key the snapshot sent. Native writes
 * only keys that are present, so a partial object would leave the fields it
 * omitted on the event. `JSON.stringify` also drops `undefined`. A `null`
 * on a key the snapshot omitted is dropped from the reply before that, so
 * it is not a clear.
 */
function replacementJson(received: NetworkFilterEvent, result: unknown): string | null {
  if (!isEvent(result) || !keepsReceivedWritableKeys(received, result)) {
    return null;
  }
  const reply: Record<string, unknown> = {};
  for (const key of Object.keys(result)) {
    const value = result[key];
    // A null on a key the snapshot never sent is the callback filling in
    // `event.body ?? null`. Native would treat a present null as a clear.
    if (
      key !== 'url' &&
      value === null &&
      !Object.prototype.hasOwnProperty.call(received, key)
    ) {
      continue;
    }
    reply[key] = value;
  }
  try {
    return JSON.stringify(reply);
  } catch {
    return null;
  }
}

function keepsReceivedWritableKeys(
  received: NetworkFilterEvent,
  result: Record<string, unknown>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(result, 'url') || result.url === undefined) {
    return false;
  }
  return OPTIONAL_WRITABLE.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(received, key)) {
      return true;
    }
    return Object.prototype.hasOwnProperty.call(result, key) && result[key] !== undefined;
  });
}

function isEvent(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reply(requestId: string, eventJson: string | null): void {
  try {
    NativeBugsee.replyNetworkFilter(requestId, eventJson);
  } catch {
    // The bridge is gone. An unanswered request is dropped by the SDK.
  }
}
