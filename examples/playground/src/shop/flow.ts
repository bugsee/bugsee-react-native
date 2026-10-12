import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { BugseeSpan, BugseeTransaction, NetworkFilter } from '@bugsee/react-native';
import { DEMO, postJson } from '../demoApi';
import { afterTap } from '../ui/afterTap';

export type ShopStep = 'sign-in' | 'products' | 'detail' | 'checkout';
export type PayResult = 'ok' | 'declined' | 'bug';
export type PayOutcome = 'success' | 'declined' | 'bug';

let tx: BugseeTransaction | null = null;
let bugPending = false;

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
  bugPending = false;
  tx = Bugsee.startTransaction('checkout', 'shop.flow');
}

export function stepSpan(name: ShopStep): BugseeSpan {
  // Deliberate: after a flow finished (or was cancelled) the next step starts a fresh transaction.
  startCheckoutFlow();
  return tx!.startChildSpan('shop.step', name);
}

export function finishFlow(status: SpanStatus): void {
  if (!tx) {
    return;
  }
  tx.finish(status);
  tx = null;
  bugPending = false;
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
  step?: BugseeSpan,
): Promise<'ok' | 'declined' | 'bug'> {
  try {
    if (outcome === 'declined') {
      await fetch(DEMO.STATUS(402));
      Bugsee.logException(new Error('Payment declined'), {
        labels: ['checkout', 'payment'],
        domain: 'payment',
      });
      step?.finish(SpanStatus.Error);
      finishFlow(SpanStatus.Error);
      resetCart();
      return 'declined';
    }
    if (outcome === 'bug') {
      bugPending = true;
      afterTap(() => {
        // The crash is being attempted now; the pending window is over even if the app survives it.
        bugPending = false;
        const current: { total: number } | undefined = undefined;
        String((current as unknown as { total: number }).total);
      });
      step?.finish(SpanStatus.OK);
      return 'bug';
    }
    await postJson(DEMO.ECHO, { total: order?.total ?? 0 });
    step?.finish(SpanStatus.OK);
    finishFlow(SpanStatus.OK);
    resetCart();
    return 'ok';
  } catch (e) {
    step?.finish(SpanStatus.Error);
    finishFlow(SpanStatus.Error);
    throw e;
  }
}

/**
 * Called when the shop layout unmounts: cancels the open transaction and empties the cart.
 * A pending Bug outcome is the exception: the transaction stays open on purpose, so the
 * crash that is about to happen captures the whole flow.
 */
export function leaveShop(): void {
  resetCart();
  if (bugPending) {
    return;
  }
  finishFlow(SpanStatus.Cancelled);
}
