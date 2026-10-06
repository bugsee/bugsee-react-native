/**
 * API-03 stop(), API-05 onStatusChange, API-41 deleteCollectedDataOnDevice,
 * FLOW-12 the lifecycle events beyond blackout.
 *
 * Scenario `cov-lifecycle` (scenarios/coverage.ts) subscribes to both
 * channels BEFORE launch(), then: upload -> waits for AfterReportAssembled
 * -> holds 15 s (this test lists the device in that window) -> stop() ->
 * getStatus() -> upload again (must be ignored) -> deleteCollectedDataOnDevice
 * (true) -> logs every event and status it saw.
 *
 * Markers:
 *   BUGSEE_E2E cov assembled nonce=<n> id=<report id>
 *   BUGSEE_E2E cov stopped nonce=<n> resolved=<b> status=<n>
 *   BUGSEE_E2E cov deleted nonce=<n> result=<b>
 *   BUGSEE_E2E cov summary nonce=<n> events=[...] statuses=[...]
 *
 * What "deleted" means is the SDKs' own: the rolling capture the next
 * report would be cut from (`capture/generations`), not reports already
 * assembled and waiting to be sent -- Android's deleteCaptureDataOnDisk
 * removes every generation's parts and keeps `bundles/`.
 */
import { type PulledBundle } from './bundles';
import { type Run, TARGET_NAME, awaitBundles, describeDevice, listBundles, must, report, startRun } from './harness';
import { beginRetainingSuite, captureGenerationFiles, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(6 * 60_000);

describeDevice(`stop, status, lifecycle events and data deletion on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let reportId: string;
  let bundlesWhileLaunched: string[];
  let partsWhileLaunched: string[];
  let partsAfterDelete: string[];
  let stopped: LogLine;
  let deleted: LogLine;
  let events: string[];
  let statuses: number[];
  let finalBundles: PulledBundle[];

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-lifecycle');
    run = await startRun('cov-lifecycle');
    const nonce = run.scenario.nonce;
    const assembled = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov assembled nonce=${nonce} id=(\\S+)`), 45_000, run.start),
      'the upload being assembled',
      run.start,
    );
    reportId = /id=(\S+)/.exec(assembled.text)![1]!;
    // Inside the scenario's 15 s hold: still launched, report on disk.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    bundlesWhileLaunched = await listBundles();
    partsWhileLaunched = await captureGenerationFiles();
    stopped = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov stopped nonce=${nonce} `), 45_000, assembled.index),
      'stop() settling',
      run.start,
    );
    deleted = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov deleted nonce=${nonce} `), 30_000, stopped.index),
      'deleteCollectedDataOnDevice settling',
      run.start,
    );
    partsAfterDelete = await captureGenerationFiles();
    const summary = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov summary nonce=${nonce} events=(\\[.*\\]) statuses=(\\[.*\\])`), 15_000, deleted.index),
      'the scenario summary',
      run.start,
    );
    const parsed = /events=(\[.*\]) statuses=(\[.*\])/.exec(summary.text)!;
    events = JSON.parse(parsed[1]!) as string[];
    statuses = JSON.parse(parsed[2]!) as number[];
    finalBundles = await awaitBundles(1, 5_000);
    report('report id', reportId);
    report('bundles while launched', bundlesWhileLaunched);
    report('capture parts while launched / after delete', { before: partsWhileLaunched.length, after: partsAfterDelete.length, left: partsAfterDelete.slice(0, 10) });
    report('events', events);
    report('statuses', statuses);
    report('stopped', stopped.text.trim());
    report('deleted', deleted.text.trim());
  });

  afterAll(() => endRetainingSuite(log));

  it('onStatusChange reports Launching, Launched, Stopping, Stopped in order', () => {
    expect(statuses).toEqual([1, 2, 3, 0]);
  });

  it('onLifecycleEvent sees launch, the report assembled with its id, then stop, in order', () => {
    const order = ['Launching', 'Launched', `BeforeReportAssembled:${reportId}`, `AfterReportAssembled:${reportId}`, 'Stopping', 'Stopped'];
    // Upload attempts (iOS's dead endpoint) may come in between; nothing else.
    const seen = events.filter(event => order.includes(event));
    expect(seen).toEqual(order);
    const other = events.filter(event => !order.includes(event)).map(event => event.split(':')[0]);
    expect(other.every(name => /^(BeforeReportUploaded|ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/.test(name!))).toBe(true);
  });

  it('the assembled report is the bundle on disk', () => {
    expect(bundlesWhileLaunched).toEqual([`${reportId}.bundle.zip`]);
  });

  it('stop() resolves true and getStatus() is then Stopped', () => {
    expect(stopped.text).toMatch(/resolved=true status=0\b/);
  });

  it('an upload after stop() files nothing', () => {
    const summaries = finalBundles.map(b => b.request.summary);
    expect(summaries).toEqual([`cov-lifecycle-${run.scenario.nonce}`]);
  });

  /**
   * Android 7.3.0: deleteCaptureDataOnDisk calls
   * `removeOtherGenerationsFilesSync(-1)`, which keeps every generation
   * numbered `>= -1` -- all of them (they are timestamps) -- and resolves
   * true. Seen on the WOD_LX1: 30 part files before, 69 after "deleted".
   * iOS 7.0.0-beta4: `clearGenerationsFolder` empties the legacy generations
   * folder, which the nextgen capture no longer writes; the parts under
   * `capture/generations` stay (simulator: 18 before, 66 after).
   */
  const itDelete = it.failing;
  itDelete('deleteCollectedDataOnDevice(true) after stop resolves true and removes the rolling capture', () => {
    expect(deleted.text).toMatch(/result=true\b/);
    expect(partsWhileLaunched.length).toBeGreaterThan(0);
    expect(partsAfterDelete).toEqual([]);
  });
});
