import { metroArgs, parseMetroPort } from '../../examples/bare/e2e/scenario';

/**
 * `E2E_METRO_PORT` steers a device run to this checkout's Metro (Task 7.6a).
 * Like the harness's other variables (`E2E_PLATFORM`, `E2E_IOS_TARGET`), a
 * bad value throws at once, naming itself: a typo must not become
 * `localhost:NaN` and a two-minute wait for a bundle that never comes.
 */
describe('E2E_METRO_PORT', () => {
  it("defaults to React Native's 8081 when unset", () => {
    expect(parseMetroPort(undefined)).toBe(8081);
  });

  it.each([
    ['1024', 1024],
    ['8082', 8082],
    ['65535', 65535],
  ])('accepts %p', (raw, port) => {
    expect(parseMetroPort(raw)).toBe(port);
  });

  it.each(['', ' ', 'abc', 'NaN', '8082.5', '8.082e3', '0x1f92', '+8082', '-8082', ' 8082', '8082 ', '1023', '0', '65536', '99999'])(
    'throws on %p',
    raw => {
      expect(() => parseMetroPort(raw)).toThrow(
        `E2E_METRO_PORT must be an integer from 1024 to 65535, got ${JSON.stringify(raw)}`,
      );
    },
  );

  it('adds no launch arguments when unset, so a default run is unchanged', () => {
    expect(metroArgs(undefined)).toEqual([]);
  });

  it("tells the simulator app the port through React Native's RCT_jsLocation", () => {
    expect(metroArgs('8082')).toEqual(['-RCT_jsLocation', 'localhost:8082']);
  });

  it('refuses a bad port rather than launching against it', () => {
    expect(() => metroArgs('NaN')).toThrow(/E2E_METRO_PORT must be an integer/);
  });
});
