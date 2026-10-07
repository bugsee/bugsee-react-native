/**
 * Campaign N-17 / BLK-02: iOS crash recovery under stress, on the iPhone --
 * the cocoa-191b probe (cocoa-191b-results.md, E1) committed as an opt-in
 * suite. Opt in with `E2E_IOS_STRESS=1` (and `E2E_IOS_TARGET=device`): it
 * runs for hours at the default size.
 *
 * Per iteration and crash kind:
 *   1. the harness wipe, then the crash run: `exc-fatal` (a stored JS fatal,
 *      then SIGTERM as the harness stops the app), `native-crash-abort`
 *      (SIGABRT) or `native-crash-segv` (SIGSEGV);
 *   2. what the crash left (PLCrashReporter's queue, the #194 build record,
 *      the preferences on disk);
 *   3. the mode: `wipe` loses the preferences domain the way a harness wipe
 *      does (everything else in the container is put back), `keep` leaves it;
 *   4. the relaunch (`exc-observe` / `native-crash-recover`) and what it did:
 *      the report claimed (gone from the queue) and exactly one crash bundle,
 *      with no "Dropped a crash report left by another build" line (same build).
 *
 * Stock 7.0.0-beta4 claimed 11/20 in `wipe` mode (0/8 when the domain was
 * really lost); 7.0.0-beta5 (#194) must claim every one. One miss fails.
 *
 * Every iteration appends one JSON line to `E2E_STRESS_OUT` (default
 * `$CAMPAIGN_LOG_ROOT/n17-stress-<UTC>.jsonl`, else the OS temp dir): the
 * per-iteration record the plan asks for, kept whatever the verdict.
 *
 * Environment:
 *   E2E_STRESS_ITERATIONS  rounds (default 20; the plan's pass rule is 20/20)
 *   E2E_STRESS_KINDS       comma list of jsfatal, abort, segv (default all three)
 *   E2E_STRESS_MODES       comma list of wipe, keep (default wipe: BLK-02's prefs-loss mode)
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { terminateIosApp } from './bundles';
import { iosTarget } from './device';
import { parseIterations, parseList } from './flow-config';
import { IOS_SDK_LINE, ON_IOS, awaitBundles, bridgeLine, clearBundles, describeDevice, listBundles, must, report, startDeviceLog, startRun, stopDeviceLog } from './harness';
import { crashQueue, holdsBuildRecord, holdsReport, prefsState, wipeAllButPreferences } from './ios-container';
import { type DeviceLog, deviceTerminationSignal } from './scenario';

const KINDS = ['jsfatal', 'abort', 'segv'] as const;
type Kind = (typeof KINDS)[number];
const MODES = ['wipe', 'keep'] as const;
type Mode = (typeof MODES)[number];

const ENABLED = ON_IOS && process.env.E2E_IOS_STRESS === '1' && iosTarget() === 'device';
const describeStress = ENABLED ? describeDevice : describe.skip;

const ITERATIONS = ENABLED ? parseIterations(process.env.E2E_STRESS_ITERATIONS) : 0;
const STRESS_KINDS = ENABLED ? parseList('E2E_STRESS_KINDS', process.env.E2E_STRESS_KINDS, KINDS, KINDS) : [];
const STRESS_MODES = ENABLED ? parseList('E2E_STRESS_MODES', process.env.E2E_STRESS_MODES, MODES, ['wipe']) : [];

const OUT =
  process.env.E2E_STRESS_OUT ??
  join(process.env.CAMPAIGN_LOG_ROOT ?? tmpdir(), `n17-stress-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

jest.setTimeout(10 * 60_000);

const CRASH: Record<Kind, { run: string; observe: string }> = {
  jsfatal: { run: 'exc-fatal', observe: 'exc-observe' },
  abort: { run: 'native-crash-abort', observe: 'native-crash-recover' },
  segv: { run: 'native-crash-segv', observe: 'native-crash-recover' },
};

const DROPPED = /Dropped a crash report left by another build/;

interface Case {
  readonly iteration: number;
  readonly kind: Kind;
  readonly mode: Mode;
}

const CASES: Case[] = [];
for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
  for (const mode of STRESS_MODES) {
    for (const kind of STRESS_KINDS) {
      CASES.push({ iteration, kind, mode });
    }
  }
}

function record(row: Record<string, unknown>): void {
  mkdirSync(dirname(OUT), { recursive: true });
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

describeStress(`iOS crash recovery stress on the iPhone (N-17): ${ITERATIONS} iterations x ${STRESS_KINDS.join('+')} x ${STRESS_MODES.join('+')}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await startDeviceLog('N-17', 'N-17');
    report('per-iteration record', OUT);
  });

  afterAll(async () => {
    await terminateIosApp().catch(() => undefined);
    await clearBundles().catch(() => undefined);
    stopDeviceLog(log);
  });

  if (CASES.length === 0) {
    // Jest refuses an empty `it.each` table even in a skipped block.
    it.skip('[N-17][BLK-02] opt in with E2E_IOS_STRESS=1 and E2E_IOS_TARGET=device', () => undefined);
    return;
  }

  it.each(CASES)('[N-17][BLK-02][FLOW-09] iteration $iteration $kind ($mode): the next launch claims the crash', async ({ iteration, kind, mode }) => {
    const row: Record<string, unknown> = { iteration, kind, mode, at: new Date().toISOString() };
    try {
      await clearBundles();
      const crash = await startRun(CRASH[kind].run);
      row.crashBuild = IOS_SDK_LINE.exec(crash.banner.text)?.slice(1, 3).join(' ');
      row.crashNonce = crash.scenario.nonce;
      if (kind === 'jsfatal') {
        const sent = must(await log!.waitFor(bridgeLine('exception unhandled sent'), 30_000, crash.launched.index), 'the fatal stored', crash.start);
        must(await log!.waitFor(bridgeLine('exception unhandled completed'), 15_000, sent.index), 'the fatal completed', crash.start);
        must(await log!.waitFor(/BUGSEE_E2E exc app-handler fatal=true/, 10_000, sent.index), "RN's fatal handler", crash.start);
        await terminateIosApp();
        row.stop = 'terminateIosApp (SIGTERM)';
      } else {
        must(await log!.waitFor(new RegExp(`BUGSEE_E2E native crashing kind=${kind}`), 20_000, crash.start), 'the native crash call', crash.start);
        row.consoleEnded = await Promise.race([
          crash.launch!.ended.then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000)),
        ]);
        row.signal = deviceTerminationSignal(crash.launch!.output);
      }
      const queueAfterCrash = await crashQueue();
      row.queueAfterCrash = queueAfterCrash;
      row.buildRecordAfterCrash = holdsBuildRecord(queueAfterCrash);
      row.prefsAfterCrash = await prefsState();
      if (mode === 'wipe') {
        // Retried until the preferences are really gone before the relaunch:
        // a claim with the domain still there is the keep path, not BLK-02.
        const wipes: unknown[] = [];
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          wipes.push(await wipeAllButPreferences());
          if (!(await prefsState()).exists) {
            break;
          }
        }
        row.wipe = wipes;
      }
      const queueBeforeRelaunch = await crashQueue();
      row.queueBeforeRelaunch = queueBeforeRelaunch;
      row.prefsBeforeRelaunch = await prefsState();
      if (mode === 'wipe') {
        // The precondition the harness can see: no preferences plist in the
        // container before the relaunch (cocoa-191b E1's "domain evidently
        // lost"). cfprefsd's cache is not visible from here.
        expect((row.prefsBeforeRelaunch as { exists: boolean }).exists).toBe(false);
      }

      const observe = await startRun(CRASH[kind].observe);
      row.observeBuild = IOS_SDK_LINE.exec(observe.banner.text)?.slice(1, 3).join(' ');
      await awaitBundles(1, kind === 'jsfatal' ? 60_000 : 90_000);
      // A late second bundle would be a duplicate: give it time to show.
      await new Promise(resolve => setTimeout(resolve, 5_000));
      const bundles = await awaitBundles(1, 1_000);
      row.bundles = bundles.map(bundle => `${String(bundle.request.type)}:${bundle.file}`);
      row.queueAfterRelaunch = await crashQueue();
      row.prefsAfterRelaunch = await prefsState();
      row.dropped = log!.all(DROPPED, crash.start).map(line => line.text.trim());
      row.handler = log!.all(/BugseeRN.*report handler|BUGSEE_E2E native recover/, observe.start).map(line => line.text.trim().slice(0, 160)).slice(0, 6);
      row.leftBundles = await listBundles();

      const crashes = bundles.filter(bundle => bundle.request.type === 'crash');
      row.summary = {
        reportBeforeRelaunch: holdsReport(queueBeforeRelaunch),
        domainLost: mode === 'wipe' ? !(row.prefsBeforeRelaunch as { exists: boolean }).exists : undefined,
        claimed: holdsReport(queueBeforeRelaunch) && !holdsReport(row.queueAfterRelaunch as string[]) && crashes.length === 1,
        crashBundles: crashes.length,
        dropped: (row.dropped as string[]).length > 0,
      };
      report(`iteration ${iteration} ${kind} ${mode}`, row.summary);

      // The precondition: the crash really left a report to claim.
      expect(holdsReport(queueBeforeRelaunch)).toBe(true);
      expect(row.dropped).toEqual([]);
      expect(holdsReport(row.queueAfterRelaunch as string[])).toBe(false);
      expect(crashes).toHaveLength(1);
    } catch (error) {
      row.error = String(error).slice(0, 2000);
      throw error;
    } finally {
      record(row);
    }
  });
});
