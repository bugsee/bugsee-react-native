import { native } from '../../__mocks__/native';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', constants: { reactNativeVersion: { major: 0, minor: 87, patch: 1 } } },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import Bugsee from '../../index';

beforeEach(() => native.reset());

describe('setSecureRectangles', () => {

  it('flattens to the buffer the SDKs pack, on the default display', () => {
    Bugsee.setSecureRectangles([{ x: 10, y: 20, width: 30, height: 40 }]);

    expect(native.setSecureRectangles).toHaveBeenCalledWith(0, [10, 20, 40, 60]);
  });

  it('addresses a display when asked to', () => {
    Bugsee.setSecureRectangles([{ x: 1, y: 2, width: 3, height: 4 }], 2);

    expect(native.setSecureRectangles).toHaveBeenCalledWith(2, [1, 2, 4, 6]);
  });

  it('clears a display with an empty list', () => {
    Bugsee.setSecureRectangles([]);

    expect(native.setSecureRectangles).toHaveBeenCalledWith(0, []);
  });

  // The whole call is rejected rather than the bad rectangle dropped. Publishing
  // the good ones would leave the caller believing the rest are redacted too.
  it('publishes nothing when any rectangle is invalid', () => {
    expect(() => Bugsee.setSecureRectangles([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: -1, height: 10 },
    ])).toThrow(/negative/i);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  // A non-integer display would reach a native `(int)` cast and silently
  // address display 0, redacting the wrong screen.
  it.each([1.5, Number.NaN, -1])('rejects the display index %p', (display) => {
    expect(() => Bugsee.setSecureRectangles([], display))
      .toThrow(/display/i);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });
});
