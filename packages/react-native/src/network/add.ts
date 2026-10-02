import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';

/**
 * A network event the app records itself, for a stack the SDK does not
 * instrument. The bridge stamps the time. Native builds the event with the
 * SDK exchange factory and submits it with filtering required, so an
 * installed {@link import('./filter').setNetworkFilter} still sees it. This
 * function does not run that filter.
 */
export interface AddedNetworkEvent {
  url: string;
  method: string;
  /**
   * A stage name. `completed` is the name a device test records; it is the
   * native completed stage (`complete` on the wire). Omitted means that
   * same stage.
   */
  stage?: string;
  id?: string;
  body?: string | null;
  headers?: Record<string, string> | null;
  responseCode?: number;
  /** Android stores this. iOS drops it. The event is still recorded. */
  statusText?: string | null;
  /** Android stores this. iOS drops it. The event is still recorded. */
  errorDescription?: string | null;
  /** Android stores this. iOS drops it. The event is still recorded. */
  errorShortMessage?: string | null;
  /** iOS stores this. Android does not. The event is still recorded. */
  redirectedFromURL?: string | null;
  /** iOS stores this. Android does not. The event is still recorded. */
  error?: Record<string, unknown> | null;
}

/**
 * Stage names the caller may pass, and the wire value native maps onto a
 * stage. `completed` is not the native `toString` (`complete`); it is the
 * name the device test uses.
 */
const STAGE_WIRE: Readonly<Record<string, string>> = {
  completed: 'complete',
  complete: 'complete',
  before: 'before',
  started: 'before',
  redirect: 'redirect',
  error: 'error',
  abort: 'abort',
  aborted: 'abort',
  cancel: 'abort',
  timing: 'timing',
  timings: 'timing',
  websocket: 'websocket',
};

const OPTIONAL_KEYS = [
  'id',
  'body',
  'headers',
  'responseCode',
  'statusText',
  'errorDescription',
  'errorShortMessage',
  'redirectedFromURL',
  'error',
] as const;

export function addNetworkEvent(event: AddedNetworkEvent): void {
  if (!isEvent(event)) {
    const kind = event === null ? 'null' : Array.isArray(event) ? 'array' : typeof event;
    throw new TypeError(`Bugsee.addNetworkEvent requires an object, got ${kind}`);
  }
  if (typeof event.url !== 'string') {
    throw new TypeError(
      `Bugsee.addNetworkEvent requires a string url, got ${typeof event.url}`,
    );
  }
  if (typeof event.method !== 'string') {
    throw new TypeError(
      `Bugsee.addNetworkEvent requires a string method, got ${typeof event.method}`,
    );
  }
  const stageName = event.stage === undefined ? 'completed' : event.stage;
  if (typeof stageName !== 'string' || STAGE_WIRE[stageName] === undefined) {
    throw new TypeError(
      `Bugsee.addNetworkEvent stage must name a network stage, got ${String(stageName)}`,
    );
  }
  const wire: Record<string, unknown> = {
    url: event.url,
    method: event.method,
    stage: STAGE_WIRE[stageName],
  };
  for (const key of OPTIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(event, key)) {
      continue;
    }
    const value = event[key];
    if (key === 'headers') {
      wire.headers = headersValue(value);
      continue;
    }
    if (key === 'error') {
      wire.error = errorValue(value);
      continue;
    }
    if (key === 'responseCode') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(
          `Bugsee.addNetworkEvent responseCode must be a finite number, got ${String(value)}`,
        );
      }
      wire.responseCode = value;
      continue;
    }
    if (key === 'id' || key === 'body' || key === 'statusText' || key === 'errorDescription'
        || key === 'errorShortMessage' || key === 'redirectedFromURL') {
      if (value !== null && typeof value !== 'string') {
        throw new TypeError(
          `Bugsee.addNetworkEvent ${key} must be a string or null, got ${typeof value}`,
        );
      }
      wire[key] = value;
    }
  }
  NativeBugsee.addNetworkEvent(encodeBridgeObject(wire));
}

function isEvent(value: unknown): value is AddedNetworkEvent {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headersValue(value: unknown): Record<string, string> | null {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `Bugsee.addNetworkEvent headers must be an object or null, got ${typeof value}`,
    );
  }
  const headers: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const header = value[key];
    if (typeof header !== 'string') {
      throw new TypeError(
        `Bugsee.addNetworkEvent headers.${key} must be a string, got ${typeof header}`,
      );
    }
    headers[key] = header;
  }
  return headers;
}

function errorValue(value: unknown): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `Bugsee.addNetworkEvent error must be an object or null, got ${typeof value}`,
    );
  }
  return { ...value };
}
