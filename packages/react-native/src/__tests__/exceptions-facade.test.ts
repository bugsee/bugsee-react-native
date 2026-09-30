// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee, { type ExceptionOptions } from '../index';
import { native } from '../__mocks__/native';

beforeEach(() => native.reset());

describe('exceptions facade', () => {
  it('logException validates options before crossing', () => {
    const error = new Error('x');
    expect(() => Bugsee.logException(error, { domain: '' })).toThrow(RangeError);
    expect(native.logException).not.toHaveBeenCalled();
  });

  it('a non-Error logged from a named function has that function as its first frame', () => {
    function namedCaller(): void {
      Bugsee.logException({ message: 'obj-throw' });
    }
    namedCaller();
    expect(native.logException).toHaveBeenCalledTimes(1);
    const payloadJson = native.logException.mock.calls[0]![0] as string;
    const payload = JSON.parse(payloadJson) as {
      frames: Array<{ data: { member: string } }>;
    };
    expect(payload.frames.length).toBeGreaterThan(0);
    expect(payload.frames[0]!.data.member).toBe('namedCaller');
  });

  it('a non-Error unhandled from a named function has that function as its first frame', async () => {
    async function namedUnhandledCaller(): Promise<void> {
      await Bugsee.logUnhandledException({ message: 'obj-throw' });
    }
    await namedUnhandledCaller();
    expect(native.logUnhandledException).toHaveBeenCalledTimes(1);
    const payloadJson = native.logUnhandledException.mock.calls[0]![0] as string;
    const payload = JSON.parse(payloadJson) as {
      frames: Array<{ data: { member: string } }>;
    };
    expect(payload.frames.length).toBeGreaterThan(0);
    expect(payload.frames[0]!.data.member).toBe('namedUnhandledCaller');
  });

  it("logUnhandledException returns reportUnhandled's promise", async () => {
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    jest.doMock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);
    const sentinel = Promise.resolve();
    jest.doMock('../exceptions/report', () => ({
      reportUnhandled: jest.fn(() => sentinel),
      reportHandled: jest.fn(),
      markReported: jest.fn(() => true),
      UNHANDLED_REPORT_WAIT_MS: 1500,
      EXCEPTION_MAX_AGGREGATE: 10,
    }));
    let bugsee!: typeof Bugsee;
    jest.isolateModules(() => {
      bugsee = require('../index').default;
    });
    const result = bugsee.logUnhandledException(new Error('x'));
    expect(result).toBe(sentinel);
    await result;
  });

  it('ExceptionOptions is exported', () => {
    const _probe: ExceptionOptions = { domain: 'd' };
    expect(_probe.domain).toBe('d');
    expect(typeof Bugsee.logException).toBe('function');
    expect(typeof Bugsee.logUnhandledException).toBe('function');
  });
});
