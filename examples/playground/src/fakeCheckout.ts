import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { BugseeTransaction } from '@bugsee/react-native';

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STEPS: [name: string, ms: number][] = [['validate', 200], ['payment', 700], ['confirm', 300]];

/** A transaction of about 1.2 s with three child spans. */
export async function runFakeCheckout(sleep: (ms: number) => Promise<void> = realSleep): Promise<BugseeTransaction> {
  const tx = Bugsee.startTransaction('checkout', 'ui.action', { cart_items: 3 });
  for (const [name, ms] of STEPS) {
    const span = tx.startChildSpan(name);
    if (name === 'payment') span.setAttribute('provider', 'demo');
    await sleep(ms);
    span.finish(SpanStatus.OK);
  }
  tx.finish(SpanStatus.OK);
  return tx;
}
