// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about lifecycle, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import Bugsee, { Status } from '../index';
import { native } from '../__mocks__/native';

jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

beforeEach(() => native.reset());

describe('launch', () => {
  // The signature says string, but the call arrives from untyped JS just as
  // often as from TypeScript. A non-string must be rejected here rather than
  // reaching the bridge and failing as something less legible.
  it.each([undefined, null, 42, {}, []])(
    'rejects the non-string token %p before touching the bridge',
    async (token) => {
      await expect(Bugsee.launch(token as unknown as string)).rejects.toThrow(
        /non-empty app token/,
      );
      expect(native.launch).not.toHaveBeenCalled();
    },
  );

  it('forwards the token and defaults options to an empty object', async () => {
    await expect(Bugsee.launch('tok')).resolves.toBe(true);
    expect(native.launch).toHaveBeenCalledWith('tok', {});
  });

  it('forwards caller-supplied options untouched', async () => {
    const opts = { 'com.bugsee.option.capture.video': false };
    await Bugsee.launch('tok', opts);
    expect(native.launch).toHaveBeenCalledWith('tok', opts);
  });

  it('propagates a native refusal as false rather than throwing', async () => {
    native.launch.mockResolvedValue(false);
    await expect(Bugsee.launch('tok')).resolves.toBe(false);
  });

  it.each(['', '   ', '\t\n'])('rejects the blank token %p before touching the bridge', async (token) => {
    await expect(Bugsee.launch(token)).rejects.toThrow(/token/i);
    expect(native.launch).not.toHaveBeenCalled();
  });

  it('surfaces a native rejection to the caller', async () => {
    native.launch.mockRejectedValue(new Error('boom'));
    await expect(Bugsee.launch('tok')).rejects.toThrow('boom');
  });
});

describe('relaunch and stop', () => {
  it('relaunch defaults options and returns the native result', async () => {
    native.relaunch.mockResolvedValue(false);
    await expect(Bugsee.relaunch()).resolves.toBe(false);
    expect(native.relaunch).toHaveBeenCalledWith({});
  });

  it('stop returns the native result', async () => {
    await expect(Bugsee.stop()).resolves.toBe(true);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });
});

describe('getStatus', () => {
  it.each([
    [0, Status.Stopped],
    [1, Status.Launching],
    [2, Status.Launched],
    [3, Status.Stopping],
  ])('maps native %i onto the Status constant', async (raw, expected) => {
    native.getStatus.mockResolvedValue(raw);
    await expect(Bugsee.getStatus()).resolves.toBe(expected);
  });

  it('reports an unrecognised native status as Stopped rather than leaking it', async () => {
    native.getStatus.mockResolvedValue(99);
    await expect(Bugsee.getStatus()).resolves.toBe(Status.Stopped);
  });
});

describe('attach', () => {
  // Android can launch itself from manifest metadata, in which case only the
  // JS layer needs wiring. attach() must therefore never call launch.
  it('does not launch the native SDK', async () => {
    await Bugsee.attach();
    expect(native.launch).not.toHaveBeenCalled();
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it('is idempotent, and still never launches', async () => {
    await Bugsee.attach();
    await expect(Bugsee.attach()).resolves.toBeUndefined();
    expect(native.launch).not.toHaveBeenCalled();
  });
});

describe('test helpers', () => {
  it('testNativeCrash reaches the bridge', () => {
    Bugsee.testNativeCrash();
    expect(native.testCrash).toHaveBeenCalledTimes(1);
  });

  it('testJsCrash throws in JS without touching the bridge', () => {
    expect(() => Bugsee.testJsCrash()).toThrow(/test/i);
    expect(native.testCrash).not.toHaveBeenCalled();
  });
});
