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
  delete (globalThis as { nativeLoggingHook?: unknown }).nativeLoggingHook;
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
  classifyFilterRequest: (line: string) => 'deliver' | 'drop';
} {
  const forwardLog = jest.fn();
  jest.doMock('../../wrapper/channel', () => ({ forwardLog }));
  const capture = require('../capture') as {
    installConsoleCapture: (options?: Record<string, unknown>) => void;
  };
  const dedup = require('../dedup') as {
    classifyFilterRequest: (line: string) => 'deliver' | 'drop';
  };
  return {
    installConsoleCapture: capture.installConsoleCapture,
    forwardLog,
    classifyFilterRequest: dedup.classifyFilterRequest,
  };
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

  it('does not throw on Object.create(null), and does not copy an own field', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.log = original as unknown as typeof console.log;
    installConsoleCapture({});

    const blank: Record<string, string> = Object.create(null);
    blank.token = 's3cret';

    expect(() => console.log(blank)).not.toThrow();
    expect(original).toHaveBeenCalledWith(blank);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    const message = forwardLog.mock.calls[0]?.[0] as string;
    expect(message).toBe('[object Object]');
    expect(message).not.toContain('token');
    expect(message).not.toContain('s3cret');
  });

  it('a throwing toString does not escape console.log', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.log = original as unknown as typeof console.log;
    installConsoleCapture({});

    const bad = {
      secret: 's3cret',
      toString(): string {
        throw new Error('toString');
      },
      valueOf(): string {
        throw new Error('valueOf');
      },
    };

    expect(() => console.log('seen', bad)).not.toThrow();
    expect(original).toHaveBeenCalledWith('seen', bad);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    const message = forwardLog.mock.calls[0]?.[0] as string;
    expect(message).toBe('seen [object Object]');
    expect(message).not.toContain('s3cret');
  });

  it('forwards the patch line once when RCTLog echoes a different formatting', () => {
    const echoed: string[] = [];
    (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook =
      (message: string) => {
        echoed.push(message);
      };
    const { installConsoleCapture, forwardLog, classifyFilterRequest } = load();
    console.log = ((...args: unknown[]) => {
      const hook = (globalThis as {
        nativeLoggingHook?: (message: string, level: number) => void;
      }).nativeLoggingHook;
      const text = args
        .map((arg) => (typeof arg === 'string' ? `'${arg}'` : String(arg)))
        .join(', ');
      hook?.(text, 1);
    }) as typeof console.log;

    installConsoleCapture({});
    console.log('seen', { password: 's3cret' });

    expect(echoed).toEqual(["'seen', [object Object]"]);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    expect(forwardLog).toHaveBeenCalledWith('seen [object Object]', LogLevel.Info);
    expect(classifyFilterRequest("'seen', [object Object]")).toBe('drop');
    expect(classifyFilterRequest('seen [object Object]')).toBe('deliver');
    expect(String(forwardLog.mock.calls[0]?.[0])).not.toContain('s3cret');
  });

  it('does not claim a hook call that follows a console call whose original never called the hook', () => {
    (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook =
      () => undefined;
    const { installConsoleCapture, classifyFilterRequest } = load();
    console.log = (() => undefined) as typeof console.log;
    installConsoleCapture({});
    console.log('silent');
    const hook = (globalThis as {
      nativeLoggingHook?: (message: string, level: number) => void;
    }).nativeLoggingHook;
    hook?.('later', 1);
    expect(classifyFilterRequest('later')).toBe('deliver');
  });

  it('does not install a hook when React Native has not installed one', () => {
    const host = globalThis as { nativeLoggingHook?: (message: string, level: number) => void };
    delete host.nativeLoggingHook;
    const { installConsoleCapture } = load();
    installConsoleCapture({});
    expect(host.nativeLoggingHook).toBeUndefined();
  });

  it('keeps the same hook across a second install', () => {
    const host = globalThis as {
      nativeLoggingHook?: ((message: string, level: number) => void) & { bugseeConsoleHook?: boolean };
    };
    host.nativeLoggingHook = () => undefined;
    const { installConsoleCapture } = load();
    installConsoleCapture({});
    const first = host.nativeLoggingHook;
    installConsoleCapture({});
    expect(host.nativeLoggingHook).toBe(first);
    expect(first?.bugseeConsoleHook).toBe(true);
  });

  it('claims only the outer hook call when the original hook re-enters', () => {
    const host = globalThis as { nativeLoggingHook?: (message: string, level: number) => void };
    host.nativeLoggingHook = (message: string) => {
      if (message === 'outer') {
        host.nativeLoggingHook?.('inner', 1);
      }
    };
    const { installConsoleCapture, classifyFilterRequest } = load();
    console.log = (() => {
      host.nativeLoggingHook?.('outer', 1);
    }) as typeof console.log;
    installConsoleCapture({});
    console.log('outer');
    expect(classifyFilterRequest('inner')).toBe('deliver');
    expect(classifyFilterRequest('outer')).toBe('deliver');
    expect(classifyFilterRequest('outer')).toBe('drop');
  });

  it('wraps the native hook once and does not claim a line it did not forward', () => {
    const echoed: string[] = [];
    (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook =
      (message: string) => {
        echoed.push(message);
      };
    const { installConsoleCapture, forwardLog, classifyFilterRequest } = load();
    console.log = ((...args: unknown[]) => {
      const hook = (globalThis as {
        nativeLoggingHook?: (message: string, level: number) => void;
      }).nativeLoggingHook;
      hook?.(String(args[0]), 1);
    }) as typeof console.log;

    installConsoleCapture({});
    installConsoleCapture({});
    const hook = (globalThis as {
      nativeLoggingHook?: (message: string, level: number) => void;
    }).nativeLoggingHook;
    hook?.('before any console call', 1);
    console.log('once');
    hook?.('after the console call', 1);

    expect(echoed).toEqual(['before any console call', 'once', 'after the console call']);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    expect(classifyFilterRequest('before any console call')).toBe('deliver');
    expect(classifyFilterRequest('once')).toBe('deliver');
    expect(classifyFilterRequest('once')).toBe('drop');
    expect(classifyFilterRequest('after the console call')).toBe('deliver');
  });

  it('does not claim an echo when capture.logs is false', () => {
    const echoed: string[] = [];
    (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook =
      (message: string) => {
        echoed.push(message);
      };
    const { installConsoleCapture, forwardLog, classifyFilterRequest } = load();
    console.log = ((message: string) => {
      const hook = (globalThis as {
        nativeLoggingHook?: (message: string, level: number) => void;
      }).nativeLoggingHook;
      hook?.(message, 1);
    }) as typeof console.log;

    installConsoleCapture({ 'com.bugsee.option.capture.logs': false });
    console.log('hidden');

    expect(forwardLog).not.toHaveBeenCalled();
    expect(classifyFilterRequest('hidden')).toBe('deliver');
    expect(echoed).toEqual(['hidden']);
  });

  it('claims an identical RCTLog echo so the second filter request is the one dropped', () => {
    const echoed: string[] = [];
    (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook =
      (message: string) => {
        echoed.push(message);
      };
    const { installConsoleCapture, forwardLog, classifyFilterRequest } = load();
    console.log = ((...args: unknown[]) => {
      const hook = (globalThis as {
        nativeLoggingHook?: (message: string, level: number) => void;
      }).nativeLoggingHook;
      hook?.(args.map((arg) => String(arg)).join(' '), 1);
    }) as typeof console.log;

    installConsoleCapture({});
    console.log('BUGSEE_E2E dedup-line');

    expect(echoed).toEqual(['BUGSEE_E2E dedup-line']);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    expect(classifyFilterRequest('BUGSEE_E2E dedup-line')).toBe('deliver');
    expect(classifyFilterRequest('BUGSEE_E2E dedup-line')).toBe('drop');
  });

  it('a throwing forwardLog does not escape console.log', () => {
    const { installConsoleCapture, forwardLog } = load();
    const original = jest.fn();
    console.log = original as unknown as typeof console.log;
    forwardLog.mockImplementation(() => {
      throw new Error('channel down');
    });
    installConsoleCapture({});

    expect(() => console.log('still printed')).not.toThrow();
    expect(original).toHaveBeenCalledWith('still printed');
    expect(forwardLog).toHaveBeenCalledWith('still printed', LogLevel.Info);
  });
});
