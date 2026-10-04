import NativeBugseeFeedback from './NativeBugseeFeedback';

export { appearance } from './appearance';
export type { FeedbackAppearance, FeedbackAppearanceName } from './appearance';

/**
 * Callbacks for feedback traffic. Either method may be omitted. Both can
 * arrive on a background turn; the native side hops to the JS queue before
 * emitting.
 */
export interface FeedbackListener {
  onNewMessagesReceived?(messages: readonly string[]): void;
  onNewMessageSent?(message: string): void;
}

let current: FeedbackListener | null = null;
let receivedSub: { remove(): void } | null = null;
let sentSub: { remove(): void } | null = null;

function parseMessages(payload: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const messages: string[] = [];
  for (const item of parsed) {
    // A null or other non-string is one bad entry, not a reason to drop
    // the strings beside it. An array that contains no strings is not a
    // delivery: the native side omits nulls, and a batch of only nulls
    // arrives as an empty array.
    if (typeof item !== 'string') {
      continue;
    }
    messages.push(item);
  }
  if (messages.length === 0) {
    return undefined;
  }
  return messages;
}

function ensureSubscribed(): void {
  if (receivedSub !== null) {
    return;
  }
  receivedSub = NativeBugseeFeedback.onNewMessagesReceived((event) => {
    const listener = current?.onNewMessagesReceived;
    if (listener === undefined) {
      return;
    }
    const messages = parseMessages(event.messagesJson);
    if (messages === undefined) {
      return;
    }
    listener(messages);
  });
  sentSub = NativeBugseeFeedback.onNewMessageSent((event) => {
    const listener = current?.onNewMessageSent;
    if (listener === undefined || typeof event.message !== 'string') {
      return;
    }
    listener(event.message);
  });
}

function clearSubscribed(): void {
  receivedSub?.remove();
  sentSub?.remove();
  receivedSub = null;
  sentSub = null;
}

/** Presents the in-app feedback chat. No-op when the native extension is absent. */
export function showFeedbackUI(): void {
  NativeBugseeFeedback.showFeedbackUI();
}

/**
 * The greeting shown at the top of an empty conversation. `null` clears it.
 */
export function setGreeting(greeting: string | null): void {
  if (greeting !== null && typeof greeting !== 'string') {
    throw new TypeError(
      `setGreeting requires a string or null, got ${typeof greeting}`,
    );
  }
  NativeBugseeFeedback.setGreeting(greeting);
}

/**
 * Receives inbound and sent feedback messages. `null` clears the listener.
 * Replacing a listener does not subscribe a second time.
 */
export function setListener(listener: FeedbackListener | null): void {
  if (listener !== null && (typeof listener !== 'object' || Array.isArray(listener))) {
    const kind = Array.isArray(listener) ? 'array' : typeof listener;
    throw new TypeError(`setListener requires a listener object or null, got ${kind}`);
  }
  current = listener;
  if (listener === null) {
    clearSubscribed();
    NativeBugseeFeedback.setListenerEnabled(false);
    return;
  }
  ensureSubscribed();
  NativeBugseeFeedback.setListenerEnabled(true);
}
