jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugseeFeedback', () => require('../testSupport/nativeFeedback').nativeMock);

import { Platform } from 'react-native';
import { clearAppearanceCache } from '../appearance';
import { setGreeting, setListener, showFeedbackUI } from '../index';
import { native } from '../testSupport/nativeFeedback';

beforeEach(() => {
  setListener(null);
  native.reset();
  clearAppearanceCache();
  (Platform as { OS: string }).OS = 'android';
});

describe('showFeedbackUI', () => {
  it('calls the native method once', () => {
    showFeedbackUI();
    expect(native.showFeedbackUI).toHaveBeenCalledTimes(1);
  });
});

describe('setGreeting', () => {
  it('forwards a string', () => {
    setGreeting('hello');
    expect(native.setGreeting).toHaveBeenCalledWith('hello');
  });

  it('forwards null to clear the greeting', () => {
    setGreeting(null);
    expect(native.setGreeting).toHaveBeenCalledWith(null);
  });

  it('forwards an empty string', () => {
    setGreeting('');
    expect(native.setGreeting).toHaveBeenCalledWith('');
  });

  it('rejects a non-string', () => {
    expect(() => setGreeting(1 as unknown as string)).toThrow(TypeError);
    expect(native.setGreeting).not.toHaveBeenCalled();
  });
});

describe('setListener', () => {
  it('subscribes once, then enables the native listener', () => {
    const listener = {
      onNewMessagesReceived: jest.fn(),
      onNewMessageSent: jest.fn(),
    };
    setListener(listener);
    expect(native.receivedSubscribeCalls()).toBe(1);
    expect(native.sentSubscribeCalls()).toBe(1);
    expect(native.setListenerEnabled).toHaveBeenCalledWith(true);
  });

  it('replacing the listener does not subscribe again', () => {
    setListener({ onNewMessageSent: jest.fn() });
    setListener({ onNewMessageSent: jest.fn() });
    expect(native.receivedSubscribeCalls()).toBe(1);
    expect(native.setListenerEnabled).toHaveBeenCalledTimes(2);
  });

  it('delivers received messages to the current listener', () => {
    const first = { onNewMessagesReceived: jest.fn() };
    const second = { onNewMessagesReceived: jest.fn() };
    setListener(first);
    setListener(second);
    native.emitReceived(JSON.stringify(['a', 'b']));
    expect(first.onNewMessagesReceived).not.toHaveBeenCalled();
    expect(second.onNewMessagesReceived).toHaveBeenCalledWith(['a', 'b']);
  });

  it('delivers a sent message', () => {
    const sent = jest.fn();
    setListener({ onNewMessageSent: sent });
    native.emitSent('hi');
    expect(sent).toHaveBeenCalledWith('hi');
  });

  it('skips a received payload that is not JSON array', () => {
    const received = jest.fn();
    setListener({ onNewMessagesReceived: received });
    native.emitReceived('not json');
    native.emitReceived(JSON.stringify({ a: 1 }));
    expect(received).not.toHaveBeenCalled();
  });

  it('delivers the strings from a batch that also contains nulls', () => {
    const received = jest.fn();
    setListener({ onNewMessagesReceived: received });
    native.emitReceived(JSON.stringify([null, 'c', 1, 'd']));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(['c', 'd']);
  });

  it('delivers nothing when every entry is null', () => {
    const received = jest.fn();
    setListener({ onNewMessagesReceived: received });
    native.emitReceived(JSON.stringify([null, null]));
    native.emitReceived('[]');
    expect(received).not.toHaveBeenCalled();
  });

  it('skips a sent payload that is not a string', () => {
    const sent = jest.fn();
    setListener({ onNewMessageSent: sent });
    native.emitSent(1 as unknown as string);
    expect(sent).not.toHaveBeenCalled();
  });

  it('does not call a method the listener omitted', () => {
    setListener({});
    expect(() => native.emitReceived('[]')).not.toThrow();
    expect(() => native.emitSent('hi')).not.toThrow();
  });

  it('null clears the subscription and disables the native listener', () => {
    setListener({ onNewMessageSent: jest.fn() });
    setListener(null);
    native.emitSent('hi');
    expect(native.setListenerEnabled).toHaveBeenLastCalledWith(false);
    setListener({ onNewMessageSent: jest.fn() });
    expect(native.sentSubscribeCalls()).toBe(2);
  });

  it('rejects an array', () => {
    expect(() => setListener([] as unknown as null)).toThrow(TypeError);
    expect(native.setListenerEnabled).not.toHaveBeenCalled();
  });

  it('rejects a string', () => {
    expect(() => setListener('nope' as unknown as null)).toThrow(/string/);
    expect(native.setListenerEnabled).not.toHaveBeenCalled();
  });
});
