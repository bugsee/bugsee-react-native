/**
 * What the smoke scenarios (./scenarios.tsx) and their e2e
 * (e2e/smoke.test.ts) must agree on. No imports: the e2e runs in Node and
 * cannot load React Native.
 */

/** The secure box and the open control box (S6): nothing else on screen is either colour. */
export const SMOKE_SECURE_COLOUR = '#FF00FF';
export const SMOKE_OPEN_COLOUR = '#00FFFF';

/** The synthetic debug id S3 registers for nonce `n`. */
export function smokeDebugIdFor(nonce: string): string {
  return `5e0c2f4e-0d3b-4e6f-9a7b-${nonce.padStart(12, '0').slice(-12)}`;
}
