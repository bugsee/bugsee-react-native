/**
 * Task 8.3a: every Android reporting path, proven from retained bundles.
 * Task 8.3b: the same cases on the iOS simulator, and on the iPhone.
 *
 * Android retention is airplane mode, as for report-handler.test.ts (Task
 * 3.4d): the debug build is installed on the WOD_LX1, and Metro is reachable
 * over `adb reverse`. iOS has no airplane mode to switch. Retention there is
 * the dead endpoint `startRun` already requires (`DEAD_ENDPOINT`), and every
 * retained bundle this suite pulls goes through `awaitBundles`, which
 * requires `environment.sdk.version` to equal `readNativeVersions().ios.sdk`
 * — the same pin `startRun` checks on the launch line. The banner, the
 * asserted clear and `Launched` are the preconditions `startRun` already
 * checks. `duration` stays 90.
 *
 * Android case 6 is not in this file. Step 0 (2026-10-01) found the dialog's
 * send control has no stable resource-id, and nothing here taps the dialog.
 * iOS case 6 is gated on `E2E_IOS_OPERATOR=1` and the iPhone. This file never
 * sets that variable and never taps Send. The simulator never runs case 6.
 *
 * iOS case 3 is `it.failing` (P10). The plain `it` before it is case 1,
 * which checks identity. The body still requires `source.type === 'code_upload'`.
 * Case 8 on iOS: `rp create before` and `rp create after` both follow
 * `rp uploading` (P6), and `rp created null=false` precedes `rp uploading`.
 * Case 10 on iOS: `extra1 ok`, `extra2 code=E_REPORT_ATTACHMENT_REJECTED`,
 * and case 7's bundle has exactly 3 attachments (P7). Case 11 is Android's:
 * `addAttachmentWithFilePath:…move:` honours `move`.
 *
 * Markers, from scenarios/reporting.ts:
 *   BUGSEE_E2E rp upload-5th code=<name>
 *   BUGSEE_E2E rp prelaunch-sent
 *   BUGSEE_E2E rp lifecycle <name>
 *   BUGSEE_E2E rp dialog-before summary=<json> description=<json> severity=<n> labels=<json>
 *   BUGSEE_E2E rp create before | created null=<b> | uploading | create after
 *   BUGSEE_E2E rp extra<k> ok|code=<c>
 *   BUGSEE_E2E rp create-again code=<c>
 *   BUGSEE_E2E rp upload <ok>
 *   BUGSEE_E2E rp read code=<c>
 *   BUGSEE_E2E rp exists copy=<b> move=<b>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type PulledBundle,
  airplane,
  attachmentsOf,
  removePulledBundles,
  terminateIosApp,
} from './bundles';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_IOS,
  type Run,
  awaitBundles,
  clearBundles,
  escape,
  listBundles,
  must,
  report,
  startRun,
  useLog,
  TARGET_NAME,
  describeDevice,
} from './harness';
import {
  type DeviceLog,
  type LogLine,
  IosConsole,
  Logcat,
  adb,
  resetScenario,
} from './scenario';
import { operatorEnabled, operatorStep } from './operator';

jest.setTimeout(12 * 60_000);

/**
 * Case 6. A person taps Send on the iPhone. This file never sets
 * `E2E_IOS_OPERATOR` and never taps the dialog. Without the variable the
 * case is skipped, and the simulator never runs it.
 */
const itIosOperator =
  ON_IOS && iosTarget() === 'device' && process.env.E2E_IOS_OPERATOR === '1' ? it : it.skip;

/**
 * Case 6 on Android (campaign N-18, step M-A1): a person taps Send on the
 * WOD_LX1, prompted by operator.ts. Runs only with `E2E_ANDROID_OPERATOR=1`;
 * this file never taps the dialog. Airplane mode retains the report.
 */
const itAndroidOperator = !ON_IOS && operatorEnabled('android') ? it : it.skip;

/** How long a bundle is given to land after the call that files it. */
const BUNDLE_WAIT_MS = 120_000;

describeDevice(`reporting paths in a retained bundle on ${TARGET_NAME}`, () => {
  let log: DeviceLog;

  beforeAll(async () => {
    if (ON_IOS) {
      // No network switch to throw: every iOS launch carries DEAD_ENDPOINT
      // (startIosRun), which is what retains its reports.
      log = IosConsole.start();
      useLog(log, '8.3b');
      return;
    }
    log = await Logcat.start();
    useLog(log, '8.3a');
    // 9.3.2: offline before the app starts, so the report is retained.
    await airplane(true);
  });

  afterAll(async () => {
    // Always, and in this order: stop the app, drop what it retained, then
    // bring the network back -- the handset is shared.
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        if (!ON_IOS) {
          await airplane(false);
        }
      } finally {
        try {
          const { removed, kept } = removePulledBundles();
          report('pulled bundle roots', { removed: removed.length, kept });
        } finally {
          try {
            if (log !== undefined) {
              log.stop();
            }
          } finally {
            resetScenario();
          }
        }
      }
    }
  });

  function labelsOf(bundle: PulledBundle): string[] {
    const labels = bundle.request.labels;
    if (labels == null) {
      return [];
    }
    if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) {
      throw new Error(`${String(bundle.request.summary)} labels are not an array of strings: ${JSON.stringify(labels)}`);
    }
    return labels as string[];
  }

  function sourceType(bundle: PulledBundle): unknown {
    const source = bundle.request.source;
    if (source === null || typeof source !== 'object') {
      return undefined;
    }
    return (source as { type?: unknown }).type;
  }

  describe('upload', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    /** up2's severity: the SDK default, shared with up5. An integer 1–5. */
    let severityS: number;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rp-upload');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E rp upload-5th code=\\S+`),
          20_000,
          run.launched.index,
        ),
        'BUGSEE_E2E rp upload-5th',
        run.start,
      );

      bundles = await awaitBundles(4, BUNDLE_WAIT_MS);
      const filed = bundles.filter(bundle => String(bundle.request.summary ?? '').startsWith('up'));
      report('upload summaries', filed.map(bundle => bundle.request.summary));
      const sample = filed.find(bundle => bundle.request.summary === `up4-${nonce}`) ?? filed[0];
      if (sample !== undefined) {
        report('request.json', readFileSync(join(sample.dir, 'request.json'), 'utf8'));
      }
      const up2 = filed.find(bundle => bundle.request.summary === `up2-${nonce}`);
      severityS = typeof up2?.request.severity === 'number' ? up2.request.severity : Number.NaN;
      report('S', severityS);
    });

    function uploads(): PulledBundle[] {
      return bundles.filter(bundle => String(bundle.request.summary ?? '').startsWith('up'));
    }

    function uploadNamed(summary: string): PulledBundle {
      const found = uploads().filter(bundle => bundle.request.summary === summary);
      expect(found).toHaveLength(1);
      return found[0]!;
    }

    it('each upload form files one report with its fields', () => {
      expect(uploads()).toHaveLength(4);
      expect(Number.isInteger(severityS)).toBe(true);
      expect(severityS).toBeGreaterThanOrEqual(1);
      expect(severityS).toBeLessThanOrEqual(5);

      const up2 = uploadNamed(`up2-${nonce}`);
      expect(up2.request.description).toBe(`d2-${nonce}`);
      expect(up2.request.severity).toBe(severityS);
      expect(labelsOf(up2).some(label => label.includes(nonce))).toBe(false);

      const up3 = uploadNamed(`up3-${nonce}`);
      expect(up3.request.description).toBe(`d3-${nonce}`);
      expect({ summary: up3.request.summary, severity: up3.request.severity }).toEqual({
        summary: `up3-${nonce}`,
        severity: 4,
      });
      expect(labelsOf(up3).some(label => label.includes(nonce))).toBe(false);

      const up4 = uploadNamed(`up4-${nonce}`);
      expect(up4.request.description).toBe(`d4-${nonce}`);
      expect(up4.request.severity).toBe(5);
      expect(labelsOf(up4)).toEqual(expect.arrayContaining(['e2e', `l4-${nonce}`]));

      const up5 = uploadNamed(`up5-${nonce}`);
      expect(up5.request.description).toBe(`d5-${nonce}`);
      expect(up5.request.severity).toBe(severityS);
      expect(labelsOf(up5)).toEqual(expect.arrayContaining([`l5-${nonce}`]));
    });

    it('a fifth argument is refused', () => {
      const line = must(
        log.all(new RegExp(`BUGSEE_E2E rp upload-5th code=\\S+`), run.start)[0],
        'BUGSEE_E2E rp upload-5th',
        run.start,
      );
      expect(line.text).toContain('upload-5th code=TypeError');
      expect(bundles.some(bundle => bundle.request.summary === `x5-${nonce}`)).toBe(false);
    });

    // Case 1, above, is the plain `it` that checks identity. This one is
    // `it.failing` on iOS only (P10): beta3's `uploadWithSummary:…` files
    // `source.type` other than `code_upload`. The assertion stays
    // `code_upload`. The observed value is reported, and is not what passes.
    const case3 = ON_IOS ? it.failing : it;
    case3('upload files as code_upload', () => {
      expect(uploads().length).toBeGreaterThan(0);
      const observed = uploads().map(bundle => ({
        summary: bundle.request.summary,
        sourceType: sourceType(bundle),
      }));
      report('case 3 source.type', observed);
      for (const bundle of uploads()) {
        expect({ summary: bundle.request.summary, sourceType: sourceType(bundle) }).toEqual({
          summary: bundle.request.summary,
          sourceType: 'code_upload',
        });
      }
    });
  });

  describe('before launch', () => {
    let run: Run;
    let nonce: string;
    let prelaunch: LogLine;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rp-prelaunch');
      nonce = run.scenario.nonce;
      prelaunch = must(
        log.all(new RegExp(`BUGSEE_E2E rp prelaunch-sent`), run.start)[0],
        'BUGSEE_E2E rp prelaunch-sent',
        run.start,
      );
      // Long enough that a report the pre-launch calls had filed would be
      // on disk. Nothing is uploaded after Launched, so this is the wait.
      const deadline = Date.now() + 15_000;
      let names = await listBundles();
      while (names.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        names = await listBundles();
      }
    });

    it('nothing is filed or shown before launch', async () => {
      expect(prelaunch.index).toBeLessThan(run.launched.index);
      // The subscription is live, so an absent BeforeReportShown is an
      // event that did not happen, not a listener that was never installed.
      must(
        log.all(/BUGSEE_E2E rp lifecycle \S+/, run.start)[0],
        'BUGSEE_E2E rp lifecycle',
        run.start,
      );
      expect(log.all(/BeforeReportShown/, run.start)).toEqual([]);

      const bundles = (await listBundles()).length === 0 ? [] : await awaitBundles(1, 5_000);
      report('prelaunch summaries', bundles.map(bundle => bundle.request.summary));
      expect(bundles.some(bundle => bundle.request.summary === `pre-${nonce}`)).toBe(false);
    });
  });

  describe('dialog', () => {
    let run: Run;
    let nonce: string;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rp-dialog');
      nonce = run.scenario.nonce;
      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E rp dialog-before summary=`),
          20_000,
          run.launched.index,
        ),
        'BUGSEE_E2E rp dialog-before',
        run.start,
      );
      must(
        await log.waitFor(/BeforeReportShown/, 20_000, run.launched.index),
        'BeforeReportShown',
        run.start,
      );
    });

    it('the dialog opens pre-filled', () => {
      const before = must(
        log.all(
          new RegExp(
            `BUGSEE_E2E rp dialog-before summary="dlg-${escape(nonce)}" ` +
              `description="dd-${escape(nonce)}" severity=3 labels=\\["dlg-${escape(nonce)}"\\]`,
          ),
          run.start,
        )[0],
        `dialog-before summary="dlg-${nonce}" description="dd-${nonce}" severity=3 labels=["dlg-${nonce}"]`,
        run.start,
      );
      const shown = must(
        log.all(/BeforeReportShown/, run.start).find(line => line.index > before.index),
        'BeforeReportShown after dialog-before',
        run.start,
      );
      expect(before.index).toBeLessThan(shown.index);
      report('case 5 dialog-before', before.text.trim());
    });

    itIosOperator('submitting the dialog files the report', async () => {
      // The operator has 60 s. Nothing in this process taps the dialog.
      console.log('>>> Tap Send in the Bugsee report dialog on the iPhone now (60 s)');
      const filed = await awaitBundles(1, 60_000);
      const found = filed.filter(bundle => bundle.request.summary === `dlg-${nonce}`);
      expect(found).toHaveLength(1);
      const bundle = found[0]!;
      expect(bundle.request.description).toBe(`dd-${nonce}`);
      expect(bundle.request.severity).toBe(3);
      expect(labelsOf(bundle)).toEqual(expect.arrayContaining([`dlg-${nonce}`]));
      expect(sourceType(bundle)).toBe('code_dialog');
    });

    itAndroidOperator('submitting the dialog files the report (Android) [API-38]', async () => {
      const bundle = await operatorStep(
        {
          id: 'M-A1',
          device: 'Android WOD_LX1',
          timeoutMs: 90_000,
          instructions: [
            `The Bugsee report dialog is open with summary "dlg-${nonce}".`,
            'Tap the check-mark (Send / "Отправить") at the top right of the dialog.',
          ],
        },
        async () => {
          if ((await listBundles()).length === 0) {
            return undefined;
          }
          return (await awaitBundles(1, 1_000)).find(b => b.request.summary === `dlg-${nonce}`);
        },
      );
      report('M-A1 bundle', { file: bundle.file, source: bundle.request.source, severity: bundle.request.severity });
      expect(bundle.request.description).toBe(`dd-${nonce}`);
      expect(bundle.request.severity).toBe(3);
      expect(labelsOf(bundle)).toEqual(expect.arrayContaining([`dlg-${nonce}`]));
      expect(sourceType(bundle)).toBe('code_dialog');
      const filed = (await awaitBundles(1, 1_000)).filter(b => b.request.summary === `dlg-${nonce}`);
      expect(filed).toHaveLength(1);
    });
  });

  describe('createReport', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rp-create');
      nonce = run.scenario.nonce;
      must(
        await log.waitFor(/BUGSEE_E2E rp read code=\S+/, 45_000, run.launched.index),
        'BUGSEE_E2E rp read',
        run.start,
      );
      bundles = await awaitBundles(1, BUNDLE_WAIT_MS);
      report('create summaries', bundles.map(bundle => bundle.request.summary));
    });

    function created(): PulledBundle {
      const found = bundles.filter(bundle => bundle.request.summary === `cr-${nonce}`);
      expect(found).toHaveLength(1);
      return found[0]!;
    }

    it("a created report's edits reach its bundle", () => {
      const bundle = created();
      expect(bundle.request.description).toBe(`crd-${nonce}`);
      expect(bundle.request.severity).toBe(1);
      expect(labelsOf(bundle)).toEqual(expect.arrayContaining([`c-${nonce}`]));
      expect(bundle.manifest.attrs.created).toBe(`c-${nonce}`);
      expect(bundle.manifest.attrs.phase_before).toBe(`h-${nonce}`);

      const attachments = attachmentsOf(bundle);
      report('case 7 attachments', attachments.map(attachment => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
      })));
      const data = attachments.find(attachment => attachment.name === `crdata-${nonce}.txt`);
      const file = attachments.find(attachment => attachment.name === `crfile-${nonce}.txt`);
      expect(data).toBeDefined();
      expect(file).toBeDefined();
      expect(readFileSync(data!.path, 'utf8')).toBe(`data ${nonce}`);
      expect(readFileSync(file!.path, 'utf8')).toBe(`file ${nonce}`);
    });

    it('the handler runs at create, then at upload', () => {
      const before = must(
        log.all(/BUGSEE_E2E rp create before/, run.start)[0],
        'rp create before',
        run.start,
      );
      const createdMarker = must(
        log.all(/BUGSEE_E2E rp created null=false/, run.start)[0],
        'rp created null=false',
        run.start,
      );
      const uploading = must(
        log.all(/BUGSEE_E2E rp uploading/, run.start)[0],
        'rp uploading',
        run.start,
      );
      const after = must(
        log.all(/BUGSEE_E2E rp create after/, run.start)[0],
        'rp create after',
        run.start,
      );
      if (ON_IOS) {
        // P6: both callbacks run at upload. The created report already exists.
        expect(createdMarker.index).toBeLessThan(uploading.index);
        expect(uploading.index).toBeLessThan(before.index);
        expect(uploading.index).toBeLessThan(after.index);
      } else {
        expect(before.index).toBeLessThan(createdMarker.index);
        expect(uploading.index).toBeLessThan(after.index);
      }
    });

    it('one created report at a time, and none after upload', () => {
      must(
        log.all(/BUGSEE_E2E rp create-again code=E_REPORT_CREATE_BUSY/, run.start)[0],
        'rp create-again code=E_REPORT_CREATE_BUSY',
        run.start,
      );
      must(
        log.all(/BUGSEE_E2E rp upload true/, run.start)[0],
        'rp upload true',
        run.start,
      );
      must(
        log.all(/BUGSEE_E2E rp read code=E_REPORT_HANDLE_DEAD/, run.start)[0],
        'rp read code=E_REPORT_HANDLE_DEAD',
        run.start,
      );
    });

    it('created-report attachment limits', () => {
      must(
        log.all(/BUGSEE_E2E rp extra1 ok/, run.start)[0],
        'rp extra1 ok',
        run.start,
      );
      if (ON_IOS) {
        // P7: the bridge rejects the fourth attachment up front.
        must(
          log.all(/BUGSEE_E2E rp extra2 code=E_REPORT_ATTACHMENT_REJECTED/, run.start)[0],
          'rp extra2 code=E_REPORT_ATTACHMENT_REJECTED',
          run.start,
        );
        expect(attachmentsOf(created())).toHaveLength(3);
      } else {
        must(
          log.all(/BUGSEE_E2E rp extra2 ok/, run.start)[0],
          'rp extra2 ok',
          run.start,
        );
        expect(attachmentsOf(created())).toHaveLength(4);
      }
    });
  });

  describe('handler attachments', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rp-attach');
      nonce = run.scenario.nonce;
      must(
        await log.waitFor(/BUGSEE_E2E rp exists copy=\S+ move=\S+/, 30_000, run.launched.index),
        'BUGSEE_E2E rp exists',
        run.start,
      );
      bundles = await awaitBundles(1, BUNDLE_WAIT_MS);
      report('attach summaries', bundles.map(bundle => bundle.request.summary));
    });

    it('a handler attaches a file by copy and by move', () => {
      // iOS: addAttachmentWithFilePath:name:mimeType:move: honours `move`.
      // The assertions are Android's.
      const exists = must(
        log.all(/BUGSEE_E2E rp exists copy=\S+ move=\S+/, run.start)[0],
        'rp exists',
        run.start,
      );
      expect(exists.text).toContain('copy=true');
      expect(exists.text).toContain('move=false');

      const found = bundles.filter(bundle => bundle.request.summary === `att-${nonce}`);
      expect(found).toHaveLength(1);
      report(
        'case 11 manifest attachments',
        found[0]!.manifest.files.filter(file => file.type === 'attachment'),
      );
      const attachments = attachmentsOf(found[0]!);
      report('case 11 attachments', attachments.map(attachment => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
      })));
      const copy = attachments.find(attachment => attachment.name === `copy-${nonce}.txt`);
      const moved = attachments.find(attachment => attachment.name === `move-${nonce}.txt`);
      expect(copy).toBeDefined();
      expect(moved).toBeDefined();
      expect(readFileSync(copy!.path, 'utf8')).toBe(`copy ${nonce}`);
      expect(readFileSync(moved!.path, 'utf8')).toBe(`move ${nonce}`);
      expect(copy!.mimeType).toBe('text/plain');
      expect(moved!.mimeType).toBe('text/plain');
    });
  });
});
