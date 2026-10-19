// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import { Platform } from 'react-native';

import { LogLevel } from '../options/enums';
import { native } from '../__mocks__/native';
import Bugsee from '../index';

beforeEach(() => native.reset());

describe('log', () => {
  it('sends message and level to the native log, not the channel', () => {
    Bugsee.log('a line', LogLevel.Warning);
    expect(native.log).toHaveBeenCalledTimes(1);
    expect(native.log).toHaveBeenCalledWith('a line', 2, false);
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  it('defaults to Info (3)', () => {
    Bugsee.log('a line');
    expect(native.log).toHaveBeenCalledWith('a line', LogLevel.Info, false);
    expect(LogLevel.Info).toBe(3);
  });

  // Every value the level table defines crosses as itself, by value.
  it.each([1, 2, 3, 4, 5])('sends level %p unchanged', (level) => {
    Bugsee.log('a line', level as LogLevel);
    expect(native.log).toHaveBeenCalledWith('a line', level, false);
  });

  // log() runs the filter itself, so native never runs it again. With no
  // filter set, a line that asks for one is sent as is.
  it('never sends requiresFiltering true to native', () => {
    Bugsee.log('unfiltered', LogLevel.Info);
    Bugsee.log('filtered', LogLevel.Info, true);
    Bugsee.log('explicitly unfiltered', LogLevel.Info, false);
    expect(native.log.mock.calls).toEqual([
      ['unfiltered', 3, false],
      ['filtered', 3, false],
      ['explicitly unfiltered', 3, false],
    ]);
  });

  it('rejects a non-boolean requiresFiltering before crossing', () => {
    for (const flag of [null, 1, 'true', {}]) {
      expect(() => Bugsee.log('a line', LogLevel.Info, flag as unknown as boolean)).toThrow(
        new TypeError(`Bugsee.log requires requiresFiltering to be a boolean, got ${typeof flag}`),
      );
    }
    expect(native.log).not.toHaveBeenCalled();
  });

  it('is a method on the default export', () => {
    expect(typeof Bugsee.log).toBe('function');
  });

  // 0 is iOS's BugseeLogLevelInvalid, 6 is past Verbose, and 2.5 would reach
  // Android as a double that truncates into a level nobody asked for.
  it('rejects 0, 6 and 2.5 before crossing', () => {
    for (const level of [0, 6, 2.5, -1, NaN]) {
      expect(() => Bugsee.log('a line', level as LogLevel)).toThrow(RangeError);
    }
    expect(native.log).not.toHaveBeenCalled();
  });

  it('rejects a non-string message before crossing', () => {
    for (const message of [undefined, null, 42, {}, []]) {
      expect(() => Bugsee.log(message as unknown as string)).toThrow(TypeError);
    }
    expect(native.log).not.toHaveBeenCalled();
  });

  // The type of what an untyped caller passed, never the value itself.
  it('names the call and the rejected type, never the value', () => {
    expect(() => Bugsee.log('a line', 6 as LogLevel)).toThrow(
      new RangeError('Bugsee.log requires a LogLevel (1-5)'),
    );
    expect(() => Bugsee.log(42 as unknown as string)).toThrow(
      new TypeError('Bugsee.log requires message to be a string, got number'),
    );
  });

  // An empty line is still a line; only the type is checked.
  it('sends an empty message', () => {
    Bugsee.log('');
    expect(native.log).toHaveBeenCalledWith('', 3, false);
  });

  // capture.logs turns off what is captured automatically: the console
  // patch stops forwarding, and the SDKs drop the channel's lines. An
  // explicit log() is the app's own line, and still crosses.
  it('an explicit log is still sent when capture.logs is false', () => {
    const { installConsoleCapture } = require('../console/capture') as {
      installConsoleCapture: (options?: Record<string, unknown>) => void;
    };
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved = methods.map(method => [method, console[method]] as const);
    console.log = jest.fn() as unknown as typeof console.log;
    try {
      installConsoleCapture({ 'com.bugsee.option.capture.logs': false });
      Bugsee.log('explicit');
      expect(native.log).toHaveBeenCalledTimes(1);
      expect(native.log).toHaveBeenCalledWith('explicit', LogLevel.Info, false);
      console.log('from the patch');
      expect(native.log).toHaveBeenCalledTimes(1);
      expect(native.wrapperLog).not.toHaveBeenCalled();
    } finally {
      for (const [method, original] of saved) {
        console[method] = original;
      }
    }
  });

  // Internal: `log` is the only public spelling of a log line.
  it('forwardLog is still not exported from the package entry', () => {
    const entry = require('../index') as Record<string, unknown>;
    expect(entry).not.toHaveProperty('forwardLog');
    const facade = entry.default as Record<string, unknown>;
    expect(facade.forwardLog).toBeUndefined();
  });
});

// As in the native SDKs, the app's log filter skips an explicit line unless
// the app asks for it. Then log() runs it in JS, not through native.
describe('log with requiresFiltering', () => {
  afterEach(() => {
    Bugsee.setLogFilter(null);
    jest.useRealTimers();
  });

  /** Drains the microtask queue a promise result is sent on. */
  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  it('does not run the filter unless the app asks for it', () => {
    const filter = jest.fn((line: string) => `redacted:${line}`);
    Bugsee.setLogFilter(filter);
    Bugsee.log('a line', LogLevel.Info);
    Bugsee.log('a line', LogLevel.Info, false);
    expect(filter).not.toHaveBeenCalled();
    expect(native.log.mock.calls).toEqual([
      ['a line', 3, false],
      ['a line', 3, false],
    ]);
  });

  it('sends the replacement within the call, without asking native', () => {
    const filter = jest.fn((line: string) => `redacted:${line}`);
    Bugsee.setLogFilter(filter);
    Bugsee.log('secret', LogLevel.Warning, true);
    expect(filter).toHaveBeenCalledWith('secret');
    expect(native.log.mock.calls).toEqual([['redacted:secret', 2, false]]);
    expect(native.replyLogFilter).not.toHaveBeenCalled();
  });

  it('runs the filter set at the call', () => {
    Bugsee.setLogFilter(() => 'first');
    Bugsee.log('a line', LogLevel.Info, true);
    Bugsee.setLogFilter(() => 'second');
    Bugsee.log('a line', LogLevel.Info, true);
    Bugsee.setLogFilter(null);
    Bugsee.log('a line', LogLevel.Info, true);
    expect(native.log.mock.calls).toEqual([
      ['first', 3, false],
      ['second', 3, false],
      ['a line', 3, false],
    ]);
  });

  it.each([null, undefined, 42, true, ''])('sends what the filter returns, or drops a non-string: %p', (value) => {
    Bugsee.setLogFilter(() => value as unknown as string);
    Bugsee.log('secret', LogLevel.Info, true);
    // An empty string is still a string; the SDKs drop an empty line.
    expect(native.log.mock.calls).toEqual(value === '' ? [['', 3, false]] : []);
  });

  it('drops the line, and does not throw, when the filter throws', () => {
    Bugsee.setLogFilter(() => {
      throw new Error('boom');
    });
    expect(() => Bugsee.log('secret', LogLevel.Info, true)).not.toThrow();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('sends the string a promise settles to', async () => {
    Bugsee.setLogFilter((line) => Promise.resolve(`redacted:${line}`));
    Bugsee.log('secret', LogLevel.Info, true);
    expect(native.log).not.toHaveBeenCalled();
    await flush();
    expect(native.log.mock.calls).toEqual([['redacted:secret', 3, false]]);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['settles to null', () => Promise.resolve(null)],
    ['settles to a non-string', () => Promise.resolve(42 as unknown as string)],
  ])('drops the line when the promise %s', async (_, filter) => {
    Bugsee.setLogFilter(filter);
    Bugsee.log('secret', LogLevel.Info, true);
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('sends a promise that settles within 10 s, and clears its timer', async () => {
    jest.useFakeTimers();
    let settle: (line: string) => void = () => {};
    Bugsee.setLogFilter(() => new Promise<string>((resolve) => (settle = resolve)));
    Bugsee.log('secret', LogLevel.Info, true);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(9_999);
    settle('in time');
    await flush();
    expect(native.log.mock.calls).toEqual([['in time', 3, false]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  // The answer is in time when its microtasks run before the deadline timer:
  // here the filter's timer was set first, and the async advance drains
  // microtasks after each timer, as bridgeless does. log.ts names the
  // runtimes where the deadline can win instead.
  it('sends an answer whose microtasks run before the deadline timer', async () => {
    jest.useFakeTimers();
    Bugsee.setLogFilter(
      (line) => new Promise<string>((resolve) => setTimeout(() => resolve(`late:${line}`), 10_000)),
    );
    Bugsee.log('secret', LogLevel.Info, true);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(native.log.mock.calls).toEqual([['late:secret', 3, false]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('drops a promise that settles after 10 s, never sending the original', async () => {
    jest.useFakeTimers();
    let settle: (line: string) => void = () => {};
    Bugsee.setLogFilter(() => new Promise<string>((resolve) => (settle = resolve)));
    Bugsee.log('secret', LogLevel.Info, true);
    jest.advanceTimersByTime(10_000);
    expect(jest.getTimerCount()).toBe(0);
    settle('late');
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('keeps nothing waiting after 10 s when the promise never settles', async () => {
    jest.useFakeTimers();
    Bugsee.setLogFilter(() => new Promise<string>(() => {}));
    Bugsee.log('secret', LogLevel.Info, true);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    expect(native.log).not.toHaveBeenCalled();
  });

  // Filtering it would recurse; sending it unfiltered would skip a filter
  // the app asked for.
  it('drops a filtered line the filter logs on the same turn', () => {
    const filter = jest.fn((line: string) => {
      Bugsee.log(`nested ${line}`, LogLevel.Info, true);
      return line;
    });
    Bugsee.setLogFilter(filter);
    Bugsee.log('outer', LogLevel.Info, true);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(native.log.mock.calls).toEqual([['outer', 3, false]]);
  });

  it('sends an unfiltered line the filter logs', () => {
    Bugsee.setLogFilter((line) => {
      Bugsee.log(`nested ${line}`);
      return line;
    });
    Bugsee.log('outer', LogLevel.Info, true);
    expect(native.log.mock.calls).toEqual([
      ['nested outer', 3, false],
      ['outer', 3, false],
    ]);
  });

  it('filters the next line after the filter threw', () => {
    let fail = true;
    const filter = jest.fn((line: string) => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return `redacted:${line}`;
    });
    Bugsee.setLogFilter(filter);
    Bugsee.log('first', LogLevel.Info, true);
    Bugsee.log('second', LogLevel.Info, true);
    expect(filter).toHaveBeenCalledTimes(2);
    expect(native.log.mock.calls).toEqual([['redacted:second', 3, false]]);
  });

  // As without a filter: a synchronous native throw is the caller's.
  it('lets a native throw reach the caller when the filter answers at once', () => {
    Bugsee.setLogFilter((line) => line);
    native.log.mockImplementationOnce(() => {
      throw new Error('bridge gone');
    });
    expect(() => Bugsee.log('a line', LogLevel.Info, true)).toThrow('bridge gone');
  });

  // Jest fails a test that leaves an unhandled rejection; nothing else is
  // needed to observe one.
  it('swallows a native throw after a promise settles', async () => {
    Bugsee.setLogFilter((line) => Promise.resolve(line));
    native.log.mockImplementationOnce(() => {
      throw new Error('bridge gone');
    });
    Bugsee.log('a line', LogLevel.Info, true);
    await flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(native.log).toHaveBeenCalledTimes(1);
  });
});

// A filter that settles later must not record its line in another session.
describe('log with an asynchronous filter across sessions', () => {
  const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0002';

  afterEach(() => {
    Bugsee.setLogFilter(null);
    (Platform as { OS: string }).OS = 'android';
  });

  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  it.each([
    ['stop', () => Bugsee.stop()],
    ['launch', () => Bugsee.launch(TOKEN)],
    ['relaunch', () => Bugsee.relaunch()],
    ['attach', () => Bugsee.attach()],
  ])('drops a line whose filter settles after %s was called', async (_name, lifecycle) => {
    let settle: (line: string) => void = () => {};
    Bugsee.setLogFilter(() => new Promise<string>((resolve) => (settle = resolve)));
    Bugsee.log('token=abc', LogLevel.Info, true);
    await Promise.allSettled([lifecycle()]);
    native.log.mockClear();
    settle('token=[redacted]');
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('sends a line logged after the session started, when its filter settles', async () => {
    await Promise.allSettled([Bugsee.launch(TOKEN)]);
    let settle: (line: string) => void = () => {};
    Bugsee.setLogFilter(() => new Promise<string>((resolve) => (settle = resolve)));
    Bugsee.log('token=abc', LogLevel.Info, true);
    settle('token=[redacted]');
    await flush();
    expect(native.log.mock.calls).toEqual([['token=[redacted]', 3, false]]);
  });

  it('drops a synchronous result when the filter itself called a session method before returning', async () => {
    Bugsee.setLogFilter((line) => {
      void Bugsee.stop();
      return `[app] ${line}`;
    });
    Bugsee.log('a', LogLevel.Info, true);
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('drops a waiting line even when the session call changes nothing (launch resolving false)', async () => {
    native.launch.mockResolvedValue(false);
    let settle: (line: string) => void = () => {};
    Bugsee.setLogFilter(() => new Promise<string>((resolve) => (settle = resolve)));
    Bugsee.log('x', LogLevel.Info, true);
    await Promise.allSettled([Bugsee.launch(TOKEN)]);
    settle('x');
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });

  it('sends a synchronous filter result even though a session call follows', async () => {
    Bugsee.setLogFilter((line) => `[app] ${line}`);
    Bugsee.log('a', LogLevel.Info, true);
    await Promise.allSettled([Bugsee.stop()]);
    expect(native.log.mock.calls).toEqual([['[app] a', 3, false]]);
  });
});

// iOS drops an empty line before it filters; a filter must not bring one back.
describe('log of an empty message with a filter', () => {
  afterEach(() => {
    Bugsee.setLogFilter(null);
    (Platform as { OS: string }).OS = 'android';
  });

  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  it.each([
    ['synchronous', (line: string) => `[app] ${line}`],
    ['asynchronous', (line: string) => Promise.resolve(`[app] ${line}`)],
  ])('does not send a %s replacement for an empty line on iOS, but the filter still sees it', async (_kind, filter) => {
    (Platform as { OS: string }).OS = 'ios';
    const seen = jest.fn(filter as (line: string) => string);
    Bugsee.setLogFilter(seen);
    Bugsee.log('', LogLevel.Info, true);
    await flush();
    expect(seen).toHaveBeenCalledWith('');
    expect(native.log).not.toHaveBeenCalled();
  });

  it('sends it on Android, and sends a non-empty line on iOS', async () => {
    Bugsee.setLogFilter((line) => `[app] ${line}`);
    Bugsee.log('', LogLevel.Info, true);
    (Platform as { OS: string }).OS = 'ios';
    Bugsee.log('x', LogLevel.Info, true);
    await flush();
    expect(native.log.mock.calls).toEqual([
      ['[app] ', 3, false],
      ['[app] x', 3, false],
    ]);
  });

  it('drops the line, without throwing, when reading the result\'s then throws', async () => {
    const hostile = {
      get then(): never {
        throw new Error('no');
      },
    };
    Bugsee.setLogFilter(() => hostile as unknown as string);
    expect(() => Bugsee.log('secret', LogLevel.Info, true)).not.toThrow();
    await flush();
    expect(native.log).not.toHaveBeenCalled();
  });
});
