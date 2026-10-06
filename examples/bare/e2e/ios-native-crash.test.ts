/**
 * FLOW-10 / FLOW-09 on iOS: a real signal crash -- not an NSException -- is
 * recovered at the next launch, and the recovery handler's edits reach it.
 *
 * `crashNative('segv' | 'abort')` (examples/e2e-native, iOS since this
 * suite) stores through a bad pointer (EXC_BAD_ACCESS, SIGSEGV) or calls
 * abort() (SIGABRT). report-handler.test.ts's iOS recovery case uses
 * `testNativeCrash()`, an uncaught NSException; nothing before this proved a
 * signal with no Objective-C exception behind it reaches a report.
 *
 * Per kind:
 *   1. `native-crash-<kind>`: Launched, then `BUGSEE_E2E native crashing
 *      kind=<kind>`; devicectl's own last line names the signal the app
 *      died of, and the device's process list no longer has it.
 *   2. `native-crash-recover`: relaunch with a report handler that labels
 *      the recovered crash `['e2e-recovered', <nonce>]` from whichever phase
 *      the SDK offers it in (scenarios/native.ts).
 *   3. One `crash` bundle; its crash capture names the signal; its labels
 *      carry the relaunch's nonce.
 *
 * iPhone only: the simulator slice of the iOS SDK has no crash reporter
 * (report-handler.test.ts), so a crash there is never recovered.
 */
import { type PulledBundle, crashOf } from './bundles';
import { iosTarget } from './device';
import { ON_IOS, type Run, TARGET_NAME, awaitBundles, clearBundles, describeDevice, must, report, startRun } from './harness';
import { beginRetainingSuite, endRetainingSuite, iosCrashQueueFiles } from './observe';
import { type DeviceLog, devicePidsOfApp, deviceTerminationSignal } from './scenario';

jest.setTimeout(10 * 60_000);

const ON_IPHONE = ON_IOS && iosTarget() === 'device';
const describeIphone = ON_IPHONE ? describeDevice : describe.skip;

interface KindOutcome {
  readonly crash: Run;
  readonly signal: number | undefined;
  readonly stillRunning: boolean;
  readonly recover: Run;
  readonly crashes: readonly PulledBundle[];
  readonly handlerLines: readonly string[];
}

describeIphone(`a native signal crash recovered on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  const outcomes = new Map<string, KindOutcome>();

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-ios-crash');
  });

  afterAll(() => endRetainingSuite(log));

  async function crashAndRecover(kind: 'segv' | 'abort'): Promise<KindOutcome> {
    const cached = outcomes.get(kind);
    if (cached !== undefined) {
      return cached;
    }
    await clearBundles();
    const crash = await startRun(`native-crash-${kind}`);
    const pid = Number(/BareExample\[(\d+):/.exec(crash.banner.text)?.[1]);
    must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E native crashing kind=${kind}`), 20_000, crash.start),
      `the app calling crashNative('${kind}')`,
      crash.start,
    );
    // The console stream ends only when the process does.
    const ended = await Promise.race([
      crash.launch!.ended.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000)),
    ]);
    expect(ended).toBe(true);
    const signal = deviceTerminationSignal(crash.launch!.output);
    const stillRunning = (await devicePidsOfApp()).includes(pid);
    // What the crash left for the next launch to claim.
    report(`${kind} crash queue before the relaunch`, await iosCrashQueueFiles());
    report(`${kind} died`, { pid, signal, consoleEnd: crash.launch!.output.slice(-3).map(line => line.text.trim()) });

    const recover = await startRun('native-crash-recover');
    const bundles = await awaitBundles(1, 90_000);
    // Let a late handler edit land before reading the bundle again.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const crashes = (await awaitBundles(1, 1_000)).filter(b => b.request.type === 'crash');
    const handlerLines = log!.all(new RegExp(`BUGSEE_E2E native recover .*nonce=${recover.scenario.nonce}`), recover.start).map(l => l.text.trim());
    report(`${kind} bundles`, bundles.map(b => ({ file: b.file, type: b.request.type, labels: b.request.labels })));
    report(`${kind} handler`, handlerLines);
    for (const bundle of crashes) {
      report(`${kind} crash capture`, JSON.stringify(crashOf(bundle) ?? {}).slice(0, 1500));
    }
    const outcome = { crash, signal, stillRunning, recover, crashes, handlerLines };
    outcomes.set(kind, outcome);
    return outcome;
  }

  const SIGNALS = { segv: { number: 11, name: 'SIGSEGV' }, abort: { number: 6, name: 'SIGABRT' } } as const;

  function assertRecovered(outcome: KindOutcome, name: string): void {
    expect(outcome.crashes).toHaveLength(1);
    const text = JSON.stringify(crashOf(outcome.crashes[0]!));
    expect(text).toContain(name);
    // A signal, not an Objective-C exception: no NSException behind it.
    expect(text).not.toContain('NSGenericException');
  }

  function assertLabelled(outcome: KindOutcome): void {
    expect(outcome.handlerLines.some(line => / labels-set /.test(line))).toBe(true);
    expect(outcome.crashes).toHaveLength(1);
    expect(outcome.crashes[0]!.request.labels).toEqual(expect.arrayContaining(['e2e-recovered', outcome.recover.scenario.nonce]));
  }

  it("crashNative('segv') kills the app with SIGSEGV", async () => {
    const outcome = await crashAndRecover('segv');
    expect(outcome.signal).toBe(SIGNALS.segv.number);
    expect(outcome.stillRunning).toBe(false);
  });

  it('the next launch recovers one crash report naming SIGSEGV', async () => {
    assertRecovered(await crashAndRecover('segv'), SIGNALS.segv.name);
  });

  it("the recovery handler's labels reach the segv crash report", async () => {
    assertLabelled(await crashAndRecover('segv'));
  });

  it("crashNative('abort') kills the app with SIGABRT", async () => {
    const outcome = await crashAndRecover('abort');
    expect(outcome.signal).toBe(SIGNALS.abort.number);
    expect(outcome.stillRunning).toBe(false);
  });

  // iOS 7.0.0-beta4 on the XS loses a SIGABRT now and then: in 3 of 16
  // abort runs on 2026-10-06 the next launch claimed nothing and the handler
  // was never called (SIGSEGV: 0 of 11). It is not the order of the kinds
  // (seen abort-first and segv-first) and not a stale queue (the container,
  // crash queue included, is wiped and asserted gone before each kind). An
  // intermittent loss cannot be pinned with it.failing without making the
  // pin flaky, so these two cases state the expected behaviour and go red
  // when the SDK drops the crash. Open in the beta-coverage report.
  it('the next launch recovers one crash report naming SIGABRT', async () => {
    assertRecovered(await crashAndRecover('abort'), SIGNALS.abort.name);
  });

  it("the recovery handler's labels reach the abort crash report", async () => {
    assertLabelled(await crashAndRecover('abort'));
  });
});
