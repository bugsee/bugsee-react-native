import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX, blackoutPattern, shadeOf } from '../../examples/bare/e2e/media';

/**
 * The pure half of the device e2e's media decoder: classifying a decoded
 * luma value and recognising the bright-dark-bright pattern a blackout (or a
 * secure region) leaves in a run of frames. `probeCodec`, `frameLumas`,
 * `regionLuma` and `imageSize` spawn ffmpeg/ffprobe and are exercised by hand
 * against a real pulled bundle instead (see the task's commit message) --
 * `yarn test` must not require ffmpeg to be installed.
 */
describe('shadeOf', () => {
  it('splits at 24 and 150', () => {
    expect(shadeOf(0)).toBe('dark');
    expect(shadeOf(LUMA_DARK_MAX)).toBe('dark');
    expect(shadeOf(LUMA_DARK_MAX + 1)).toBe('other');
    expect(shadeOf(LUMA_BRIGHT_MIN - 1)).toBe('other');
    expect(shadeOf(LUMA_BRIGHT_MIN)).toBe('bright');
    expect(shadeOf(255)).toBe('bright');
  });
});

describe('blackoutPattern', () => {
  const bright = (t: number) => ({ t, luma: 200 });
  const dark = (t: number) => ({ t, luma: 10 });
  const other = (t: number) => ({ t, luma: 90 });

  it('accepts bright, a dark run of at least 1.5 s, bright', () => {
    const result = blackoutPattern([bright(0), dark(0.5), dark(1.0), dark(2.0), bright(2.5)]);
    expect(result).toEqual({ ok: true, darkSeconds: 1.5 });
  });

  it('rejects a dark run shorter than 1.5 s', () => {
    const result = blackoutPattern([bright(0), dark(0.5), dark(1.0), bright(1.2)]);
    expect(result.ok).toBe(false);
  });

  it('rejects dark with nothing bright before it', () => {
    const result = blackoutPattern([dark(0), dark(2.0), bright(2.5)]);
    expect(result.ok).toBe(false);
  });

  it('rejects a video that never recovers', () => {
    const result = blackoutPattern([bright(0), dark(0.5), dark(2.5)]);
    expect(result.ok).toBe(false);
  });

  it('an other frame breaks a dark run', () => {
    // Two dark spans that would total >= 1.5 s together, but an `other`
    // frame in between splits them into two runs, neither long enough alone.
    const result = blackoutPattern([
      bright(0),
      dark(0.5),
      dark(1.2),
      other(1.3),
      dark(1.4),
      dark(2.1),
      bright(2.6),
    ]);
    expect(result.ok).toBe(false);
  });

  it("reports the dark run's length", () => {
    const result = blackoutPattern([bright(0), dark(1.0), dark(3.0), bright(3.5)]);
    expect(result).toEqual({ ok: true, darkSeconds: 2.0 });
  });
});
