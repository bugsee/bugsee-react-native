/**
 * `e2e-scenario.json` names the scenario App.tsx runs. The device e2e writes
 * it before each launch (e2e/scenario.ts); scripts/write-credentials.mjs
 * writes the default, `{"scenario":"launch"}`. It is gitignored, so this
 * declares its shape for a checkout that has not generated it yet.
 */
declare module '*/e2e-scenario.json' {
  const scenario: {
    scenario: string;
    nonce?: string;
    /** Overrides the credentials' endpoint (iOS retention, e2e/bundles.ts). */
    endpoint?: string;
    /** `smoke`: index.js registers smoke/SmokeApp.tsx instead of App (E2E_SMOKE_ROOT=1). */
    root?: string;
  };
  export default scenario;
}
