/**
 * The report-handler scenarios Task 3.4d drives on a device
 * (e2e/report-handler.test.ts).
 *
 * Every marker is `BUGSEE_E2E rh ...` and carries the run's nonce, as does
 * every value written into a report, so nothing an earlier run left behind --
 * a log line, a retained bundle -- can satisfy this run's assertions.
 *
 *   rh-live     onBefore edits every field and attaches data; onAfter reads
 *               the report back, then pokes the onBefore proxy it kept to
 *               prove a settled handle is dead.
 *   rh-hang     onBefore never settles: the native deadline must complete it.
 *   rh-throw    onBefore throws: the report must still ship.
 *   rh-crash    both phases mark, then a Java crash (`testNativeCrash`).
 *   rh-observe  the relaunch after rh-crash: both phases mark, and onAfter
 *               labels the report; the app itself does nothing else.
 */
import Bugsee, {
  IssueSeverity,
  type BugseeReport,
  type BugseeReportHandler,
} from '@bugsee/react-native';

export const REPORT_HANDLER_SCENARIOS = [
  'rh-live',
  'rh-hang',
  'rh-throw',
  'rh-crash',
  'rh-observe',
] as const;

export type ReportHandlerScenario = (typeof REPORT_HANDLER_SCENARIOS)[number];

export function isReportHandlerScenario(
  name: string,
): name is ReportHandlerScenario {
  return (REPORT_HANDLER_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E rh ${message}`);
}

/** The error code a report operation rejected with, or `none`. */
async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return 'none';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `uncoded:${String(error)}`;
  }
}

/** base64 of an ASCII string (RN provides `btoa`; there is no Buffer). */
function base64(ascii: string): string {
  return btoa(ascii);
}

function liveHandler(nonce: string): BugseeReportHandler {
  let kept: BugseeReport | undefined;
  return {
    async onBeforeReportCreated(report) {
      mark(`before type=${report.type} id=${report.id} nonce=${nonce}`);
      kept = report;
      await report.setSummary(`e2e-${nonce}`);
      await report.setDescription(`d-${nonce}`);
      await report.setSeverity(IssueSeverity.Critical);
      await report.setLabels(['e2e', nonce]);
      await report.setAttribute('nonce', nonce);
      await report.addDataAttachment(base64(`hello ${nonce}`), {
        name: `e2e-${nonce}.txt`,
        mimeType: 'text/plain',
      });
      // A path that cannot exist: the SDK refuses it, and the refusal must
      // surface as a coded rejection rather than a silent no-op.
      const refused = await codeOf(
        report.addFileAttachment(`/nonexistent/${nonce}`, { name: 'x' }),
      );
      mark(`attach-refused code=${refused} nonce=${nonce}`);
      mark(`before done nonce=${nonce}`);
    },
    async onAfterReportCreated(report) {
      const snapshot = await report.read();
      mark(
        `after type=${report.type} severity=${String(snapshot.severity)} ` +
          `labels=${JSON.stringify(snapshot.labels)} ` +
          `ids=${JSON.stringify(snapshot.screenshotDisplayIds)} ` +
          `attachments=${JSON.stringify(snapshot.attachmentNames)} nonce=${nonce}`,
      );
      // onBefore has settled by now, so its handle must be dead: a write
      // through it must reject, and must not reach the report.
      if (kept !== undefined) {
        const late = await codeOf(kept.setSummary('late'));
        mark(`dead-handle code=${late} nonce=${nonce}`);
      }
    },
  };
}

/**
 * rh-crash / rh-observe. onAfter labels the report, so if a recovered crash
 * does reach JS the test can see whether the edit landed in its bundle.
 */
function markingHandler(nonce: string): BugseeReportHandler {
  return {
    onBeforeReportCreated(report) {
      mark(`before type=${report.type} id=${report.id} nonce=${nonce}`);
    },
    async onAfterReportCreated(report) {
      await report.setLabels(['e2e', nonce]);
      mark(`after type=${report.type} id=${report.id} labels-set nonce=${nonce}`);
    },
  };
}

function handlerFor(
  scenario: ReportHandlerScenario,
  nonce: string,
): BugseeReportHandler {
  switch (scenario) {
    case 'rh-live':
      return liveHandler(nonce);
    case 'rh-hang':
      return {
        async onBeforeReportCreated(report) {
          mark(`before type=${report.type} id=${report.id} nonce=${nonce}`);
          await new Promise<never>(() => {});
        },
      };
    case 'rh-throw':
      return {
        onBeforeReportCreated(report) {
          mark(`before type=${report.type} id=${report.id} nonce=${nonce}`);
          throw new Error(`e2e throw ${nonce}`);
        },
      };
    case 'rh-crash':
    case 'rh-observe':
      return markingHandler(nonce);
  }
}

/** Registers the scenario's handler. Called before `launch()`. */
export function installReportHandler(
  scenario: ReportHandlerScenario,
  nonce: string,
): void {
  Bugsee.setReportHandler(handlerFor(scenario, nonce));
  mark(`handler installed scenario=${scenario} nonce=${nonce}`);
}

/** What the scenario does once the SDK is Launched. */
export function runReportHandlerScenario(
  scenario: ReportHandlerScenario,
  nonce: string,
): void {
  switch (scenario) {
    case 'rh-live':
    case 'rh-hang':
    case 'rh-throw':
      mark(`upload nonce=${nonce}`);
      Bugsee.upload(`upload-${nonce}`, '');
      return;
    case 'rh-crash':
      mark(`crashing nonce=${nonce}`);
      Bugsee.testNativeCrash();
      return;
    case 'rh-observe':
      mark(`observing nonce=${nonce}`);
      return;
  }
}
