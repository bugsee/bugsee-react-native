jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PixelRatio: { get: () => 3 },
}));

import { secureRectangleScale } from '../unit';

describe('secureRectangleScale', () => {
  it('scales by the pixel ratio on Android, which takes pixels', () => {
    expect(secureRectangleScale()).toBe(3);
  });
});
