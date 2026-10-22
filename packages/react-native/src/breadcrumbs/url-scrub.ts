import type { BreadcrumbSnapshot } from './types';

/**
 * Maps the URL of an `http` breadcrumb to the URL to record. It must return a
 * string and run synchronously. A throw, or a result that is not a string,
 * drops the crumb: the original URL is never recorded in its place.
 */
export type BreadcrumbUrlScrubber = (url: string) => string;

/**
 * The built-in scrubber. Drops `user:password@` from the authority, the query
 * string and the fragment. Kept: the scheme, host, port and path. Path
 * segments can still carry an identifier or a token: pass a custom scrubber
 * when yours do.
 *
 * Plain string work, not `URL`: Hermes' `URL` is incomplete, and a value the
 * native SDK recorded may not parse (a relative or malformed URL still has to
 * lose its query).
 */
export const defaultBreadcrumbUrlScrubber: BreadcrumbUrlScrubber = (url) => {
  const end = url.search(/[?#]/);
  const withoutTail = end < 0 ? url : url.slice(0, end);
  return withoutTail.replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/]*@/, '$1');
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `snapshot` with `data.url` replaced by `scrub(url)`, when it is an `http`
 * crumb carrying a string URL. Any other crumb comes back as it is. Throws
 * when `scrub` throws or returns a non-string, so the caller drops the crumb.
 */
export function scrubSnapshotUrl(
  snapshot: BreadcrumbSnapshot,
  scrub: BreadcrumbUrlScrubber,
): BreadcrumbSnapshot {
  const data = snapshot.data;
  if (snapshot.type !== 'http' || !isPlainRecord(data) || typeof data.url !== 'string') {
    return snapshot;
  }
  const scrubbed: unknown = scrub(data.url);
  if (typeof scrubbed !== 'string') {
    throw new TypeError('breadcrumb URL scrubber must return a string');
  }
  return { ...snapshot, data: { ...data, url: scrubbed } };
}
