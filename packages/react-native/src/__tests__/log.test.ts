// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import { LogLevel } from '../options/enums';
import { native } from '../__mocks__/native';
import Bugsee from '../index';

beforeEach(() => native.reset());

/**
 * Loads a fresh `index.ts` with `../wrapper/channel` replaced by a spy, so
 * `log`'s forwarding can be asserted in isolation from `forwardLog`'s own
 * validation (covered by wrapper/__tests__/channel.test.ts). Sandboxed via
 * `isolateModules`, so it never disturbs the `Bugsee` imported above.
 */
function loadWithChannelSpy(): {
  bugsee: typeof Bugsee;
  forwardLog: jest.Mock;
} {
  const forwardLog = jest.fn();
  jest.doMock('../wrapper/channel', () => ({ forwardLog }));
  let bugsee!: typeof Bugsee;
  jest.isolateModules(() => {
    bugsee = require('../index').default;
  });
  jest.dontMock('../wrapper/channel');
  return { bugsee, forwardLog };
}

describe('log, mocking the channel', () => {
  it('log forwards message and level through forwardLog', () => {
    const { bugsee, forwardLog } = loadWithChannelSpy();
    bugsee.log('a line', LogLevel.Warning);
    expect(forwardLog).toHaveBeenCalledTimes(1);
    expect(forwardLog).toHaveBeenCalledWith('a line', LogLevel.Warning);
  });

  it('log defaults to Info (3)', () => {
    const { bugsee, forwardLog } = loadWithChannelSpy();
    bugsee.log('a line');
    expect(forwardLog).toHaveBeenCalledWith('a line', LogLevel.Info);
    expect(LogLevel.Info).toBe(3);
  });

  it('log is a method on the default export', () => {
    const { bugsee } = loadWithChannelSpy();
    expect(typeof bugsee.log).toBe('function');
  });
});

describe('log, crossing the real channel', () => {
  // 0 is iOS's BugseeLogLevelInvalid, 6 is past Verbose, and 2.5 would reach
  // Android as a double that truncates into a level nobody asked for --
  // forwardLog's own validation (channel.test.ts), exercised here through the
  // public facade with no channel mock in the way.
  it('log rejects 0, 6 and 2.5 before crossing', () => {
    for (const level of [0, 6, 2.5]) {
      expect(() => Bugsee.log('a line', level as LogLevel)).toThrow(RangeError);
    }
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  it('log rejects a non-string message before crossing', () => {
    expect(() => Bugsee.log(42 as unknown as string)).toThrow(TypeError);
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  // The console patch honours capture.logs. An explicit log() does not:
  // it still goes through forwardLog, whatever that option says.
  it('an explicit log still forwards when capture.logs is false', () => {
    const { installConsoleCapture } = require('../console/capture') as {
      installConsoleCapture: (options?: Record<string, unknown>) => void;
    };
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved = methods.map(method => [method, console[method]] as const);
    console.log = jest.fn() as unknown as typeof console.log;
    try {
      installConsoleCapture({ 'com.bugsee.option.capture.logs': false });
      Bugsee.log('explicit');
      expect(native.wrapperLog).toHaveBeenCalledTimes(1);
      expect(native.wrapperLog).toHaveBeenCalledWith('explicit', LogLevel.Info);
      console.log('from the patch');
      expect(native.wrapperLog).toHaveBeenCalledTimes(1);
    } finally {
      for (const [method, original] of saved) {
        console[method] = original;
      }
    }
  });

  // Internal: `log` is the only public spelling of this route.
  it('forwardLog is still not exported from the package entry', () => {
    const entry = require('../index') as Record<string, unknown>;
    expect(entry).not.toHaveProperty('forwardLog');
    const facade = entry.default as Record<string, unknown>;
    expect(facade.forwardLog).toBeUndefined();
  });
});
