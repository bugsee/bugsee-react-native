/**
 * A region the SDK must not record, in React Native's own coordinate shape —
 * what `measureInWindow` hands back, so a caller can pass it straight through.
 */
export interface SecureRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The wire format is int32, and a coordinate past it wraps to a negative. */
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/**
 * Flattens rectangles into the `[left, top, right, bottom, ...]` list both
 * SDKs pack into their pulled buffer.
 *
 * Rounding goes OUTWARDS rather than to nearest. React Native measurements are
 * floats on any device with a non-integer pixel ratio, the buffer is int32, and
 * a redaction that falls a fraction short leaves a strip along an edge visible
 * — which is where text sits. Covering at most a pixel too much is the safe
 * direction to be wrong in.
 *
 * Throws rather than skipping a malformed rectangle: every silent reading of
 * one is a region the caller believes is redacted and is not.
 */
export function flattenSecureRectangles(
  rectangles: readonly SecureRectangle[],
): number[] {
  const flat: number[] = [];

  rectangles.forEach((rectangle, index) => {
    const { x, y, width, height } = rectangle;

    for (const [name, value] of Object.entries({ x, y, width, height })) {
      if (!Number.isFinite(value)) {
        throw new RangeError(
          `secure rectangle [${index}] has a non-finite ${name}: ${String(value)}`,
        );
      }
    }

    if (width < 0 || height < 0) {
      throw new RangeError(
        `secure rectangle [${index}] has a negative extent ` +
          `(${width} x ${height}); a mirrored region would redact the wrong pixels`,
      );
    }

    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.ceil(x + width);
    const bottom = Math.ceil(y + height);

    // After rounding, not before: a sub-pixel sliver rounds out to a real one
    // and should still be redacted, while a genuinely empty region should not
    // churn the version on every frame it is laid out.
    if (right <= left || bottom <= top) {
      return;
    }

    for (const [name, value] of Object.entries({ left, top, right, bottom })) {
      if (value < INT32_MIN || value > INT32_MAX) {
        throw new RangeError(
          `secure rectangle [${index}] has a ${name} of ${value}, ` +
            `which does not fit int32 and would wrap to a region elsewhere`,
        );
      }
    }

    flat.push(left, top, right, bottom);
  });

  return flat;
}
