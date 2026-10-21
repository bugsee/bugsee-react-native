import { classifyFilterRequest } from '../console/dedup';
import NativeBugsee from '../NativeBugsee';

/**
 * One log line in, the line to keep out.
 *
 * A string replaces the line. `null` and `undefined` drop it. A promise is
 * waited on, for at most 9 s: an answer after that is ignored. On iOS the
 * bridge drops the line at 9 s (the SDK has no deadline). On Android the
 * bridge stops waiting at 9 s and the SDK drops the line at 10 s. This
 * function does not add a timeout of its own: a timeout here that then passed
 * the original line would leak exactly what the filter exists to remove.
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
 * The JS listener is subscribed before the native filter is installed, so a
 * line filtered on the installing turn still has a listener. A request
 * emitted in that gap is dropped when its deadline passes. The
 * subscription stays: clearing the callback stops native from asking, and a
 * later callback must still be able to answer.
 *
 * The native filter lives for the whole process, but the JavaScript side that
 * answers it does not. After a full reload, `DevSettings.reload()`, or an OTA
 * reload (`Updates.reloadAsync()`, CodePush `restartApp()`), the new runtime
 * has not installed a filter yet, so native fails closed: lines are dropped, not recorded unfiltered.
 * That lasts until `setLogFilter` is called again, which can be the rest of the
 * process. Call it unconditionally at startup, on every launch of the JS
 * runtime, not lazily or conditionally (after login or consent), and keep it
 * in every OTA bundle. To opt out, call `setLogFilter(null)`, which restores
 * pass-through.
 */
export function setLogFilter(callback?: LogFilter | null): void {
  if (callback != null && typeof callback !== 'function') {
    throw new TypeError(
      `Bugsee.setLogFilter requires a function, got ${typeof callback}`,
    );
  }
  if (callback != null && !subscribed) {
    NativeBugsee.onLogFilterRequest(onLogFilterRequest);
    subscribed = true;
  }
  current = callback ?? undefined;
  NativeBugsee.setLogFilterEnabled(current !== undefined);
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
 * A callback that does not settle within 9 s drops the line, and its late
 * answer is ignored. Neither path replies with the original line.
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
