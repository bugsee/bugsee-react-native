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
    /** Overrides the credentials' endpoint (iOS simulator retention). */
    endpoint?: string;
  };
  export default scenario;
}
