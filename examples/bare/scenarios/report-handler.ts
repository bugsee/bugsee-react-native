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
 *   rh-clear    onBefore sets the summary, description and three attributes,
 *               then clears the summary and description and removes one
 *               attribute with `null` -- the edits iOS's object-argument
 *               conversion used to drop (Task 4.5). The third attribute's
 *               value ends in half an emoji, which must cross as U+FFFD.
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
  'rh-clear',
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

/**
 * rh-clear. Sets first, so the clear has something to clear and the test
 * can tell "cleared" from "never set"; reads back after each step, so a
 * marker says what JS saw before the bundle says what the SDK wrote.
 */
function clearingHandler(nonce: string): BugseeReportHandler {
  const gone = `gone-${nonce}`;
  const kept = `kept-${nonce}`;
  const cut = `cut-${nonce}`;
  return {
    async onBeforeReportCreated(report) {
      mark(`before type=${report.type} id=${report.id} nonce=${nonce}`);
      // Which normaliser encodeBridgeObject uses on this engine.
      mark(
        `clear engine toWellFormed=${typeof (String.prototype as { toWellFormed?: unknown }).toWellFormed} ` +
          `nonce=${nonce}`,
      );
      await report.setSummary(`set-${nonce}`);
      await report.setDescription(`d-${nonce}`);
      await report.setAttribute(gone, `g-${nonce}`);
      await report.setAttribute(kept, `k-${nonce}`);
      // Cut mid-emoji: a lone high surrogate. Unnormalised, its `\ud83d`
      // escape made iOS reject the whole patch.
      await report.setAttribute(cut, `c-${nonce}-${'\u{1F600}'.slice(0, 1)}`);
      const set = await report.read();
      mark(
        `clear set summary=${String(set.summary)} description=${String(set.description)} ` +
          `attrs=${JSON.stringify(set.attributes)} nonce=${nonce}`,
      );
      await report.setSummary(null);
      await report.setDescription(null);
      await report.setAttribute(gone, null);
      const cleared = await report.read();
      mark(
        `clear cleared summary=${String(cleared.summary)} description=${String(cleared.description)} ` +
          `attrs=${JSON.stringify(cleared.attributes)} nonce=${nonce}`,
      );
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
    case 'rh-clear':
      return clearingHandler(nonce);
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
    case 'rh-clear':
      // A description of its own, so clearing it is observable: the other
      // scenarios upload with '' and could not tell cleared from empty.
      mark(`upload nonce=${nonce}`);
      Bugsee.upload(`upload-${nonce}`, `udesc-${nonce}`);
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
