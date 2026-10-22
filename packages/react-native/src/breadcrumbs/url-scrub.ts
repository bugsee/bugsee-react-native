import type { BreadcrumbSnapshot } from './types';

/**
 * Maps the URL of an `http` breadcrumb to the URL to record. It must return a
 * string and run synchronously. A throw, or a result that is not a string,
 * drops the crumb: the original URL is never recorded in its place.
 */
export type BreadcrumbUrlScrubber = (url: string) => string;

/** A colon before a `?` or `#`: a port or a password, which cannot be told apart. */
function looksLikeCredentials(beforeStop: string): boolean {
  return beforeStop.includes(':') && !beforeStop.startsWith('[');
}

/**
 * The built-in scrubber. Drops `user:password@` from the authority, the query
 * string and the fragment. Kept: the scheme, host, port and path. Path
 * segments can still carry an identifier or a token (and a `;jsessionid=...`
 * path parameter stays): pass a custom scrubber when yours do.
 *
 * Plain string work, not `URL`: Hermes' `URL` is incomplete, and a value the
 * native SDK recorded may not parse (a relative or malformed URL still has to
 * lose its query). Leading and trailing whitespace is trimmed. When an `@`
 * follows a `?` or `#` and a `:` comes before it (`u:pa?ss@host`, or a port
 * with an `@` in its query), the text cannot be told apart, so the whole
 * authority is replaced by `[redacted]`. A username with no `:` in that shape
 * is read as the host. A `/` in the password ends the authority, as in a URL
 * parser, and is not handled.
 */
export const defaultBreadcrumbUrlScrubber: BreadcrumbUrlScrubber = (url) => {
  const trimmed = url.trim();
  const parts = /^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)([^/]*)/.exec(trimmed);
  if (parts === null) {
    return cutTail(trimmed);
  }
  const prefix = parts[1] as string;
  const authority = parts[2] as string;
  const path = trimmed.slice(parts[0].length);
  const head = cutTail(authority);
  const host = head.includes('@')
    ? authority.slice(head.lastIndexOf('@') + 1)
    : looksLikeCredentials(head) && authority.includes('@')
      ? '[redacted]'
      : authority;
  return prefix + cutTail(host + path);
};

/** `text` up to the first `?` or `#`. */
function cutTail(text: string): string {
  const end = text.search(/[?#]/);
  return end < 0 ? text : text.slice(0, end);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
