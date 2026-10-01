/**
 * Task 8.3a: every Android reporting path, proven from retained bundles.
 *
 * Retention is airplane mode, as for report-handler.test.ts (Task 3.4d):
 * the debug build is installed on the WOD_LX1, and Metro is reachable over
 * `adb reverse`. The banner, the asserted clear and `Launched` are the
 * preconditions `startRun` already checks. `duration` stays 90.
 *
 * Case 6 is not in this file. Step 0 (2026-10-01) found the dialog's send
 * control has no stable resource-id, and nothing here taps the dialog.
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
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
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
  Logcat,
  adb,
  resetScenario,
} from './scenario';

jest.setTimeout(12 * 60_000);

/** How long a bundle is given to land after the call that files it. */
const BUNDLE_WAIT_MS = 120_000;

describeDevice(`reporting paths in a retained bundle on ${TARGET_NAME}`, () => {
  let log: DeviceLog;

  beforeAll(async () => {
    log = await Logcat.start();
    useLog(log, '8.3a');
    // 9.3.2: offline before the app starts, so the report is retained.
    await airplane(true);
  });

  afterAll(async () => {
    // Always, and in this order: stop the app, drop what it retained, then
    // bring the network back -- the handset is shared.
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
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

    it('upload files as code_upload', () => {
      expect(uploads().length).toBeGreaterThan(0);
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
      expect(before.index).toBeLessThan(createdMarker.index);
      expect(uploading.index).toBeLessThan(after.index);
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
      must(
        log.all(/BUGSEE_E2E rp extra2 ok/, run.start)[0],
        'rp extra2 ok',
        run.start,
      );
      expect(attachmentsOf(created())).toHaveLength(4);
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
