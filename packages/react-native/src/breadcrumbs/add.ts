import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { copyBreadcrumbData } from './data';
import { retainBreadcrumbFilterForAdd } from './filter';
import { isBreadcrumbLevel } from './types';
import type { Breadcrumb } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== 'string') {
    const kind = value === null ? 'null' : typeof value;
    throw new TypeError(`Bugsee.addBreadcrumb ${name} must be a string, got ${kind}`);
  }
  return value;
}

/**
 * Records `crumb` through the native exchange factory, which stamps the time.
 * `timestamp` on `crumb` is ignored. `data` omitted or `null` sends no data.
 */
export function addBreadcrumb(crumb: Breadcrumb): void {
  if (!isPlainObject(crumb)) {
    const kind = crumb === null ? 'null' : Array.isArray(crumb) ? 'array' : typeof crumb;
    throw new TypeError(`Bugsee.addBreadcrumb requires a crumb object, got ${kind}`);
  }
  const category = requireString('category', crumb.category);
  const message = requireString('message', crumb.message);
  const type = requireString('type', crumb.type);
  if (!isBreadcrumbLevel(crumb.level)) {
    const got = typeof crumb.level === 'string' ? crumb.level : typeof crumb.level;
    throw new TypeError(
      `Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got ${got}`,
    );
  }
  const level = crumb.level;
  let dataJson: string | null = null;
  if (crumb.data != null) {
    dataJson = encodeBridgeObject(copyBreadcrumbData(crumb.data));
  }
  retainBreadcrumbFilterForAdd(message);
  NativeBugsee.addBreadcrumb(category, level, message, type, dataJson);
}
