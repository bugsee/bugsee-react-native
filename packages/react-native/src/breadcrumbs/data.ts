import { copyEventParams } from '../data/validate';
import type { EventParams } from '../data/validate';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of breadcrumb `data` in the same value domain as event params.
 *
 * `copyEventParams` names its path `params`. The messages are retargeted so
 * a rejection from `addBreadcrumb` names `data`.
 */
export function copyBreadcrumbData(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) {
    const kind = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    throw new TypeError(
      `Bugsee.addBreadcrumb data must be a plain object, got ${kind}`,
    );
  }
  try {
    return copyEventParams(data as EventParams);
  } catch (error) {
    if (error instanceof Error) {
      error.message = error.message.replaceAll('params', 'data');
    }
    throw error;
  }
}
