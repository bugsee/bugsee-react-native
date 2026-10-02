/**
 * The reporting scenarios Task 8.3a drives on a device
 * (e2e/reporting.test.ts).
 *
 * Every marker is `BUGSEE_E2E rp ...`. Every value written into a report
 * carries the run's nonce, so nothing an earlier run left behind can pass
 * for this one.
 *
 *   rp-upload      four upload() forms after Launched, then a fifth argument
 *                  that must throw.
 *   rp-prelaunch   upload() and showReportDialog() before launch(), then
 *                  `prelaunch-sent`. A lifecycle subscription logs each name.
 *   rp-dialog      a handler reads the report before the dialog opens, and a
 *                  lifecycle subscription logs BeforeReportShown. Nothing is
 *                  tapped: the send control has no stable resource-id.
 *   rp-create      a handler at create and at upload; one created report is
 *                  edited, attached to, uploaded, then read after it is dead.
 *   rp-attach      a handler attaches one file by copy and one by move, then
 *                  the app uploads.
 */
import Bugsee, {
  IssueSeverity,
  type BugseeCreatedReport,
  type BugseeReportHandler,
} from '@bugsee/react-native';
import { fileExists, writeTempFile } from 'bugsee-e2e-native';

export const REPORTING_SCENARIOS = [
  'rp-upload',
  'rp-prelaunch',
  'rp-dialog',
  'rp-create',
  'rp-attach',
] as const;

export type ReportingScenario = (typeof REPORTING_SCENARIOS)[number];

export function isReportingScenario(name: string): name is ReportingScenario {
  return (REPORTING_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E rp ${message}`);
}

/** base64 of an ASCII string (RN provides `btoa`; there is no Buffer). */
function base64(ascii: string): string {
  return btoa(ascii);
}

/** The error code an operation rejected with, or `ok` when it settled. */
async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string'
      ? code
      : `uncoded:${error instanceof Error ? error.name : typeof error}`;
  }
}

function subscribeLifecycle(): void {
  Bugsee.onLifecycleEvent(event => {
    mark(`lifecycle ${event.name}`);
  });
}

function dialogHandler(): BugseeReportHandler {
  return {
    async onBeforeReportCreated(report) {
      const snapshot = await report.read();
      mark(
        `dialog-before summary=${JSON.stringify(snapshot.summary)} ` +
          `description=${JSON.stringify(snapshot.description)} ` +
          `severity=${String(snapshot.severity)} ` +
          `labels=${JSON.stringify(snapshot.labels)}`,
      );
    },
  };
}

function createHandler(nonce: string): BugseeReportHandler {
  return {
    async onBeforeReportCreated(report) {
      await report.setAttribute('phase_before', `h-${nonce}`);
      mark('create before');
    },
    onAfterReportCreated() {
      mark('create after');
    },
  };
}

function attachHandler(nonce: string): BugseeReportHandler {
  return {
    async onBeforeReportCreated(report) {
      const copyPath = await writeTempFile(`copy-${nonce}.txt`, `copy ${nonce}`);
      const movePath = await writeTempFile(`move-${nonce}.txt`, `move ${nonce}`);
      await report.addFileAttachment(copyPath, {
        name: `copy-${nonce}.txt`,
        mimeType: 'text/plain',
      });
      await report.addFileAttachment(movePath, {
        name: `move-${nonce}.txt`,
        mimeType: 'text/plain',
        move: true,
      });
      mark(
        `exists copy=${String(await fileExists(copyPath))} ` +
          `move=${String(await fileExists(movePath))}`,
      );
    },
  };
}

/**
 * What must already be in place before `launch()`: the pre-launch calls, and
 * any handler or lifecycle subscription a report at launch would need.
 */
export function installReporting(scenario: ReportingScenario, nonce: string): void {
  switch (scenario) {
    case 'rp-prelaunch':
      subscribeLifecycle();
      Bugsee.upload(`pre-${nonce}`, '');
      Bugsee.showReportDialog(`pre-${nonce}`);
      mark('prelaunch-sent');
      return;
    case 'rp-dialog':
      subscribeLifecycle();
      Bugsee.setReportHandler(dialogHandler());
      return;
    case 'rp-create':
      Bugsee.setReportHandler(createHandler(nonce));
      return;
    case 'rp-attach':
      Bugsee.setReportHandler(attachHandler(nonce));
      return;
    case 'rp-upload':
      return;
  }
}

function runUpload(nonce: string): void {
  Bugsee.upload(`up2-${nonce}`, `d2-${nonce}`);
  Bugsee.upload(`up3-${nonce}`, `d3-${nonce}`, IssueSeverity.Critical);
  Bugsee.upload(`up4-${nonce}`, `d4-${nonce}`, IssueSeverity.Blocker, ['e2e', `l4-${nonce}`]);
  Bugsee.upload(`up5-${nonce}`, `d5-${nonce}`, undefined, [`l5-${nonce}`]);
  try {
    // The fifth argument is the call under test: the typed signature has no
    // slot for it, so the cast is the only way to write the call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bugsee.upload as any)(`x5-${nonce}`, '', 3, [], false);
    mark('upload-5th code=none');
  } catch (error) {
    mark(`upload-5th code=${error instanceof Error ? error.name : typeof error}`);
  }
}

async function logExtra(
  report: BugseeCreatedReport,
  k: '1' | '2',
  nonce: string,
): Promise<void> {
  try {
    await report.addDataAttachment(base64(`extra${k} ${nonce}`), {
      name: `extra${k}-${nonce}.txt`,
      mimeType: 'text/plain',
    });
    mark(`extra${k} ok`);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    mark(`extra${k} code=${typeof code === 'string' ? code : 'uncoded'}`);
  }
}

async function runCreate(nonce: string): Promise<void> {
  try {
    const r = await Bugsee.createReport();
    mark(`created null=${String(r === null)}`);
    if (r === null) {
      return;
    }
    await r.update({
      summary: `cr-${nonce}`,
      description: `crd-${nonce}`,
      severity: IssueSeverity.VeryLow,
      labels: [`c-${nonce}`],
      attributes: { created: `c-${nonce}` },
    });
    await r.addDataAttachment(base64(`data ${nonce}`), {
      name: `crdata-${nonce}.txt`,
      mimeType: 'text/plain',
    });
    const path = await writeTempFile(`crfile-${nonce}.txt`, `file ${nonce}`);
    await r.addFileAttachment(path, { name: `crfile-${nonce}.txt` });
    await logExtra(r, '1', nonce);
    await logExtra(r, '2', nonce);
    mark(`create-again code=${await codeOf(Bugsee.createReport())}`);
    mark('uploading');
    const ok = await r.upload();
    mark(`upload ${String(ok)}`);
    mark(`read code=${await codeOf(r.read())}`);
  } catch (error) {
    mark(
      `create-failed name=${error instanceof Error ? error.name : typeof error} ` +
        `message=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** What the scenario does once the SDK is Launched. */
export function runReportingScenario(scenario: ReportingScenario, nonce: string): void {
  switch (scenario) {
    case 'rp-upload':
      runUpload(nonce);
      return;
    case 'rp-prelaunch':
      return;
    case 'rp-dialog':
      Bugsee.showReportDialog(`dlg-${nonce}`, `dd-${nonce}`, IssueSeverity.High, [`dlg-${nonce}`]);
      return;
    case 'rp-create':
      runCreate(nonce).catch((error: unknown) =>
        mark(`create-failed name=${error instanceof Error ? error.name : typeof error}`),
      );
      return;
    case 'rp-attach':
      Bugsee.upload(`att-${nonce}`, '');
      return;
  }
}
