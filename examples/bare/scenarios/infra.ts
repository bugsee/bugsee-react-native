/**
 * The campaign harness's own proof scenarios (N-12), driven by
 * e2e/infra-helpers.test.ts:
 *
 *   infra-native  each `bugsee-e2e-native` helper once: nativeLog at every
 *                 level, rctLog at warn, blockMain(1500) (a JS interval's
 *                 ticks are reported: timers stall with main), and FLAG_SECURE
 *                 on then off (Android; iOS resolves false).
 *   infra-stub    fetches the HTTP stub (scenarios/stub.ts): one 500, one 200.
 *
 * Markers: `BUGSEE_E2E infra <what> nonce=<n>`.
 */
import { blockMain, nativeLog, rctLog, setFlagSecure } from 'bugsee-e2e-native';

import { stubUrl } from './stub';

export const INFRA_SCENARIOS = ['infra-native', 'infra-stub'] as const;
export type InfraScenario = (typeof INFRA_SCENARIOS)[number];

export function isInfraScenario(name: string): name is InfraScenario {
  return (INFRA_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E infra ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runNative(nonce: string): Promise<void> {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    nativeLog(level, `infra native ${level} ${nonce}`);
  }
  rctLog('warn', `infra rct warn ${nonce}`);
  mark(`logs sent nonce=${nonce}`);

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 100);
  const started = Date.now();
  await blockMain(1500);
  const elapsed = Date.now() - started;
  clearInterval(timer);
  mark(`blockMain resolved elapsed=${elapsed} ticks=${ticks} nonce=${nonce}`);

  const on = await setFlagSecure(true);
  mark(`flag-secure on=${String(on)} nonce=${nonce}`);
  await sleep(2000);
  const off = await setFlagSecure(false);
  mark(`flag-secure off=${String(off)} nonce=${nonce}`);
  mark(`native done nonce=${nonce}`);
}

async function status(path: string): Promise<string> {
  try {
    const response = await fetch(stubUrl(path));
    await response.text();
    return String(response.status);
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runStub(nonce: string): Promise<void> {
  const failing = await status(`/status/500/infra-${nonce}`);
  const ok = await status(`/status/200/infra-${nonce}`);
  mark(`stub 500=${failing} 200=${ok} nonce=${nonce}`);
}

export async function runInfraScenario(scenario: InfraScenario, nonce: string): Promise<void> {
  try {
    if (scenario === 'infra-native') {
      await runNative(nonce);
    } else {
      await runStub(nonce);
    }
  } catch (error) {
    mark(`threw ${String(error)} nonce=${nonce}`);
  }
}
