// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import { native } from '../__mocks__/native';
import Bugsee from '../index';

beforeEach(() => native.reset());

describe('event', () => {
  it('event forwards name and the copied params', () => {
    const params = { a: 1, nested: { b: [1, 'two'] } };
    Bugsee.event('name', params);
    expect(native.event).toHaveBeenCalledTimes(1);
    expect(native.event).toHaveBeenCalledWith('name', { a: 1, nested: { b: [1, 'two'] } });
    // A copy, not the same reference.
    expect(native.event.mock.calls[0]?.[1]).not.toBe(params);
  });

  it('event without params sends null', () => {
    Bugsee.event('name');
    expect(native.event).toHaveBeenCalledWith('name', null);
  });

  it('event with {} sends {}', () => {
    Bugsee.event('name', {});
    expect(native.event).toHaveBeenCalledWith('name', {});
  });

  it('event validates before crossing', () => {
    expect(() => Bugsee.event('name', { bad: NaN })).toThrow(RangeError);
    expect(() => Bugsee.event('name', { bad: (() => {}) as unknown as null }))
      .toThrow(TypeError);
    expect(() => Bugsee.event('')).toThrow(RangeError);
    expect(native.event).not.toHaveBeenCalled();
  });

  // Pins the entry point named in the error -- 'event', not 'trace' or ''.
  it('names "event" in a bad-name error', () => {
    expect(() => Bugsee.event('')).toThrow('Bugsee.event requires a non-empty name');
  });
});

describe('trace', () => {
  it('a number trace goes to traceNumber', () => {
    Bugsee.trace('name', 42);
    expect(native.traceNumber).toHaveBeenCalledWith('name', 42);
    expect(native.traceString).not.toHaveBeenCalled();
    expect(native.traceBoolean).not.toHaveBeenCalled();
  });

  it('a string trace goes to traceString', () => {
    Bugsee.trace('name', 'on');
    expect(native.traceString).toHaveBeenCalledWith('name', 'on');
    expect(native.traceNumber).not.toHaveBeenCalled();
    expect(native.traceBoolean).not.toHaveBeenCalled();
  });

  it('a boolean trace goes to traceBoolean', () => {
    Bugsee.trace('name', true);
    expect(native.traceBoolean).toHaveBeenCalledWith('name', true);
    expect(native.traceNumber).not.toHaveBeenCalled();
    expect(native.traceString).not.toHaveBeenCalled();
  });

  it('a bad trace crosses nothing', () => {
    for (const bad of [null, undefined, NaN, Infinity, {}]) {
      expect(() => Bugsee.trace('name', bad as unknown as string)).toThrow();
    }
    expect(() => Bugsee.trace('', 1)).toThrow(RangeError);
    expect(native.traceNumber).not.toHaveBeenCalled();
    expect(native.traceString).not.toHaveBeenCalled();
    expect(native.traceBoolean).not.toHaveBeenCalled();
  });

  // Pins the entry point named in the error -- 'trace', not 'event' or ''.
  it('names "trace" in a bad-name error', () => {
    expect(() => Bugsee.trace('', 1)).toThrow('Bugsee.trace requires a non-empty name');
  });
});
