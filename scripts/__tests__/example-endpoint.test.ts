import { DEAD_ENDPOINT, bugseeNamedUrl, deadEndpointUrl, isPlaceholderToken, launchEndpoint } from '../../examples/bare/endpoint';

/**
 * The example app never reaches the real Bugsee server with the committed
 * placeholder token (Task 3.H review I2): the server rejects it, and on iOS
 * that rejection leaves the app refusing every later launch.
 */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const REAL = '3f2a9c1e-7b44-4d0a-9e21-5c8f0b6d2a17'; // synthetic, shaped like a real token

describe('isPlaceholderToken', () => {
  it('knows the committed placeholder, and the all-zero UUID', () => {
    expect(isPlaceholderToken(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderToken('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isPlaceholderToken('00000000000040008000000000000000')).toBe(true);
  });

  it('does not take a real token, or any other digit, for it', () => {
    expect(isPlaceholderToken(REAL)).toBe(false);
    expect(isPlaceholderToken('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isPlaceholderToken('10000000-0000-4000-8000-000000000000')).toBe(false);
    expect(isPlaceholderToken('')).toBe(false);
  });
});

describe('launchEndpoint', () => {
  it('sends a placeholder token to the dead loopback endpoint, whatever was asked', () => {
    expect(launchEndpoint(PLACEHOLDER, undefined, '')).toEqual({ endpoint: DEAD_ENDPOINT, forced: true });
    expect(launchEndpoint(PLACEHOLDER, undefined, 'https://api.example.test')).toEqual({
      endpoint: DEAD_ENDPOINT,
      forced: true,
    });
    expect(launchEndpoint(PLACEHOLDER, 'https://api.example.test', '')).toEqual({
      endpoint: DEAD_ENDPOINT,
      forced: true,
    });
  });

  it('does not call it forced when the dead endpoint was asked for anyway', () => {
    expect(launchEndpoint(PLACEHOLDER, DEAD_ENDPOINT, '')).toEqual({ endpoint: DEAD_ENDPOINT, forced: false });
  });

  it('leaves a real token on the scenario endpoint, else the configured one', () => {
    expect(launchEndpoint(REAL, undefined, '')).toEqual({ endpoint: '', forced: false });
    expect(launchEndpoint(REAL, undefined, 'https://api.example.test')).toEqual({
      endpoint: 'https://api.example.test',
      forced: false,
    });
    expect(launchEndpoint(REAL, DEAD_ENDPOINT, 'https://api.example.test')).toEqual({
      endpoint: DEAD_ENDPOINT,
      forced: false,
    });
  });

  it('uses the closed loopback port the e2e retains reports with', () => {
    expect(DEAD_ENDPOINT).toBe('https://127.0.0.1:9');
  });
});

/**
 * A request the example expects native network capture to record. The iOS
 * SDK's release build treated any url containing "bugsee" as its own traffic
 * and never recorded it (BGSNetworkInterceptionIsBugseeURL, 7.0.0-beta3 and
 * beta4; beta5 tells its traffic apart by session instead). network.test.ts
 * failed on iOS for exactly that: its path was `bugsee-e2e-fetch/<nonce>`.
 * The guard stays for the probes that are not about the word; the one test
 * that is uses `bugseeNamedUrl`.
 */
describe('deadEndpointUrl', () => {
  it('puts the path on the dead loopback endpoint', () => {
    expect(deadEndpointUrl('e2e-fetch/abc123')).toBe('https://127.0.0.1:9/e2e-fetch/abc123');
  });

  it('refuses a path the iOS SDK would take for its own traffic', () => {
    expect(() => deadEndpointUrl('bugsee-e2e-fetch/abc123')).toThrow(/bugsee/);
    expect(() => deadEndpointUrl('e2e/abc123?from=bugsee')).toThrow(/bugsee/);
    // Case-insensitive on purpose: the SDK's check is case-sensitive today,
    // and a looser guard does not depend on that.
    expect(() => deadEndpointUrl('e2e/BugSee/abc123')).toThrow(/bugsee/);
  });
});

describe('bugseeNamedUrl', () => {
  it('carries lowercase "bugsee" in both the path and the query, on the dead endpoint', () => {
    const url = new URL(bugseeNamedUrl('abc123'));
    expect(`${url.protocol}//${url.host}`).toBe(DEAD_ENDPOINT);
    expect(url.pathname).toContain('bugsee');
    expect(url.search).toContain('bugsee');
    expect(url.pathname).toContain('abc123');
    expect(url.pathname + url.search).not.toMatch(/[A-Z]/);
  });

  it('refuses a tag that already carries the word, so the word is always the helper\'s', () => {
    expect(() => bugseeNamedUrl('my-bugsee')).toThrow(/bugsee/);
    expect(() => bugseeNamedUrl('BugSee')).toThrow(/bugsee/);
  });

  it('is exactly what deadEndpointUrl refuses', () => {
    expect(() => deadEndpointUrl(bugseeNamedUrl('abc123').slice(DEAD_ENDPOINT.length + 1))).toThrow(/bugsee/);
  });
});
