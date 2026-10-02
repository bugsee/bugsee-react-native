jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { LogLevel } from '../../options/enums';

const CAPTURE_LOGS = 'com.bugsee.option.capture.logs';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof METHODS)[number];

const ORIGINALS: Record<ConsoleMethod, typeof console.log> = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
const ORIGINAL_TRACE = console.trace;

beforeEach(() => {
  jest.resetModules();
  restoreConsole();
});

afterEach(() => {
  restoreConsole();
});

function restoreConsole(): void {
  for (const method of METHODS) {
    console[method] = ORIGINALS[method];
  }
  console.trace = ORIGINAL_TRACE;
}

function load(): {
  installConsoleCapture: (options?: Record<string, unknown>) => void;
  forwardLog: jest.Mock;
} {
  const forwardLog = jest.fn();
  jest.doMock('../../wrapper/channel', () => ({ forwardLog }));
  const capture = require('../capture') as {
    installConsoleCapture: (options?: Record<string, unknown>) => void;
  };
  return { installConsoleCapture: capture.installConsoleCapture, forwardLog };
}

describe('console capture', () => {
  it('forwards each method at its level, after the original call', () => {
    const { installConsoleCapture, forwardLog } = load();
    const originals: Record<ConsoleMethod, jest.Mock> = {
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    for (const method of METHODS) {
      console[method] = originals[method] as unknown as typeof console.log;
    }

    installConsoleCapture({});

    console.error('boom');
    console.warn('careful');
    console.log('hello', 1);
    console.info('note');
    console.debug('detail');

    expect(forwardLog.mock.calls).toEqual([
      ['boom', LogLevel.Error],
      ['careful', LogLevel.Warning],
      ['hello 1', LogLevel.Info],
      ['note', LogLevel.Info],
      ['detail', LogLevel.Debug],
    ]);
    expect(LogLevel.Error).toBe(1);
    expect(LogLevel.Warning).toBe(2);
    expect(LogLevel.Info).toBe(3);
    expect(LogLevel.Debug).toBe(4);

    for (const method of METHODS) {
      const originalOrder = originals[method].mock.invocationCallOrder[0];
      expect(originalOrder).toEqual(expect.any(Number));
    }
    // error is the first call: its original runs before the first forward.
    expect(originals.error.mock.invocationCallOrder[0]).toBeLessThan(
      forwardLog.mock.invocationCallOrder[0]!,
    );
    expect(originals.error).toHaveBeenCalledWith('boom');
    expect(originals.log).toHaveBeenCalledWith('hello', 1);
  });

  it('joins arguments with String(), and does not JSON-stringify objects', () => {
    const { installConsoleCapture, forwardLog } = load();
    console.log = jest.fn() as unknown as typeof console.log;
    installConsoleCapture({});

    console.log('seen', { password: 's3cret' }, null, undefined);

    const message = forwardLog.mock.calls[0]?.[0] as string;
    expect(message).toBe('seen [object Object] null undefined');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('password');
  });

  it('installs once: a second install does not wrap again', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.log = original as unknown as typeof console.log;

    installConsoleCapture({});
    const wrapped = console.log;
    installConsoleCapture({});

    expect(console.log).toBe(wrapped);
    console.log('once');
    expect(original).toHaveBeenCalledTimes(1);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    expect(forwardLog).toHaveBeenCalledWith('once', LogLevel.Info);
  });

  it('does not forward when capture.logs is false, but still calls the original', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.error = original as unknown as typeof console.error;

    installConsoleCapture({ [CAPTURE_LOGS]: false });
    console.error('hidden');

    expect(original).toHaveBeenCalledWith('hidden');
    expect(forwardLog).not.toHaveBeenCalled();
  });

  it('forwards when capture.logs is absent', () => {
    const { installConsoleCapture, forwardLog } = load();
    console.log = jest.fn() as unknown as typeof console.log;

    installConsoleCapture({});
    console.log('visible');

    expect(forwardLog).toHaveBeenCalledWith('visible', LogLevel.Info);
  });

  it('a later install turns forwarding off without wrapping again', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.log = original as unknown as typeof console.log;

    installConsoleCapture({});
    const wrapped = console.log;
    installConsoleCapture({ [CAPTURE_LOGS]: false });

    expect(console.log).toBe(wrapped);
    console.log('stopped');
    expect(original).toHaveBeenCalledTimes(1);
    expect(forwardLog).not.toHaveBeenCalled();
  });

  it('does not patch console.trace', () => {
    const { installConsoleCapture, forwardLog } = load();
    const trace = jest.fn();
    console.trace = trace as unknown as typeof console.trace;
    installConsoleCapture({});
    expect(console.trace).toBe(trace);
    console.trace('nope');
    expect(trace).toHaveBeenCalledWith('nope');
    expect(forwardLog).not.toHaveBeenCalled();
  });

  it('stringifies a symbol with String(), the same as any other argument', () => {
    const { installConsoleCapture, forwardLog } = load();
    console.log = jest.fn() as unknown as typeof console.log;
    installConsoleCapture({});

    console.log(Symbol('token'));

    expect(forwardLog).toHaveBeenCalledWith('Symbol(token)', LogLevel.Info);
  });
});
