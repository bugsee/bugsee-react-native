import { flattenSecureRectangles } from '../rectangles';

/**
 * The two SDKs take DIFFERENT UNITS, and the iOS header says so outright:
 *
 *   "Coordinates are in points in the screen's coordinate space, origin
 *    top-left — the same convention as +[Bugsee addSecureRectangle:]
 *    (Android uses pixels, matching its own addSecureRectangle)."
 *
 * React Native measures in density-independent points. Those ARE iOS points,
 * and are NOT Android pixels: pixels = points x PixelRatio. Publishing
 * unconverted points on a 3x Android device redacts a third of the intended
 * area — a leak, and in the direction that looks like it is working.
 *
 * The scale is applied BEFORE rounding outward, not after. Rounding in points
 * and then scaling reintroduces fractional pixel edges, which is the same
 * sub-pixel gap the outward rounding exists to close.
 */
describe('flattenSecureRectangles scales to the platform unit', () => {
  it('leaves points alone at scale 1, which is what iOS wants', () => {
    expect(flattenSecureRectangles([{ x: 10, y: 20, width: 30, height: 40 }], 1))
      .toEqual([10, 20, 40, 60]);
  });

  it('converts points to pixels for Android', () => {
    expect(flattenSecureRectangles([{ x: 10, y: 20, width: 30, height: 40 }], 3))
      .toEqual([30, 60, 120, 180]);
  });

  it('rounds outward AFTER scaling, not before', () => {
    // 10.5pt at 2x is exactly 21px; the left edge must not first become 10pt
    // and then 20px, which would expose a pixel column.
    expect(flattenSecureRectangles([{ x: 10.5, y: 0, width: 1, height: 1 }], 2))
      .toEqual([21, 0, 23, 2]);
  });

  it('still covers at least the region asked for on a fractional scale', () => {
    const [left, top, right, bottom] = flattenSecureRectangles(
      [{ x: 10, y: 10, width: 10, height: 10 }], 2.625,
    ) as [number, number, number, number];

    expect(left).toBeLessThanOrEqual(10 * 2.625);
    expect(top).toBeLessThanOrEqual(10 * 2.625);
    expect(right).toBeGreaterThanOrEqual(20 * 2.625);
    expect(bottom).toBeGreaterThanOrEqual(20 * 2.625);
  });

  it('defaults to scale 1 so an unscaled caller gets points', () => {
    expect(flattenSecureRectangles([{ x: 1, y: 2, width: 3, height: 4 }]))
      .toEqual([1, 2, 4, 6]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the nonsensical scale %p rather than publishing a wrong region',
    (scale) => {
      expect(() => flattenSecureRectangles([{ x: 0, y: 0, width: 1, height: 1 }], scale))
        .toThrow(/scale/i);
    },
  );
});
