/**
 * G2 / bugsee-cocoa#227: reports made right after `await launch()`, while the
 * SDK is still Launching (e2e/early-report.test.ts).
 *
 * The scenario owns the launch. As soon as `launch()` resolves it calls
 * `logException` and `upload`, with nothing in between. Then it asks for the
 * status: native runs each call on main in the order JS made them, so that
 * status is the one right after both calls, and `status=1` proves they landed
 * in the Launching window. iOS beta5 drops both calls there; the bridge holds
 * them until Launched. Each must reach a bundle.
 *
 * Markers:
 *   BUGSEE_E2E early sent launched=<bool> status=<n> nonce=<n>
 */
import Bugsee from '@bugsee/react-native';

export const EARLY_REPORT_SCENARIOS = ['early-report'] as const;

export type EarlyReportScenario = (typeof EARLY_REPORT_SCENARIOS)[number];

export function isEarlyReportScenario(name: string): name is EarlyReportScenario {
  return (EARLY_REPORT_SCENARIOS as readonly string[]).includes(name);
}

/** The handled exception's message. */
export function earlyExceptionReason(nonce: string): string {
  return `early-exc-${nonce}`;
}

/** The upload's summary. */
export function earlyUploadSummary(nonce: string): string {
  return `early-up-${nonce}`;
}

export async function runEarlyReportScenario(
  nonce: string,
  launch: () => Promise<boolean>,
): Promise<void> {
  const launched = await launch();
  Bugsee.logException(new Error(earlyExceptionReason(nonce)));
  Bugsee.upload(earlyUploadSummary(nonce), '');
  const status = await Bugsee.getStatus();
  console.log(
    `BUGSEE_E2E early sent launched=${String(launched)} status=${status} nonce=${nonce}`,
  );
}
