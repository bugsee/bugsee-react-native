/**
 * API-18 getActiveSpan, API-19 span setName/setDescription/finish(status):
 * what the report's `performance` capture says after each, on top of
 * apm.test.ts's start/attribute/finish.
 *
 * Scenario `cov-apm` (scenarios/coverage.ts):
 *   txn = startTransaction('txn-start-<n>', 'cov.flow'); getActiveSpan() === txn
 *   txn.setName('txn-renamed-<n>'); txn.setDescription('txn-desc-<n>')
 *   child = startSpan('cov.child', 'child-start-<n>'); getActiveSpan() === child
 *   child.setDescription('child-desc-<n>'); child.setStatus(Cancelled); child.finish()
 *   second = txn.startChildSpan('cov.second', 'second-<n>'); second.finish(DeadlineExceeded)
 *   txn.setStatus(Error); txn.finish(); getActiveSpan() is null; upload
 *
 * `setStatus` followed by a no-argument `finish()` ends OK on both SDKs --
 * the documented meaning of the no-arg finish (span.ts) -- so a status set
 * that way is not in the report and is not asserted; `finish(status)` is.
 */
import { type CaptureTransaction, performanceTransactions } from '../../../scripts/performance-capture';
import { type PulledBundle } from './bundles';
import { ON_IOS, type Run, TARGET_NAME, awaitBundles, describeDevice, must, report, startRun } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog } from './scenario';

jest.setTimeout(5 * 60_000);

/**
 * Read through performanceTransactions: iOS writes the legacy layout, Android
 * 7.3.1 OTLP (bugsee-android #207), which it maps to the same fields
 * (`operation` = `bugsee.operation`, `status` = `bugsee.span.status`,
 * `description` = `bugsee.description`, the root first with no parent).
 */
type Transaction = CaptureTransaction;
type Span = NonNullable<CaptureTransaction['spans']>[number];

/**
 * span.ts documents `setName` as the native setName, "which sets the
 * operation on both SDKs". Android does; iOS 7.0.0-beta4 renames the
 * transaction instead and leaves the operation `cov.flow`.
 * Filed: https://github.com/bugsee/bugsee-cocoa/issues/199
 */
const itOperation = ON_IOS ? it.failing : it;

describeDevice(`span names, descriptions, statuses and the active span on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let nonce: string;
  let transaction: Transaction;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-span');
    run = await startRun('cov-apm');
    nonce = run.scenario.nonce;
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov apm finished nonce=${nonce}`), 20_000, run.start),
      'the transaction finishing',
      run.start,
    );
    const bundles: PulledBundle[] = await awaitBundles(1);
    const bundle = bundles.find(b => b.request.summary === `cov-apm-${nonce}`);
    expect(bundle).toBeDefined();
    const transactions = performanceTransactions(bundle!.captures.get('performance') ?? '{"transactions":[]}');
    const mine = transactions.filter(t => JSON.stringify(t).includes(`txn-desc-${nonce}`));
    report('transaction', mine);
    expect(mine).toHaveLength(1);
    transaction = mine[0]!;
  });

  afterAll(() => endRetainingSuite(log));

  function spanBy(predicate: (span: Span) => boolean): Span {
    const found = (transaction.spans ?? []).filter(predicate);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  const root = () => spanBy(span => span.parentSpanId === undefined);

  it('getActiveSpan() is the transaction, then the child, then null once finished', () => {
    expect(log!.all(new RegExp(`BUGSEE_E2E cov apm active nonce=${nonce} same=true`), run.start)).toHaveLength(1);
    expect(log!.all(new RegExp(`BUGSEE_E2E cov apm active-child nonce=${nonce} same=true`), run.start)).toHaveLength(1);
    expect(log!.all(new RegExp(`BUGSEE_E2E cov apm finished nonce=${nonce} active-after=null`), run.start)).toHaveLength(1);
  });

  it('setDescription on the transaction and on a child replaces the description', () => {
    expect(root().description).toBe(`txn-desc-${nonce}`);
    const child = spanBy(span => span.operation === 'cov.child');
    expect(child.description).toBe(`child-desc-${nonce}`);
    expect(child.parentSpanId).toBe(root().spanId);
  });

  it('finish(status) ends the span with that status', () => {
    const second = spanBy(span => span.operation === 'cov.second');
    expect(second.description).toBe(`second-${nonce}`);
    expect(second.status).toBe('DEADLINE_EXCEEDED');
    expect(second.parentSpanId).toBe(root().spanId);
  });

  itOperation('setName sets the operation, as span.ts documents', () => {
    expect(root().operation).toBe(`txn-renamed-${nonce}`);
    expect(transaction.operation).toBe(`txn-renamed-${nonce}`);
  });
});
