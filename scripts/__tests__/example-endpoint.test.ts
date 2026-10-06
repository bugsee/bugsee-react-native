import { DEAD_ENDPOINT, deadEndpointUrl, isPlaceholderToken, launchEndpoint } from '../../examples/bare/endpoint';

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
 * SDK's release build treats any url containing "bugsee" as its own traffic
 * and never records it (BGSNetworkInterceptionIsBugseeURL, 7.0.0-beta3 and
 * beta4). network.test.ts failed on iOS for exactly that: its path was
 * `bugsee-e2e-fetch/<nonce>`.
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
