import { defaultBreadcrumbUrlScrubber, scrubSnapshotUrl } from '../url-scrub';

describe('defaultBreadcrumbUrlScrubber', () => {
  it.each([
    ['https://api.example.com/v1/users', 'https://api.example.com/v1/users'],
    ['https://user:pw@api.example.com/v1', 'https://api.example.com/v1'],
    ['https://user@api.example.com:8443/v1', 'https://api.example.com:8443/v1'],
    ['https://api.example.com/v1?token=abc&x=1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1#access_token=abc', 'https://api.example.com/v1'],
    ['https://api.example.com/v1?a=1#frag', 'https://api.example.com/v1'],
    ['https://api.example.com?a=1', 'https://api.example.com'],
    ['https://api.example.com#f', 'https://api.example.com'],
    ['https://u:p@api.example.com?a=b@c', 'https://api.example.com'],
    ['https://u:p@h/path?next=https://x@y/', 'https://h/path'],
    ['https://api.example.com/a@b', 'https://api.example.com/a@b'],
    ['https://u:p@x@host/p', 'https://host/p'],
    ['//u:p@host/p?q', '//host/p'],
    ['wss://u:p@host/socket?t=1', 'wss://host/socket'],
    ['/relative/path?token=1', '/relative/path'],
    ['', ''],
    ['?token=1', ''],
    ['#frag', ''],
  ])('%s -> %s', (input, expected) => {
    expect(defaultBreadcrumbUrlScrubber(input)).toBe(expected);
  });
});

describe('scrubSnapshotUrl', () => {
  const upper = (url: string) => url.toUpperCase();

  it('replaces data.url of an http crumb and keeps the other keys', () => {
    const out = scrubSnapshotUrl(
      { type: 'http', category: 'http', data: { url: 'a?b', method: 'GET', body_size: 3 } },
      upper,
    );
    expect(out).toEqual({
      type: 'http',
      category: 'http',
      data: { url: 'A?B', method: 'GET', body_size: 3 },
    });
  });

  it('does not mutate its input', () => {
    const data = { url: 'a' };
    const input = { type: 'http', data };
    scrubSnapshotUrl(input, upper);
    expect(data.url).toBe('a');
    expect(input.data).toBe(data);
  });

  it.each([
    ['another type', { type: 'navigation', data: { url: 'a' } }],
    ['no data', { type: 'http' }],
    ['null data', { type: 'http', data: null }],
    ['array data', { type: 'http', data: ['a'] }],
    ['a non-string url', { type: 'http', data: { url: 5 } }],
    ['no url', { type: 'http', data: { method: 'GET' } }],
  ])('returns the same crumb for %s', (_name, crumb) => {
    expect(scrubSnapshotUrl(crumb, upper)).toBe(crumb);
  });

  it('throws on a non-string result so the caller drops the crumb', () => {
    expect(() =>
      scrubSnapshotUrl({ type: 'http', data: { url: 'a' } }, (() => undefined) as never),
    ).toThrow(TypeError);
  });
});
