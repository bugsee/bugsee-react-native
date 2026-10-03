import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { severityArgument } from '../report/fields';

/**
 * Queues a notification for the app's messaging integrations.
 *
 * This does not create a bug report. Both SDKs persist it and upload it in
 * a batch; `urgent` skip-ahead POSTs this item without draining older ones.
 * Shorter calls are non-urgent. A call before `launch()` is ignored by the
 * SDK. An empty title is rejected here: both SDKs drop it and only log.
 */
export function notify(
  title: string,
  body?: string | null,
  severity?: Parameters<typeof severityArgument>[0],
  fields?: Readonly<Record<string, string>> | null,
  urgent?: boolean,
): void {
  if (arguments.length > 5) {
    throw new TypeError('Bugsee.notify takes at most five arguments');
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new TypeError('Bugsee.notify requires a non-empty title');
  }
  let message: string | null = null;
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string') {
      throw new TypeError('Bugsee.notify body must be a string');
    }
    message = body;
  }
  let fieldsJson: string | null = null;
  if (fields !== undefined && fields !== null) {
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('Bugsee.notify fields must be an object of strings');
    }
    const copy: Record<string, string> = Object.create(null);
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (typeof value !== 'string') {
        throw new TypeError('Bugsee.notify fields must be an object of strings');
      }
      copy[key] = value;
    }
    fieldsJson = encodeBridgeObject(copy);
  }
  if (urgent !== undefined && typeof urgent !== 'boolean') {
    throw new TypeError('Bugsee.notify urgent must be a boolean');
  }
  NativeBugsee.notify(
    title,
    message,
    severityArgument(severity, 'notify'),
    fieldsJson,
    urgent === true,
  );
}
