/**
 * Issue #146: a JS reload releases the span handles, and the transaction the
 * first runtime left open must end Cancelled in the SDK instead of staying
 * open for the life of the process.
 *
 * Scenario `cov-span-reload` (scenarios/coverage.ts): runtime one starts a
 * transaction with an open child, sets an attribute and calls
 * DevSettings.reload(); runtime two sees the attribute and uploads. The
 * report's performance capture is what reads back. Debug builds only: a
 * release build has no DevSettings.reload().
 */
import { performanceTransactions } from '../../../scripts/performance-capture';
import { type PulledBundle } from './bundles';
import { type Run, TARGET_NAME, awaitBundles, debugOnly, describeDevice, must, report, startRun } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog } from './scenario';

jest.setTimeout(5 * 60_000);

describeDevice(`a JS reload cancels the transaction it left open on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let nonce: string;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-span-reload');
    run = await startRun('cov-span-reload');
    nonce = run.scenario.nonce;
  });

  afterAll(() => endRetainingSuite(log));

  debugOnly(it, 'DevSettings.reload() exists only in a debug build')(
    'the open transaction and its open child end Cancelled',
    async () => {
      must(
        await log!.waitFor(new RegExp(`BUGSEE_E2E cov span-reload second nonce=${nonce}`), 60_000, run.start),
        'the second runtime after the reload',
        run.start,
      );
      must(
        await log!.waitFor(new RegExp(`BUGSEE_E2E cov span-reload uploaded nonce=${nonce}`), 20_000, run.start),
        'the upload',
        run.start,
      );
      const bundles: PulledBundle[] = await awaitBundles(1);
      const bundle = bundles.find(b => b.request.summary === `cov-span-reload-${nonce}`);
      expect(bundle).toBeDefined();
      const transactions = performanceTransactions(bundle!.captures.get('performance') ?? '{"transactions":[]}');
      const mine = transactions.filter(t => JSON.stringify(t).includes(`child-reload-${nonce}`));
      report('transaction', mine);
      expect(mine).toHaveLength(1);
      const spans = mine[0]!.spans ?? [];
      const root = spans.find(span => span.parentSpanId === undefined);
      const child = spans.find(span => span.operation === 'cov.reload.child');
      expect(root?.status).toBe('CANCELLED');
      expect(child?.status).toBe('CANCELLED');
    },
  );
});
