import Bugsee from '@bugsee/react-native';
import { runFakeCheckout } from '../src/fakeCheckout';

test('runs a checkout transaction with three child spans and finishes it last', async () => {
  const order: string[] = [];
  const tx = await (async () => {
    const t = await runFakeCheckout(async (ms) => { order.push(`sleep ${ms}`); });
    return t;
  })();
  const start = (Bugsee.startTransaction as jest.Mock);
  expect(start).toHaveBeenCalledWith('checkout', 'ui.action', { cart_items: 3 });
  const child = (tx.startChildSpan as jest.Mock);
  expect(child.mock.calls.map((c) => c[0])).toEqual(['validate', 'payment', 'confirm']);
  expect(order).toEqual(['sleep 200', 'sleep 700', 'sleep 300']);
  const txFinish = (tx.finish as jest.Mock).mock.invocationCallOrder[0];
  child.mock.results.forEach((r) => expect(r.value.finish.mock.invocationCallOrder[0]).toBeLessThan(txFinish));
});
