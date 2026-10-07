/**
 * Campaign N-19: the STAGING lane's device half (plan 1.10), online.
 *
 * Two ways to run it, and only these:
 *
 *   E2E_STAGING=1        the STAGING lane: a real staging token, endpoint
 *                        exactly https://apidev.bugsee.com (the N-30 guard
 *                        checks every launch), the network ON. Every report
 *                        must be delivered: `AfterReportUploaded`, and nothing
 *                        left on the device. The controller then finds each
 *                        one on staging through the staging Bugsee MCP by the
 *                        nonce in its text (`campaign <nonce> ...`), from the
 *                        `STAGING-EVIDENCE` lines this suite prints.
 *   E2E_STAGING_DRYRUN=1 the same flows offline, against the dead endpoint
 *                        with the network ON: everything up to the upload,
 *                        which must then be attempted and fail
 *                        (`ReportUploadFailed[WithFutureRetry]`) with the
 *                        report kept. Proves the scenarios and this suite
 *                        without a token.
 *
 * Cases (the ids the controller verifies on staging):
 *   [S-1][S-2]  JS fatal, recovered at the relaunch and uploaded (Release builds
 *               for symbolication: S-1 Android, S-2 iPhone).
 *   [S-1][S-2]  a handled JS exception, uploaded at once.
 *   [S-3]       Android NDK crash (`crashNative('segv')`), [S-5] iPhone signal crash.
 *   [S-4]       Android Java crash (`testNativeCrash()`), [S-5] iPhone NSException.
 *   [S-6]       online acceptance: one `upload()` carrying attributes, user id,
 *               console, network, event, trace, severity and labels;
 *               BeforeReportUploaded then AfterReportUploaded (EVT-13, EVT-14).
 *   [S-7]       Android offline -> online: filed in airplane mode it stays on
 *               the device; with the network back it is delivered exactly once
 *               (FLOW-35); and a network cut right after the upload starts is
 *               retried and still delivered once (FLOW-36, staging only). The
 *               iPhone's half is the operator session M-C2.
 *   [M-C1]      the feedback chat round trip (FLOW-50, FB-03a/b/c), operator
 *               steps, staging only (`E2E_IOS_OPERATOR=1` / `E2E_ANDROID_OPERATOR=1`).
 *
 * The simulator has no crash reporter and compiles `logException` out: its
 * crash and handled cases skip. Every pulled bundle is scanned for tokens and
 * deleted afterwards (removePulledBundles, N-29).
 */
import { airplane } from './bundles';
import { iosTarget } from './device';
import {
  CAMPAIGN_MODE,
  RELEASE,
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  clearBundles,
  describeDevice,
  listBundles,
  must,
  report,
  startDeviceLog,
  startRun,
  stopApp,
} from './harness';
import { endRetainingSuite } from './observe';
import { ensureOnline } from './online';
import { operatorEnabled, operatorPrompt, operatorStep } from './operator';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(15 * 60_000);

const STAGING = CAMPAIGN_MODE === 'staging';
const DRY_RUN = !STAGING && process.env.E2E_STAGING_DRYRUN === '1';
const ENABLED = STAGING || DRY_RUN;
const describeStaging = ENABLED ? describeDevice : describe.skip;

const ON_IPHONE = ON_IOS && iosTarget() === 'device';
const CAN_CRASH = ON_ANDROID || ON_IPHONE;
const itCrash = CAN_CRASH ? it : it.skip;
const itAndroid = ON_ANDROID ? it : it.skip;
/**
 * A Java crash from `testNativeCrash()` needs a Release build on Android: in
 * Debug, React Native's red box catches it and the process lives on (seen in
 * the dry run on the WOD_LX1, twice). The STAGING lane runs Release anyway.
 */
const itAndroidRelease = ON_ANDROID && RELEASE ? it : it.skip;
const itIphone = ON_IPHONE ? it : it.skip;
const itStagingAndroid = STAGING && ON_ANDROID ? it : it.skip;
const OPERATOR = operatorEnabled(ON_IOS ? 'ios' : 'android');
const itFeedback = STAGING && OPERATOR ? it : it.skip;

/** What the upload of a report must end in, in this mode. */
const DELIVERED = STAGING ? /^AfterReportUploaded$/ : /^(ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/;
const OUTCOME = /^(AfterReportUploaded|ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/;

interface StgEvent {
  readonly name: string;
  readonly id: string;
  readonly line: LogLine;
}

describeStaging(`staging flows on ${TARGET_NAME} (N-19, ${STAGING ? 'STAGING' : 'dry run against the dead endpoint'})`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await startDeviceLog('N-19', 'N-19');
    await ensureOnline();
    await clearBundles();
  });

  afterAll(() => endRetainingSuite(log));

  function events(nonce: string, from: number): StgEvent[] {
    return log!.all(new RegExp(`BUGSEE_E2E stg event name=(\\S+) id=(\\S+) nonce=${nonce}`), from).map(line => {
      const [, name, id] = /name=(\S+) id=(\S+)/.exec(line.text)!;
      return { name: name!, id: id!, line };
    });
  }

  /**
   * Waits until a report of `run` (or of `earlier`, a crash run whose report
   * may be sent before it dies: Android's Java crash) has the outcome this
   * mode expects (`DELIVERED`: staging AfterReportUploaded, dry run a
   * failure), then returns every outcome so far, from both. A failed attempt
   * before a later delivery does not end the wait. With `after` (a log
   * index), only outcomes logged at or after it count.
   */
  async function awaitOutcomes(run: Run, timeoutMs: number, earlier?: Run, after = 0): Promise<StgEvent[]> {
    const runs = earlier === undefined ? [run] : [earlier, run];
    const from = runs[0]!.start;
    const deadline = Date.now() + timeoutMs;
    const outcomes = (): StgEvent[] =>
      runs
        .flatMap(r => events(r.scenario.nonce, from))
        .filter(event => OUTCOME.test(event.name) && event.line.index >= after);
    const delivered = (): StgEvent[] => outcomes().filter(event => DELIVERED.test(event.name));
    while (delivered().length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (delivered().length === 0) {
      must(undefined, `an upload outcome for a report of ${runs.map(r => r.scenario.scenario).join(' or ')}`, from);
    }
    // Let a duplicate delivery show itself before counting.
    await new Promise(resolve => setTimeout(resolve, 10_000));
    return outcomes();
  }

  function evidence(id: string, run: Run, extra: Record<string, unknown>): void {
    const launched = log!.all(new RegExp(`BUGSEE_E2E stg launched scenario=\\S+ debug-ids=(\\S*) nonce=${run.scenario.nonce}`), run.start)[0];
    report('STAGING-EVIDENCE', {
      id,
      mode: STAGING ? 'staging' : 'dry-run',
      target: TARGET_NAME,
      nonce: run.scenario.nonce,
      // In the report text (JS) or in the attribute `campaign` (native crashes).
      search: `campaign ${run.scenario.nonce}`,
      debugIds: launched === undefined ? undefined : /debug-ids=(\S*)/.exec(launched.text)?.[1],
      ...extra,
    });
  }

  /**
   * The mode's outcome happened; no report was delivered twice; and in
   * staging nothing is left behind (a report that only ever failed would
   * still be on the device), in the dry run the reports are kept.
   */
  async function assertDelivered(outcomes: readonly StgEvent[]): Promise<void> {
    expect(outcomes.filter(outcome => DELIVERED.test(outcome.name)).length).toBeGreaterThan(0);
    // Delivered once: no report id is reported uploaded twice.
    const delivered = outcomes.filter(outcome => outcome.name === 'AfterReportUploaded').map(outcome => outcome.id);
    expect(new Set(delivered).size).toBe(delivered.length);
    const left = await listBundles();
    report('bundles left on the device', left);
    if (STAGING) {
      expect(left).toEqual([]);
    } else {
      expect(left.length).toBeGreaterThan(0);
    }
  }

  async function crashThenObserve(scenario: string, id: string, died: (run: Run) => Promise<void>): Promise<void> {
    await clearBundles();
    const crash = await startRun(scenario);
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg crashing kind=\\S+ .*nonce=${crash.scenario.nonce}`), 20_000, crash.start), 'the crash call', crash.start);
    await died(crash);
    await stopApp();
    const observe = await startRun('stg-observe');
    const outcomes = await awaitOutcomes(observe, 180_000, crash);
    const recovered = log!.all(new RegExp(`BUGSEE_E2E stg recovered (before|after) type=crash id=\\S+ nonce=${observe.scenario.nonce}`), observe.start).map(line => line.text.trim());
    evidence(id, crash, { observeNonce: observe.scenario.nonce, outcomes: outcomes.map(o => `${o.name}:${o.id}`), recovered });
    await assertDelivered(outcomes);
  }

  const settle = (ms: number) => async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms));
  };

  itCrash('[N-19][S-1][S-2][FLOW-25] a JS fatal is recovered and uploaded', async () => {
    await crashThenObserve('stg-js-fatal', ON_IOS ? 'S-2' : 'S-1', settle(10_000));
  });

  itCrash('[N-19][S-1][S-2] a handled JS exception is uploaded at once', async () => {
    await clearBundles();
    const run = await startRun('stg-js-handled');
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg handled-sent .*nonce=${run.scenario.nonce}`), 20_000, run.start), 'the handled report sent', run.start);
    const outcomes = await awaitOutcomes(run, 120_000);
    evidence(ON_IOS ? 'S-2' : 'S-1', run, { kind: 'handled', outcomes: outcomes.map(o => `${o.name}:${o.id}`) });
    await assertDelivered(outcomes);
  });

  itAndroid('[N-19][S-3][FLOW-26] an NDK crash is recovered and uploaded', async () => {
    await crashThenObserve('stg-native-segv', 'S-3', settle(5_000));
  });

  itAndroidRelease('[N-19][S-4][FLOW-26] a Java crash is recovered and uploaded', async () => {
    await crashThenObserve('stg-native-exception', 'S-4', settle(5_000));
  });

  itIphone('[N-19][S-5][FLOW-26] an iPhone signal crash is recovered and uploaded', async () => {
    await crashThenObserve('stg-native-segv', 'S-5', settle(5_000));
  });

  itIphone('[N-19][S-5][FLOW-26] an iPhone NSException crash is recovered and uploaded', async () => {
    await crashThenObserve('stg-native-exception', 'S-5', settle(5_000));
  });

  it('[N-19][S-6][EVT-13][EVT-14] online acceptance: one upload with every capture, BeforeReportUploaded then its outcome', async () => {
    await clearBundles();
    const run = await startRun('stg-upload');
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg uploaded summary=.* nonce=${run.scenario.nonce}`), 30_000, run.start), 'the upload', run.start);
    const outcomes = await awaitOutcomes(run, 120_000);
    const all = events(run.scenario.nonce, run.start);
    const before = all.filter(event => event.name === 'BeforeReportUploaded');
    evidence('S-6', run, { outcomes: outcomes.map(o => `${o.name}:${o.id}`), before: before.map(event => event.id) });
    if (STAGING) {
      // EVT-13: the upload announced before it was delivered, for the same report.
      expect(before.map(event => event.id)).toEqual(expect.arrayContaining(outcomes.map(outcome => outcome.id)));
      expect(before[0]!.line.index).toBeLessThan(outcomes[0]!.line.index);
    }
    await assertDelivered(outcomes);
  });

  itAndroid('[N-19][S-7][FLOW-35] filed offline it stays on the device; with the network back it is delivered once', async () => {
    await clearBundles();
    await airplane(true);
    let run: Run;
    let back: number;
    try {
      run = await startRun('stg-offline-upload');
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg uploaded summary=.* nonce=${run.scenario.nonce}`), 30_000, run.start), 'the offline upload', run.start);
      await new Promise(resolve => setTimeout(resolve, 15_000));
      const offline = events(run.scenario.nonce, run.start).filter(event => event.name === 'AfterReportUploaded');
      const kept = await listBundles();
      report('offline', { delivered: offline.map(event => event.id), kept });
      expect(offline).toEqual([]);
      expect(kept.length).toBeGreaterThan(0);
    } finally {
      // Marked before the network comes back: a delivery while ensureOnline()
      // waits for the network to settle is already "back online".
      back = log!.mark();
      await ensureOnline();
    }
    const afterBack = await awaitOutcomes(run, 240_000, undefined, back);
    evidence('S-7', run, { outcomes: afterBack.map(o => `${o.name}:${o.id}`) });
    expect(afterBack.length).toBeGreaterThan(0);
    await assertDelivered(afterBack);
  });

  itStagingAndroid('[N-19][S-7][FLOW-36] a network cut right after the upload starts is retried and delivered once', async () => {
    await clearBundles();
    const run = await startRun('stg-offline-upload');
    const started = must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E stg event name=BeforeReportUploaded id=\\S+ nonce=${run.scenario.nonce}`), 60_000, run.start),
      'the upload starting',
      run.start,
    );
    let back: number;
    try {
      await airplane(true);
      await new Promise(resolve => setTimeout(resolve, 10_000));
      // The cut must really have interrupted the upload: nothing delivered
      // yet and the report still on the device. A first shot that finished
      // before airplane mode took effect is not FLOW-36 (cursor P2).
      const early = events(run.scenario.nonce, run.start).filter(event => event.name === 'AfterReportUploaded');
      const kept = await listBundles();
      report('after the cut', { delivered: early.map(event => event.id), kept });
      expect(early).toEqual([]);
      expect(kept.length).toBeGreaterThan(0);
    } finally {
      back = log!.mark();
      await ensureOnline();
    }
    const afterBack = await awaitOutcomes(run, 300_000, undefined, back);
    evidence('S-7', run, { kind: 'mid-upload cut', cutAfter: started.text.trim(), outcomes: afterBack.map(o => `${o.name}:${o.id}`) });
    // Delivered after the network came back, exactly once over the whole run.
    expect(afterBack.filter(outcome => outcome.name === 'AfterReportUploaded')).toHaveLength(1);
    expect(events(run.scenario.nonce, run.start).filter(event => event.name === 'AfterReportUploaded')).toHaveLength(1);
    expect(await listBundles()).toEqual([]);
  });

  itFeedback('[N-19][M-C1][FLOW-50][FB-03a][FB-03b][FB-03c] feedback round trip: sent, one reply received, none after setListener(null)', async () => {
    const run = await startRun('stg-feedback-chat');
    const nonce = run.scenario.nonce;
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg feedback shown nonce=${nonce}`), 20_000, run.start), 'the chat shown', run.start);
    const device = ON_IOS ? 'iPhone XS' : 'Android WOD_LX1';
    const sent = await operatorStep(
      { id: 'M-C1', device, timeoutMs: 180_000, instructions: [`In the feedback chat, type: campaign ${nonce}`, 'Tap Send.'] },
      async () => log!.all(new RegExp(`BUGSEE_E2E stg feedback sent message=.*${nonce}.* nonce=${nonce}`), run.start)[0],
    );
    const received = await operatorStep(
      { id: 'M-C1', device, timeoutMs: 600_000, instructions: [`On the staging dashboard, reply to "campaign ${nonce}" with: reply ${nonce}`] },
      async () => log!.all(new RegExp(`BUGSEE_E2E stg feedback received count=\\d+ nonce=${nonce}`), run.start)[0],
    );
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg feedback listener-cleared nonce=${nonce}`), 10_000, received.index), 'setListener(null)', run.start);
    operatorPrompt({ id: 'M-C1', device, timeoutMs: 180_000, instructions: [`On the staging dashboard, reply once more with: second ${nonce}`, 'Then wait; the harness checks that the app is not told.'] });
    await new Promise(resolve => setTimeout(resolve, 180_000));
    const receivedAll = log!.all(new RegExp(`BUGSEE_E2E stg feedback received count=\\d+ nonce=${nonce}`), run.start);
    evidence('M-C1', run, { sent: sent.text.trim(), received: receivedAll.map(line => line.text.trim()) });
    expect(receivedAll).toHaveLength(1);
  });
});
