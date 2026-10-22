import type { BreadcrumbSnapshot } from './types';

/**
 * Maps the URL of an `http` breadcrumb to the URL to record. It must return a
 * string and run synchronously. A throw, or a result that is not a string,
 * drops the crumb: the original URL is never recorded in its place.
 */
export type BreadcrumbUrlScrubber = (url: string) => string;

/** `user:pass` before a `?` or `#`: a colon that is not a host's port. */
function looksLikeCredentials(beforeStop: string): boolean {
  return beforeStop.includes(':') && !beforeStop.startsWith('[') && !/^[^:]*:\d*$/.test(beforeStop);
}

/**
 * The built-in scrubber. Drops `user:password@` from the authority, the query
 * string and the fragment. Kept: the scheme, host, port and path. Path
 * segments can still carry an identifier or a token (and a `;jsessionid=...`
 * path parameter stays): pass a custom scrubber when yours do.
 *
 * Plain string work, not `URL`: Hermes' `URL` is incomplete, and a value the
 * native SDK recorded may not parse (a relative or malformed URL still has to
 * lose its query). Leading and trailing whitespace is trimmed. A `?` or `#`
 * inside the password is treated as part of the credentials when a `:` comes
 * before it, so the whole `user:password@` goes. A `/` in the password ends
 * the authority, as in a URL parser, and is not handled.
 */
export const defaultBreadcrumbUrlScrubber: BreadcrumbUrlScrubber = (url) => {
  const trimmed = url.trim();
  const prefix = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(trimmed)?.[0] ?? '';
  let rest = trimmed.slice(prefix.length);
  if (prefix !== '') {
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const stop = authority.search(/[?#]/);
    const head = stop < 0 ? authority : authority.slice(0, stop);
    let at = head.lastIndexOf('@');
    if (at < 0 && looksLikeCredentials(head)) {
      // The `@` after a `?` or `#` that sits inside the password.
      at = authority.lastIndexOf('@');
    }
    if (at >= 0) {
      rest = rest.slice(at + 1);
    }
  }
  const end = rest.search(/[?#]/);
  return prefix + (end < 0 ? rest : rest.slice(0, end));
};

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
