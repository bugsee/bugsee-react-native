/**
 * The environment the campaign's flow suites read (N-10, N-15, N-17), parsed
 * strictly: a typo throws, naming the variable, rather than running a
 * different test than asked for. Pure, so unit-tested
 * (scripts/__tests__/e2e-flow-config.test.ts).
 */

/**
 * `E2E_NO_WIPE=1`, the no-wipe mode (N-15): `clearBundles()` stops the app
 * but deletes nothing. Unset, `''` or `0` is off; anything but `1` throws.
 */
export function parseNoWipe(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === '0') {
    return false;
  }
  if (raw === '1') {
    return true;
  }
  throw new Error(`E2E_NO_WIPE must be "1" or "0", got ${JSON.stringify(raw)}`);
}

/** `E2E_LONG_BACKGROUND_MS` (FLOW-33): default five minutes, at least one second. */
export function parseLongBackgroundMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 300_000;
  }
  const ms = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(ms >= 1_000)) {
    throw new Error(`E2E_LONG_BACKGROUND_MS must be an integer number of ms >= 1000, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

/** The nearest-rank `p`th percentile of `values` (non-empty). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error('percentile of no values');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

/** `E2E_STRESS_ITERATIONS` (N-17): default 20, the plan's pass rule; 1..500. */
export function parseIterations(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 20;
  }
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= 1 && n <= 500)) {
    throw new Error(`E2E_STRESS_ITERATIONS must be an integer from 1 to 500, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A comma list, each item one of `allowed`, no repeats; unset means `fallback`. Anything else throws. */
export function parseList<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (raw === undefined || raw.trim() === '') {
    return [...fallback];
  }
  const items = raw.split(',').map(item => item.trim());
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw new Error(`${name}: ${JSON.stringify(item)} is not one of ${allowed.join(', ')}`);
    }
  }
  if (new Set(items).size !== items.length) {
    throw new Error(`${name}: ${JSON.stringify(raw)} names an item twice`);
  }
  return items as T[];
}

export const UPGRADE_PATHS = ['U-01', 'U-02', 'U-03'] as const;
export type UpgradePath = (typeof UPGRADE_PATHS)[number];

/** `E2E_UPGRADE_PATH` (N-15): unset means the suite is off. */
export function parseUpgradePath(raw: string | undefined): UpgradePath | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!(UPGRADE_PATHS as readonly string[]).includes(raw)) {
    throw new Error(`E2E_UPGRADE_PATH must be one of ${UPGRADE_PATHS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return raw as UpgradePath;
}

/**
 * The JSON after `key=` in a marker line, up to the next ` <word>=` field:
 * `upgrade state all={"a":1} id="x" nonce=n` -> `{"a":1}` for `all`.
 */
export function markerJson(text: string, key: string): unknown {
  const match = new RegExp(`(?:^|\\s)${key}=(.*?)(?= \\w+=|$)`).exec(text);
  if (match === null) {
    throw new Error(`no ${key}= in ${text}`);
  }
  return JSON.parse(match[1]!);
}
