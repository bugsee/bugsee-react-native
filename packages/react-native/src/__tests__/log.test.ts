// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import { LogLevel } from '../options/enums';
import { native } from '../__mocks__/native';
import Bugsee from '../index';

beforeEach(() => native.reset());

describe('log', () => {
  it('sends message and level to the native log, not the channel', () => {
    Bugsee.log('a line', LogLevel.Warning);
    expect(native.log).toHaveBeenCalledTimes(1);
    expect(native.log).toHaveBeenCalledWith('a line', 2);
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  it('defaults to Info (3)', () => {
    Bugsee.log('a line');
    expect(native.log).toHaveBeenCalledWith('a line', LogLevel.Info);
    expect(LogLevel.Info).toBe(3);
  });

  // Every value the level table defines crosses as itself, by value.
  it.each([1, 2, 3, 4, 5])('sends level %p unchanged', (level) => {
    Bugsee.log('a line', level as LogLevel);
    expect(native.log).toHaveBeenCalledWith('a line', level);
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
    expect(native.log).toHaveBeenCalledWith('', 3);
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
      expect(native.log).toHaveBeenCalledWith('explicit', LogLevel.Info);
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
