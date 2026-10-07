/**
 * Campaign N-16 / BLK-30: the SDK's own traffic is not recorded as the app's,
 * proven with the network ON -- on Android too.
 *
 * network.test.ts (PR #58) asserts that no `/v2/sessions` request is in the
 * capture, but on Android it runs in airplane mode, where the SDK never sends
 * anything: there that assertion is vacuous. Here the network stays on (the
 * suite asserts airplane mode off and an active default network), the app
 * launches against the dead endpoint as always (`https://127.0.0.1:9`: the
 * SDK's requests are refused at once and the report stays on the device),
 * and scenario `net-own-traffic` (scenarios/flows.tsx):
 *
 *   1. files report 1 and waits for its upload outcome: an upload-failure
 *      event is the SDK's own request to the configured endpoint, attempted
 *      (the precondition: without it nothing below could fail);
 *   2. fetches the app's two requests on the same host: `rn-e2e-fetch/<n>`
 *      and the deliberately "bugsee"-named `bugseeNamedUrl(<n>)`;
 *   3. files report 2.
 *
 * Report 2's network capture must hold both of the app's requests (a
 * customer url with "bugsee" in it is recorded, with the network on) and no
 * other request to the configured endpoint: report 1's upload, and any
 * session request, were the SDK's own.
 *
 * Runs on A, S and X, Debug and `E2E_RELEASE=1` alike.
 */
import { type PulledBundle, DEAD_ENDPOINT, captureEvents } from './bundles';
import { bugseeNamedUrl } from '../endpoint';
import { type Run, TARGET_NAME, awaitBundles, clearBundles, describeDevice, must, report, startDeviceLog, startRun } from './harness';
import { endRetainingSuite } from './observe';
import { ensureOnline } from './online';
import { bundleBySummary } from './screen';
import { type DeviceLog } from './scenario';

jest.setTimeout(6 * 60_000);

const UPLOAD_FAILED = /^(ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/;

function urlOf(event: Record<string, unknown>): string {
  return typeof event.url === 'string' ? event.url : '';
}

describeDevice(`the SDK's own traffic with the network on, on ${TARGET_NAME} (N-16)`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let nonce: string;
  let firstOutcome: string;
  let second: PulledBundle;

  beforeAll(async () => {
    log = await startDeviceLog('N-16', 'N-16');
    // Network ON, stated and checked: this is the point of the suite.
    await ensureOnline();
    await clearBundles();
    run = await startRun('net-own-traffic');
    nonce = run.scenario.nonce;
    const first = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E flow own first outcome=(\\S+) nonce=${nonce}`), 90_000, run.start),
      "report 1's upload outcome",
      run.start,
    );
    firstOutcome = /outcome=(\S+)/.exec(first.text)![1]!;
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E flow own second outcome=\\S+ nonce=${nonce}`), 90_000, first.index),
      "report 2's upload outcome",
      run.start,
    );
    const bundles = await awaitBundles(2, 60_000);
    report('bundles', bundles.map(bundle => ({ file: bundle.file, summary: bundle.request.summary })));
    second = bundleBySummary(bundles, `own-2-${nonce}`);
    report('report 2 network urls', captureEvents(second, 'network').map(urlOf));
  });

  afterAll(() => endRetainingSuite(log));

  it('[N-16][BLK-30] precondition: the SDK sent its own request to the endpoint (report 1 upload attempted and failed)', () => {
    report('report 1 outcome', firstOutcome);
    expect(firstOutcome).toMatch(UPLOAD_FAILED);
  });

  it('[N-16][BLK-30] the app\'s own requests on that host are recorded, including the url that says "bugsee"', () => {
    const urls = captureEvents(second, 'network').map(urlOf);
    const named = bugseeNamedUrl(nonce);
    expect(new URL(named).pathname).toContain('bugsee');
    expect(urls.filter(url => url.includes(`rn-e2e-fetch/${nonce}`)).length).toBeGreaterThan(0);
    expect(urls.filter(url => url === named).length).toBeGreaterThan(0);
  });

  it("[N-16][BLK-30] nothing else to the configured endpoint is in the capture: the SDK's own traffic is not recorded", () => {
    const urls = captureEvents(second, 'network').map(urlOf);
    const own = urls.filter(
      url => url.startsWith(DEAD_ENDPOINT) && !url.includes(`rn-e2e-fetch/${nonce}`) && url !== bugseeNamedUrl(nonce),
    );
    report('requests to the endpoint that are not the app\'s', own);
    expect(own).toEqual([]);
  });
});
