/**
 * The `bugsee-e2e-native` scenarios.
 *
 * `e2e-native-smoke` (Task 7.6a) proves the example-only module is linked and
 * reachable, after `Launched`:
 *   - `writeTempFile('smoke-<n>.txt', 'smoke <n>')`, then `fileExists` on the
 *     path it resolved, logged as `BUGSEE_E2E native tmp path=<p> exists=<b>`;
 *   - `crashNative` with a kind outside the type, inside `try`, logged as
 *     `BUGSEE_E2E native bad-kind code=<the caught error's name>` (`none` if
 *     nothing threw, which is the failure: the kind reached native code).
 *
 * `native-crash-segv` / `native-crash-abort` / `native-crash-observe`
 * (Task 7.6b): a report handler registered before `launch()` whose
 * `onAfterReportCreated` logs `BUGSEE_E2E native after type=<type>`; the
 * crash kinds, after `Launched`, log `BUGSEE_E2E native crashing kind=<kind>`
 * and then call `crashNative(kind)`. Observe installs the same handler and
 * does nothing else.
 */
import Bugsee, { type BugseeReport, type BugseeReportHandler } from '@bugsee/react-native';
import { crashNative, fileExists, writeTempFile } from 'bugsee-e2e-native';

export const NATIVE_SCENARIOS = [
  'e2e-native-smoke',
  'native-crash-segv',
  'native-crash-abort',
  'native-crash-observe',
  'native-crash-recover',
] as const;

export type NativeScenario = (typeof NATIVE_SCENARIOS)[number];

export function isNativeScenario(name: string): name is NativeScenario {
  return (NATIVE_SCENARIOS as readonly string[]).includes(name);
}

const CRASH_KINDS = {
  'native-crash-segv': 'segv',
  'native-crash-abort': 'abort',
} as const;

function isCrashScenario(
  scenario: NativeScenario,
): scenario is keyof typeof CRASH_KINDS {
  return scenario === 'native-crash-segv' || scenario === 'native-crash-abort';
}

function needsHandler(scenario: NativeScenario): boolean {
  return isCrashScenario(scenario) || scenario === 'native-crash-observe';
}

/**
 * `native-crash-recover` (iOS signal crash, ios-native-crash.test.ts): the
 * relaunch's handler labels the recovered crash with this run's nonce in
 * `onBeforeReportCreated` or `onAfterReportCreated`, whichever the SDK
 * offers, then says so. The labels in the crash bundle are what the test
 * asserts: the edits a recovery handler makes must reach the report.
 */
function recoverHandler(nonce: string): BugseeReportHandler {
  const label = async (phase: string, report: BugseeReport) => {
    mark(`recover ${phase} type=${report.type} id=${report.id} nonce=${nonce}`);
    if (report.type === 'crash') {
      await report.setLabels(['e2e-recovered', nonce]);
      mark(`recover ${phase} labels-set id=${report.id} nonce=${nonce}`);
    }
  };
  return {
    onBeforeReportCreated: report => label('before', report),
    onAfterReportCreated: report => label('after', report),
  };
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E native ${message}`);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function crashHandler(): BugseeReportHandler {
  return {
    onAfterReportCreated(report) {
      mark(`after type=${report.type}`);
    },
  };
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

/**
 * Registers a report handler before `launch()` for the crash scenarios.
 * On an NDK relaunch it is a negative probe: recovery runs on the bounded
 * thread, so the handler must not log `after type=crash`. It is not how an
 * NDK crash is delivered to JS.
 */
export function installNativeHandler(scenario: NativeScenario, nonce = ''): void {
  if (scenario === 'native-crash-recover') {
    Bugsee.setReportHandler(recoverHandler(nonce));
    mark(`recover handler installed nonce=${nonce}`);
    return;
  }
  if (!needsHandler(scenario)) {
    return;
  }
  Bugsee.setReportHandler(crashHandler());
}

/** What the scenario does once the SDK is Launched. */
export function runNativeScenario(scenario: NativeScenario, nonce: string): void {
  if (scenario === 'e2e-native-smoke') {
    runSmoke(nonce).catch((error: unknown) => mark(`smoke threw ${nameOf(error)}`));
    return;
  }
  if (scenario === 'native-crash-observe' || scenario === 'native-crash-recover') {
    return;
  }
  if (isCrashScenario(scenario)) {
    const kind = CRASH_KINDS[scenario];
    mark(`crashing kind=${kind}`);
    crashNative(kind);
    return;
  }
}
