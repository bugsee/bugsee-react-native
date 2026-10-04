import NativeBugsee from '../NativeBugsee';
import { BugseeReportProxy } from './BugseeReport';
import type { BugseeReportHandler } from './types';
import { errorName } from '../errorName';

interface ReportHandlerRequestEvent {
  handleId: string;
  phase: string;
  reportId: string;
  type: string;
  deadlineMs: number;
}

let currentHandler: BugseeReportHandler | null = null;
let subscribed = false;

/**
 * Installs the report handler. See `BugseeReportHandler` for the phase
 * contract; this only wires it up.
 *
 * Subscribes to the native event on the first non-null call and stays
 * subscribed for the rest of the process -- `null` tells native to stop
 * delivering (`setReportHandlerPhases(false, false)`) rather than tearing the
 * subscription down, since a later `setReportHandler` call must still be able
 * to resume delivery.
 */
export function setReportHandler(handler: BugseeReportHandler | null): void {
  currentHandler = handler;
  NativeBugsee.setReportHandlerPhases(
    !!handler?.onBeforeReportCreated,
    !!handler?.onAfterReportCreated,
  );
  if (handler && !subscribed) {
    subscribed = true;
    NativeBugsee.onReportHandlerRequest(onReportHandlerRequest);
  }
}

/**
 * Handles one `onReportHandlerRequest` delivery.
 *
 * The callback is read from `currentHandler` here, at dispatch, and never
 * again -- a `setReportHandler` call made while this delivery is in flight
 * replaces what the NEXT event sees, not this one. `completeReportHandler` is
 * called exactly once, from `finally`, whether the callback resolved,
 * rejected, threw synchronously, or never settled before its deadline.
 */
function onReportHandlerRequest(event: ReportHandlerRequestEvent): void {
  const handler = currentHandler;
  const callback =
    event.phase === 'before'
      ? handler?.onBeforeReportCreated
      : event.phase === 'after'
        ? handler?.onAfterReportCreated
        : undefined;

  if (!callback) {
    NativeBugsee.completeReportHandler(event.handleId);
    return;
  }

  const proxy = new BugseeReportProxy(event.handleId, event.reportId, event.type);

  // Local only: this never tells native anything. It marks the proxy dead so
  // an op made after the deadline rejects without crossing the bridge, while
  // JS still waits for the callback to settle before it calls
  // `completeReportHandler` -- native treats a second completion as a no-op,
  // so there is nothing to reconcile if the callback finishes after this.
  const deadlineTimer = setTimeout(() => proxy.markDead(), event.deadlineMs);

  Promise.resolve()
    // `.call(handler, proxy)`, not `callback(proxy)`: `callback` was read off
    // `handler` as a bare function reference, so an unbound call would give a
    // class-based handler's method `this === undefined`. `handler` here is
    // the one captured above, at dispatch -- not `currentHandler` re-read --
    // so a `setReportHandler` mid-flight still cannot change the receiver a
    // delivery already in progress calls back into.
    .then(() => callback.call(handler, proxy))
    .catch((error: unknown) => {
      // Never an unhandled rejection: a handler's own bug must not become
      // one, on top of whatever else it broke.
      console.error('[Bugsee] report handler threw', errorName(error));
    })
    .finally(() => {
      clearTimeout(deadlineTimer);
      proxy.markDead();
      NativeBugsee.completeReportHandler(event.handleId);
    })
    .catch((error: unknown) => {
      // The native call itself threw (a torn-down bridge, say). Native
      // completes the handle at its deadline or on detach regardless; this
      // only keeps the failure from becoming an unhandled rejection.
      console.error('[Bugsee] could not complete the report handler', errorName(error));
    });
}
