// The public entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { native } from '../../__mocks__/native';
import { LogLevel } from '../../options/enums';
import { forwardLog } from '../channel';

beforeEach(() => native.reset());

describe('forwardLog', () => {
  it('forwards message and level', () => {
    forwardLog('a line', LogLevel.Warning);
    expect(native.wrapperLog).toHaveBeenCalledTimes(1);
    expect(native.wrapperLog).toHaveBeenCalledWith('a line', 2);
  });

  it('defaults to Info (3)', () => {
    forwardLog('a line');
    expect(native.wrapperLog).toHaveBeenCalledWith('a line', 3);
  });

  // Every value the level table defines crosses as itself, by value.
  it.each([1, 2, 3, 4, 5])('forwards level %p unchanged', (level) => {
    forwardLog('a line', level as LogLevel);
    expect(native.wrapperLog).toHaveBeenCalledWith('a line', level);
  });

  // 0 is iOS's BugseeLogLevelInvalid; 6 is past Verbose; 2.5 would reach
  // Android as a double and truncate into a level nobody asked for. -1 and
  // NaN ride along for the same reason.
  it('rejects 0, 6 and 2.5 before crossing', () => {
    for (const level of [0, 6, 2.5, -1, NaN]) {
      expect(() => forwardLog('a line', level as LogLevel)).toThrow(RangeError);
    }
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  it('rejects a non-string message', () => {
    for (const message of [undefined, null, 42, {}, []]) {
      expect(() => forwardLog(message as unknown as string)).toThrow(TypeError);
    }
    expect(native.wrapperLog).not.toHaveBeenCalled();
  });

  // The type of what an untyped caller passed, never the value itself.
  it('names the rejected type, never the value', () => {
    expect(() => forwardLog('a line', 6 as LogLevel)).toThrow(
      new RangeError('forwardLog requires a LogLevel (1-5)'),
    );
    expect(() => forwardLog(42 as unknown as string)).toThrow('a string, got number');
  });

  // An empty line is still a line; only the type is checked.
  it('forwards an empty message', () => {
    forwardLog('');
    expect(native.wrapperLog).toHaveBeenCalledWith('', 3);
  });
});

// Internal: Phase 4's `log()` is the public face of this route. Exposing the
// seam as well would give apps two spellings of one call.
describe('the public entry point', () => {
  it('is not exported from the public entry point', () => {
    const entry = require('../../index') as Record<string, unknown>;
    expect(entry).not.toHaveProperty('forwardLog');
    expect(entry).not.toHaveProperty('wrapperLog');
    const facade = entry.default as Record<string, unknown>;
    expect(facade.forwardLog).toBeUndefined();
    expect(facade.wrapperLog).toBeUndefined();
  });
});
