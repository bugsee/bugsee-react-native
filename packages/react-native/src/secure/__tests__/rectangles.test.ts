import { flattenSecureRectangles } from '../rectangles';

describe('flattenSecureRectangles', () => {
  it('converts x/y/width/height into the left, top, right, bottom the SDKs want', () => {
    expect(flattenSecureRectangles([{ x: 10, y: 20, width: 30, height: 40 }]))
      .toEqual([10, 20, 40, 60]);
  });

  it('flattens several rectangles in order', () => {
    expect(flattenSecureRectangles([
      { x: 0, y: 0, width: 1, height: 2 },
      { x: 5, y: 6, width: 7, height: 8 },
    ])).toEqual([0, 0, 1, 2, 5, 6, 12, 14]);
  });

  it('flattens an empty list to an empty buffer, which clears the set', () => {
    expect(flattenSecureRectangles([])).toEqual([]);
  });

  // React Native measurements are floats on every device with a non-integer
  // pixel ratio. The buffer is int32, so a float would be truncated somewhere
  // out of our control -- rounding OUTWARDS here keeps the redaction covering
  // at least the region asked for. Rounding to nearest could expose a strip
  // of up to a pixel along an edge, which is exactly where text sits.
  it('rounds outwards, never inwards', () => {
    expect(flattenSecureRectangles([
      { x: 10.4, y: 20.6, width: 30.1, height: 40.9 },
    ])).toEqual([10, 20, 41, 62]);
  });

  it('keeps integers untouched', () => {
    expect(flattenSecureRectangles([{ x: -5, y: -6, width: 10, height: 12 }]))
      .toEqual([-5, -6, 5, 6]);
  });

  // A zero-area rectangle redacts nothing but costs a version bump and four
  // ints on every pull. Dropping it is not merely an optimisation: an app
  // laying out a collapsed view would otherwise churn the version each frame.
  it('drops rectangles that cover no pixels', () => {
    expect(flattenSecureRectangles([
      { x: 1, y: 1, width: 0, height: 10 },
      { x: 2, y: 2, width: 10, height: 0 },
      { x: 3, y: 3, width: 4, height: 5 },
    ])).toEqual([3, 3, 7, 8]);
  });

  // A negative extent is a caller bug, and the reading that redacts nothing is
  // the wrong one to pick silently -- but so is redacting a mirrored region
  // somewhere else on screen. Rejecting loudly is the only option that cannot
  // quietly leak.
  it.each([
    [{ x: 0, y: 0, width: -1, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: -1 }],
  ])('rejects a negative extent %p', (rect) => {
    expect(() => flattenSecureRectangles([rect])).toThrow(/negative/i);
  });

  it.each([
    [{ x: Number.NaN, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: Number.NaN, height: 1 }],
  ])('rejects a non-finite coordinate %p', (rect) => {
    expect(() => flattenSecureRectangles([rect])).toThrow(/finite/i);
  });

  // int32 is the wire format. A coordinate beyond it would wrap to a negative
  // and redact a region nowhere near the one asked for.
  it('rejects a coordinate that will not survive int32', () => {
    expect(() => flattenSecureRectangles([
      { x: 2_147_483_600, y: 0, width: 100, height: 1 },
    ])).toThrow(/int32/i);
  });

  it('names the offending index so a long list is debuggable', () => {
    expect(() => flattenSecureRectangles([
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 },
    ])).toThrow(/\[1\]/);
  });
});
