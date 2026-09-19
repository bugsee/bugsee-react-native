jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  // Deliberately not 1: iOS screens are 2x or 3x, and the point of this test
  // is that the ratio must NOT be applied there. A mock returning 1 would pass
  // whether or not the platform check exists.
  PixelRatio: { get: () => 3 },
}));

import { secureRectangleScale } from '../unit';

describe('secureRectangleScale on iOS', () => {
  it('stays 1, because iOS takes points and not pixels', () => {
    expect(secureRectangleScale()).toBe(1);
  });
});
