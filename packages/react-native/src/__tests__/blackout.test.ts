// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about blackout, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee from '../index';
import { native } from '../__mocks__/native';

beforeEach(() => native.reset());

describe('startBlackout', () => {
  it('forwards', () => {
    Bugsee.startBlackout();
    expect(native.startBlackout).toHaveBeenCalledTimes(1);
    expect(native.startBlackout).toHaveBeenCalledWith();
  });

  // Pins the mutation this task's brief calls out by name: a facade that
  // routes startBlackout into the SDK's endBlackout would still make
  // `native.startBlackout` get called once, so that alone does not catch it --
  // this also asserts endBlackout stayed untouched.
  it('never calls endBlackout', () => {
    Bugsee.startBlackout();
    expect(native.endBlackout).not.toHaveBeenCalled();
  });
});

describe('endBlackout', () => {
  it('forwards', () => {
    Bugsee.endBlackout();
    expect(native.endBlackout).toHaveBeenCalledTimes(1);
    expect(native.endBlackout).toHaveBeenCalledWith();
  });
});

describe('isBlackout', () => {
  it('resolves what native reports (true)', async () => {
    native.isBlackout.mockResolvedValueOnce(true);
    await expect(Bugsee.isBlackout()).resolves.toBe(true);
  });

  it('resolves what native reports (false)', async () => {
    native.isBlackout.mockResolvedValueOnce(false);
    await expect(Bugsee.isBlackout()).resolves.toBe(false);
  });
});

describe('captureViewHierarchy', () => {
  it('forwards', () => {
    Bugsee.captureViewHierarchy();
    expect(native.captureViewHierarchy).toHaveBeenCalledTimes(1);
    expect(native.captureViewHierarchy).toHaveBeenCalledWith();
  });
});

// The only other coverage of this facade method was a regex over
// examples/bare/index.js (scripts/__tests__/example-wiring.test.ts), which
// pins that the EXAMPLE calls it, not that the facade itself delegates to
// `viewtree/anchor.tsx`'s `wrap`.
describe('wrap', () => {
  it('delegates to viewtree/anchor.tsx', () => {
    function Root(): null {
      return null;
    }

    expect(Bugsee.wrap(Root).displayName).toBe('BugseeRoot(Root)');
  });
});
