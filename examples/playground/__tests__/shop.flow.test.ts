import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { NetworkFilterEvent } from '@bugsee/react-native';
import { cart, addToCart, finishFlow, pay, resetCart, SHOP_NETWORK_FILTER, startCheckoutFlow } from '../src/shop/flow';

const bugsee = Bugsee as unknown as Record<string, jest.Mock>;
const event = (body?: string | null): NetworkFilterEvent => ({
  id: '1',
  url: 'https://x',
  method: 'POST',
  body,
  mechanism: null,
  type: null,
  websocketEvent: null,
  responseCode: 200,
});

beforeEach(() => {
  jest.clearAllMocks();
  finishFlow(SpanStatus.OK);
  resetCart();
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as never;
});

test('filter redacts the password and keeps the rest of the event', () => {
  const out = SHOP_NETWORK_FILTER(event('{"email":"a@b.co","password":"hunter2"}')) as NetworkFilterEvent;
  expect(out.body).toContain('"password":"***"');
  expect(out.body).toContain('"email":"a@b.co"');
  expect(out.body).not.toContain('hunter2');
  expect(out.url).toBe('https://x');
  expect(Object.keys(out)).toEqual(Object.keys(event('{}')));
});

test('filter returns events without a body unchanged', () => {
  const e = event(undefined);
  expect(SHOP_NETWORK_FILTER(e)).toBe(e);
  const n = event(null);
  expect(SHOP_NETWORK_FILTER(n)).toBe(n);
});

test('pay(declined) logs a handled exception with labels and domain', async () => {
  startCheckoutFlow();
  expect(await pay('declined', { total: 5 })).toBe('declined');
  expect(bugsee.logException).toHaveBeenCalledWith(expect.any(Error), {
    labels: ['checkout', 'payment'],
    domain: 'payment',
  });
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/status/402'));
});

test('pay(success) finishes the transaction with OK and resets the cart', async () => {
  startCheckoutFlow();
  const tx = bugsee.startTransaction.mock.results[0].value;
  addToCart(10);
  expect(await pay('success', cart)).toBe('ok');
  expect(tx.finish).toHaveBeenCalledWith(SpanStatus.OK);
  expect(cart).toEqual({ items: 0, total: 0 });
});

test('startCheckoutFlow twice starts one transaction', () => {
  startCheckoutFlow();
  startCheckoutFlow();
  expect(bugsee.startTransaction).toHaveBeenCalledTimes(1);
  expect(bugsee.startTransaction).toHaveBeenCalledWith('checkout', 'shop.flow');
});

test('addToCart updates the cart and the cart_items attribute', () => {
  addToCart(4.5);
  addToCart(1);
  expect(cart).toEqual({ items: 2, total: 5.5 });
  expect(bugsee.setAttribute).toHaveBeenLastCalledWith('cart_items', 2);
});

test('pay(bug) throws a TypeError from a timer', async () => {
  jest.useFakeTimers();
  try {
    startCheckoutFlow();
    await pay('bug', undefined);
    expect(() => jest.advanceTimersByTime(300)).toThrow(TypeError);
  } finally {
    jest.useRealTimers();
  }
});
