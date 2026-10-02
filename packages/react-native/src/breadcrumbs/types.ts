/**
 * `Breadcrumb.Level.getValue()` from bugsee-android 7.3.0, not the enum
 * ordinal. iOS `BGSBreadcrumb.level` is the same `NSInteger`.
 *
 * DEBUG 1, INFO 2, WARNING 3, ERROR 4, FATAL 5. The ordinals are 0..4.
 */
export const BREADCRUMB_LEVEL_VALUE = {
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
  fatal: 5,
} as const;

export type BreadcrumbLevel = keyof typeof BREADCRUMB_LEVEL_VALUE;

const LEVEL_NAMES: readonly BreadcrumbLevel[] = [
  'debug',
  'info',
  'warning',
  'error',
  'fatal',
];

/** The numeric `getValue()` for a level name, or `undefined` when it is not one. */
export function breadcrumbLevelValue(level: unknown): number | undefined {
  if (typeof level !== 'string') {
    return undefined;
  }
  if (!Object.hasOwn(BREADCRUMB_LEVEL_VALUE, level)) {
    return undefined;
  }
  return BREADCRUMB_LEVEL_VALUE[level as BreadcrumbLevel];
}

/** The level name for a `getValue()`, or `undefined` when the number is not one. */
export function breadcrumbLevelName(value: unknown): BreadcrumbLevel | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }
  return LEVEL_NAMES[value - 1];
}

/**
 * What `addBreadcrumb` records. The factory stamps the time, so `timestamp`
 * is not a field the caller supplies.
 */
export interface Breadcrumb {
  category: string;
  level: BreadcrumbLevel;
  message: string;
  type: string;
  data?: Record<string, unknown> | null;
}

/**
 * What the filter callback sees. A key the native crumb did not have is
 * absent. `timestamp` may be present and is not writable: a keep does not
 * have to send it back. `data` is present only when the crumb had data,
 * including when that value is `null` only on the way back, to clear it.
 */
export interface BreadcrumbSnapshot {
  category?: string;
  level?: BreadcrumbLevel;
  message?: string;
  type?: string;
  data?: unknown;
  timestamp?: number;
}

/**
 * One crumb in, the crumb to keep out.
 *
 * Returning the crumb, or another object, keeps it. `null` and `undefined`
 * drop it. A promise is waited on. This function does not add a timeout of
 * its own: an unanswered filter is not recorded, and a timeout here that then
 * passed the original crumb would leak exactly what the filter exists to
 * remove.
 */
export type BreadcrumbFilter = (
  crumb: BreadcrumbSnapshot,
) => object | null | undefined | Promise<object | null | undefined>;
