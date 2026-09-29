/**
 * The `bugsee-e2e-native` scenarios (e2e/e2e-native.test.ts, Task 7.6a).
 *
 * `e2e-native-smoke` proves the example-only module is linked and reachable,
 * after `Launched`:
 *   - `writeTempFile('smoke-<n>.txt', 'smoke <n>')`, then `fileExists` on the
 *     path it resolved, logged as `BUGSEE_E2E native tmp path=<p> exists=<b>`;
 *   - `crashNative` with a kind outside the type, inside `try`, logged as
 *     `BUGSEE_E2E native bad-kind code=<the caught error's name>` (`none` if
 *     nothing threw, which is the failure: the kind reached native code).
 */
import { crashNative, fileExists, writeTempFile } from 'bugsee-e2e-native';

export const NATIVE_SCENARIOS = ['e2e-native-smoke'] as const;

export type NativeScenario = (typeof NATIVE_SCENARIOS)[number];

export function isNativeScenario(name: string): name is NativeScenario {
  return (NATIVE_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E native ${message}`);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function runSmoke(nonce: string): Promise<void> {
  try {
    const path = await writeTempFile(`smoke-${nonce}.txt`, `smoke ${nonce}`);
    mark(`tmp path=${path} exists=${String(await fileExists(path))}`);
  } catch (error) {
    mark(`tmp threw ${nameOf(error)}`);
  }

  try {
    crashNative('bogus' as never);
    mark('bad-kind code=none');
  } catch (error) {
    mark(`bad-kind code=${nameOf(error)}`);
  }
}

export function runNativeScenario(_scenario: NativeScenario, nonce: string): void {
  runSmoke(nonce).catch((error: unknown) => mark(`smoke threw ${nameOf(error)}`));
}
