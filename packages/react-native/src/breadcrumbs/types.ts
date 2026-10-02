/**
 * The level names the bridge sends. Each native side maps a name to its own
 * integer when it writes the crumb. Those integers are not the same:
 *
 * Android `Breadcrumb.Level.getValue()` is debug 1, info 2, warning 3,
 * error 4, fatal 5 (not the enum ordinal).
 *
 * iOS `BGSBreadcrumb.level` is `BugseeLogLevel`: error 1, warning 2, info 3,
 * debug 4. There is no fatal on that ladder, so iOS stores `fatal` as 1,
 * which the bundle records as `error`. Verbose (5) is not a JS name; a
 * stored verbose reads back as `debug`.
 *
 * The filter snapshot's `level` is this name, on both platforms. A keep
 * echoes the name. Sending Android's integer to iOS records `info` as
 * `warning`.
 */
export const BREADCRUMB_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;

export type BreadcrumbLevel = (typeof BREADCRUMB_LEVELS)[number];

/** Whether `level` is one of the JS names. A number is not. */
export function isBreadcrumbLevel(level: unknown): level is BreadcrumbLevel {
  return typeof level === 'string' && (BREADCRUMB_LEVELS as readonly string[]).includes(level);
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
