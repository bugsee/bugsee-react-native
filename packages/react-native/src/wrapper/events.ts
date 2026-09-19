import { Status } from '../status';
import type { LifecycleEventName } from './lifecycle-events';

/**
 * A lifecycle event as it reaches JavaScript.
 *
 * `name` is typed as the known set OR an arbitrary string, deliberately. A
 * newer SDK adding an event must reach a JS subscriber rather than being
 * dropped by a wrapper that predates it — silently swallowing an unknown event
 * is how a whole feature goes missing with no error anywhere. The union keeps
 * autocomplete useful for the known names without closing the set.
 */
export interface LifecycleEvent {
  name: LifecycleEventName | (string & {});
  /** Present only for the events that carry one. */
  reportId?: string;
}

/**
 * The four events that correspond to an SDK status transition.
 *
 * Status is DERIVED from the lifecycle channel rather than delivered by a
 * second native emitter: Android exposes no status listener at all, only
 * `getStatus()`, and iOS's `bugseeDidChangeStatus:` belongs to the app's own
 * `BugseeDelegate` — consuming it would take it away from the app. Deriving
 * keeps one source, one mapping, and one set of tests covering both platforms.
 */
const STATUS_BY_EVENT: Partial<Record<string, Status>> = {
  Launching: Status.Launching,
  Launched: Status.Launched,
  Stopping: Status.Stopping,
  Stopped: Status.Stopped,
};

/**
 * The status `event` announces, or `undefined` when it announces none.
 *
 * Undefined rather than a default: reporting a status for an event that is not
 * a transition would tell a caller the SDK had moved when it had not, which is
 * worse than silence because it reads as information. The same applies to an
 * event this version does not know — unknown means unknown, not `Stopped`.
 */
export function statusForEvent(event: LifecycleEvent): Status | undefined {
  return STATUS_BY_EVENT[event.name];
}
