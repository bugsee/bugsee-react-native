import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { BugseeSpan, BugseeTransaction, NetworkFilter } from '@bugsee/react-native';
import { DEMO, postJson } from '../demoApi';
import { afterTap } from '../ui/afterTap';

export type ShopStep = 'sign-in' | 'products' | 'detail' | 'checkout';
export type PayOutcome = 'success' | 'declined' | 'bug';

let tx: BugseeTransaction | null = null;

/** The cart lives at module level so every shop screen shares it. */
export const cart = { items: 0, total: 0 };

export function addToCart(price: number): void {
  cart.items += 1;
  cart.total = Math.round((cart.total + price) * 100) / 100;
  Bugsee.setAttribute('cart_items', cart.items);
}

export function resetCart(): void {
  cart.items = 0;
  cart.total = 0;
}

export function startCheckoutFlow(): void {
  if (tx) {
    return;
  }
  tx = Bugsee.startTransaction('checkout', 'shop.flow');
}

export function stepSpan(name: ShopStep): BugseeSpan {
  startCheckoutFlow();
  return tx!.startChildSpan('shop.step', name);
}

export function finishFlow(status: SpanStatus): void {
  if (!tx) {
    return;
  }
  tx.finish(status);
  tx = null;
}

const PASSWORD = /("password"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

/** Redacts `"password":"..."` inside a JSON string body; everything else is passed through. */
export const SHOP_NETWORK_FILTER: NetworkFilter = (event) => {
  if (typeof event.body !== 'string') {
    return event;
  }
  return { ...event, body: event.body.replace(PASSWORD, '$1"***"') };
};

export async function pay(
  outcome: PayOutcome,
  order: { total: number } | undefined,
): Promise<'ok' | 'declined'> {
  if (outcome === 'declined') {
    await fetch(DEMO.STATUS(402));
    Bugsee.logException(new Error('Payment declined'), {
      labels: ['checkout', 'payment'],
      domain: 'payment',
    });
    finishFlow(SpanStatus.Error);
    resetCart();
    return 'declined';
  }
  if (outcome === 'bug') {
    afterTap(() => {
      const current: { total: number } | undefined = undefined;
      String((current as unknown as { total: number }).total);
    });
    return 'ok';
  }
  await postJson(DEMO.ECHO, { total: order?.total ?? 0 });
  finishFlow(SpanStatus.OK);
  resetCart();
  return 'ok';
}
