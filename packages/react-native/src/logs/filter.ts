import { classifyFilterRequest } from '../console/dedup';
import NativeBugsee from '../NativeBugsee';

/**
 * One log line in, the line to keep out.
 *
 * A string replaces the line. `null` and `undefined` drop it. A promise is
 * waited on; the native SDK is what bounds that wait. This function does not
 * add a timeout of its own: both SDKs already drop a line whose filter does
 * not answer, and a timeout here that then passed the original line would
 * leak exactly what the filter exists to remove.
 */
export type LogFilter = (
  line: string,
) => string | null | undefined | Promise<string | null | undefined>;

let current: LogFilter | undefined;
let subscribed = false;

/**
 * Registers `callback` as the only log filter. A later call replaces it.
 * `undefined` or `null` clears it, which tells native to uninstall the filter
 * so lines are recorded without one.
 *
 * The native request is subscribed to once and stays subscribed: clearing the
 * callback stops native from asking, and a later callback must still be able
 * to answer.
 */
export function setLogFilter(callback?: LogFilter | null): void {
  if (callback != null && typeof callback !== 'function') {
    throw new TypeError(
      `Bugsee.setLogFilter requires a function, got ${typeof callback}`,
    );
  }
  current = callback ?? undefined;
  NativeBugsee.setLogFilterEnabled(current !== undefined);
  if (current !== undefined && !subscribed) {
    subscribed = true;
    NativeBugsee.onLogFilterRequest(onLogFilterRequest);
  }
}

/**
 * Answers one native filter request.
 *
 * The callback is read here, at dispatch, so a `setLogFilter` made while this
 * request is in flight changes the next line, not this one. The callback
 * itself runs on a later turn: the native side has already returned, and
 * waiting for the callback on this turn would block the JS thread that
 * produced the line.
 *
 * A throw, a rejection, or a result that is not a string drops the line.
 * A callback that never settles does not reply at all — the SDK's own timeout
 * drops it. Neither path replies with the original line.
 */
function onLogFilterRequest(event: { requestId: string; line: string }): void {
  const callback = current;
  const { requestId } = event;
  // The RCTLog echo of a console call the JS patch already forwarded.
  // Answered here, before the user's callback, so a filter that samples,
  // counts, or appends runs once. Null drops the echo; it does not pass
  // the line through.
  if (classifyFilterRequest(event.line) === 'drop') {
    reply(requestId, null);
    return;
  }
  if (callback === undefined) {
    reply(requestId, null);
    return;
  }

  Promise.resolve()
    .then(() => callback(event.line))
    .then((result) => {
      reply(requestId, typeof result === 'string' ? result : null);
    })
    .catch(() => {
      reply(requestId, null);
    });
}

function reply(requestId: string, line: string | null): void {
  try {
    NativeBugsee.replyLogFilter(requestId, line);
  } catch {
    // The bridge is gone. An unanswered request is dropped by the SDK.
  }
}
