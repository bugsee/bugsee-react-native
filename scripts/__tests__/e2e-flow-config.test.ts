import {
  markerJson,
  parseIterations,
  parseList,
  parseLongBackgroundMs,
  parseNoWipe,
  parseUpgradePath,
  percentile,
} from '../../examples/bare/e2e/flow-config';

/**
 * The flow suites' environment (campaign N-10, N-15, N-17): a typo must fail
 * the run, never select a different test.
 */
describe('e2e flow config', () => {
  it('E2E_NO_WIPE is on only for exactly "1"', () => {
    expect(parseNoWipe(undefined)).toBe(false);
    expect(parseNoWipe('')).toBe(false);
    expect(parseNoWipe('0')).toBe(false);
    expect(parseNoWipe('1')).toBe(true);
    expect(() => parseNoWipe('true')).toThrow(/E2E_NO_WIPE must be "1" or "0", got "true"/);
    expect(() => parseNoWipe(' 1')).toThrow(/E2E_NO_WIPE/);
  });

  it('E2E_LONG_BACKGROUND_MS defaults to five minutes and refuses less than a second or a non-integer', () => {
    expect(parseLongBackgroundMs(undefined)).toBe(300_000);
    expect(parseLongBackgroundMs('')).toBe(300_000);
    expect(parseLongBackgroundMs('1000')).toBe(1_000);
    expect(parseLongBackgroundMs('600000')).toBe(600_000);
    expect(() => parseLongBackgroundMs('999')).toThrow(/>= 1000, got "999"/);
    expect(() => parseLongBackgroundMs('5m')).toThrow(/E2E_LONG_BACKGROUND_MS/);
    expect(() => parseLongBackgroundMs('1e5')).toThrow(/E2E_LONG_BACKGROUND_MS/);
  });

  it('percentile is nearest-rank over a sorted copy', () => {
    const values = [900, 100, 500, 300, 700];
    expect(percentile(values, 50)).toBe(500);
    expect(percentile(values, 95)).toBe(900);
    expect(percentile(values, 0)).toBe(100);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(values).toEqual([900, 100, 500, 300, 700]);
    expect(() => percentile([], 50)).toThrow(/no values/);
  });

  it('E2E_STRESS_ITERATIONS defaults to the plan\'s 20 and accepts 1 to 500', () => {
    expect(parseIterations(undefined)).toBe(20);
    expect(parseIterations('')).toBe(20);
    expect(parseIterations('1')).toBe(1);
    expect(parseIterations('500')).toBe(500);
    expect(() => parseIterations('0')).toThrow(/from 1 to 500, got "0"/);
    expect(() => parseIterations('501')).toThrow(/E2E_STRESS_ITERATIONS/);
    expect(() => parseIterations('20x')).toThrow(/E2E_STRESS_ITERATIONS/);
  });

  it('a list variable takes known items once each, and its fallback when unset', () => {
    const allowed = ['jsfatal', 'abort', 'segv'] as const;
    expect(parseList('K', undefined, allowed, ['abort'])).toEqual(['abort']);
    expect(parseList('K', ' ', allowed, allowed)).toEqual(['jsfatal', 'abort', 'segv']);
    expect(parseList('K', 'segv, jsfatal', allowed, [])).toEqual(['segv', 'jsfatal']);
    expect(() => parseList('K', 'segv,bus', allowed, [])).toThrow(/K: "bus" is not one of jsfatal, abort, segv/);
    expect(() => parseList('K', 'segv,segv', allowed, [])).toThrow(/K: "segv,segv" names an item twice/);
  });

  it('E2E_UPGRADE_PATH names one of the three paths or is off', () => {
    expect(parseUpgradePath(undefined)).toBeUndefined();
    expect(parseUpgradePath('')).toBeUndefined();
    expect(parseUpgradePath('U-01')).toBe('U-01');
    expect(parseUpgradePath('U-03')).toBe('U-03');
    expect(() => parseUpgradePath('U-04')).toThrow(/one of U-01, U-02, U-03, got "U-04"/);
    expect(() => parseUpgradePath('u-01')).toThrow(/E2E_UPGRADE_PATH/);
  });

  it('markerJson reads one field of a marker line up to the next field', () => {
    const line = 'BUGSEE_E2E flow upgrade state all={"e2e_int":42,"e2e_str":"blue-1"} id="e2e-user-1" nonce=ab12';
    expect(markerJson(line, 'all')).toEqual({ e2e_int: 42, e2e_str: 'blue-1' });
    expect(markerJson(line, 'id')).toBe('e2e-user-1');
    expect(markerJson('x id=null nonce=1', 'id')).toBeNull();
    expect(markerJson('x last=[1,2]', 'last')).toEqual([1, 2]);
    expect(() => markerJson(line, 'missing')).toThrow(/no missing= in/);
    // A key that is only the end of another key's name is not that key.
    expect(() => markerJson('x valid=1', 'id')).toThrow(/no id= in/);
  });
});
