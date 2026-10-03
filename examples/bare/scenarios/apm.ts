/**
 * Phase 10: a notification and a transaction, after launch.
 *
 * The notification title and the transaction name both carry the nonce.
 * The child span is started on the same thread as the transaction, which
 * is what makes it a child: the SDK's active span is thread-local. The
 * line is the device test's contract; the report's performance capture
 * and the notification relay are what the test reads back.
 */
import Bugsee, { IssueSeverity } from '@bugsee/react-native';

export const APM_SCENARIOS = ['apm'] as const;

export type ApmScenario = (typeof APM_SCENARIOS)[number];

export function isApmScenario(name: string): name is ApmScenario {
  return (APM_SCENARIOS as readonly string[]).includes(name);
}

export function runApmScenario(nonce: string): void {
  const title = `notify-${nonce}`;
  const transactionName = `txn-${nonce}`;
  Bugsee.notify(title, `body-${nonce}`, IssueSeverity.High, { nonce }, true);
  const transaction = Bugsee.startTransaction(transactionName, 'user.flow', { nonce });
  const span = Bugsee.startSpan('db.query', `span-${nonce}`);
  // A value the transaction's own attributes do not carry, so the report
  // can only have it if this setter reached the SDK before finish.
  span.setAttribute('nonce', `attr-${nonce}`);
  span.finish();
  transaction.finish();
  console.log(`BUGSEE_E2E apm notify=${title} txn=${transactionName}`);
  Bugsee.upload(`apm-${nonce}`, '');
}
