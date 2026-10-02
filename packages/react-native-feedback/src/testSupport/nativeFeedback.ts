/**
 * Stand-in for the feedback TurboModule. Tests drive the facade through this.
 */

interface MessagesEvent {
  messagesJson: string;
}

interface SentEvent {
  message: string;
}

const receivedListeners = new Set<(event: MessagesEvent) => void>();
const sentListeners = new Set<(event: SentEvent) => void>();
let receivedSubscribeCalls = 0;
let sentSubscribeCalls = 0;

export const native = {
  showFeedbackUI: jest.fn<void, []>(),
  setGreeting: jest.fn<void, [string | null]>(),
  setListenerEnabled: jest.fn<void, [boolean]>(),
  setAppearanceColor: jest.fn<void, [string, number, number, number, number]>(),

  onNewMessagesReceived(listener: (event: MessagesEvent) => void) {
    receivedSubscribeCalls += 1;
    receivedListeners.add(listener);
    return {
      remove: () => {
        receivedListeners.delete(listener);
      },
    };
  },

  onNewMessageSent(listener: (event: SentEvent) => void) {
    sentSubscribeCalls += 1;
    sentListeners.add(listener);
    return {
      remove: () => {
        sentListeners.delete(listener);
      },
    };
  },

  emitReceived(messagesJson: string): void {
    for (const listener of [...receivedListeners]) {
      listener({ messagesJson });
    }
  },

  emitSent(message: string): void {
    for (const listener of [...sentListeners]) {
      listener({ message });
    }
  },

  receivedSubscribeCalls(): number {
    return receivedSubscribeCalls;
  },

  sentSubscribeCalls(): number {
    return sentSubscribeCalls;
  },

  reset(): void {
    native.showFeedbackUI.mockClear();
    native.setGreeting.mockClear();
    native.setListenerEnabled.mockClear();
    native.setAppearanceColor.mockClear();
    receivedListeners.clear();
    sentListeners.clear();
    receivedSubscribeCalls = 0;
    sentSubscribeCalls = 0;
  },
};

export const nativeMock = { __esModule: true, default: native };
