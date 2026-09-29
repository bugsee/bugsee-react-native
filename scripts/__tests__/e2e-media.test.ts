import {
  LUMA_BRIGHT_MIN,
  LUMA_DARK_MAX,
  blackoutPattern,
  letterbox,
  shadeOf,
  videoRegion,
} from '../../examples/bare/e2e/media';

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

describe('letterbox', () => {
  it("fits the WOD_LX1's 720x1612 display into 640x640 with the SDK's 177 px side bars", () => {
    const box = letterbox({ width: 720, height: 1612 }, { width: 640, height: 640 });
    expect(box.scale).toBeCloseTo(640 / 1612, 12);
    expect(box.padH).toBe(177);
    expect(box.padV).toBe(0);
  });

  it('puts the bars above and below when the display is the wider one', () => {
    expect(letterbox({ width: 1600, height: 800 }, { width: 400, height: 400 })).toEqual({
      scale: 0.25,
      padH: 0,
      padV: 100,
    });
  });

  it('has no bars when the aspect ratios match', () => {
    expect(letterbox({ width: 1080, height: 2400 }, { width: 540, height: 1200 })).toEqual({
      scale: 0.5,
      padH: 0,
      padV: 0,
    });
  });

  it('refuses a zero or negative size', () => {
    expect(() => letterbox({ width: 0, height: 10 }, { width: 10, height: 10 })).toThrow(/positive/);
    expect(() => letterbox({ width: 10, height: 10 }, { width: 10, height: -1 })).toThrow(/positive/);
    expect(() => letterbox({ width: 10, height: 0 }, { width: 10, height: 10 })).toThrow(/positive/);
    expect(() => letterbox({ width: 10, height: 10 }, { width: 0, height: 10 })).toThrow(/positive/);
  });
});

describe('videoRegion', () => {
  const screen = { width: 800, height: 1600 };
  const video = { width: 800, height: 400 }; // scale 0.25, bars of 300 left and right

  it('scales, shifts past the bars and insets', () => {
    // x: 300 + 100*0.25 + 2 = 327; right: 300 + 500*0.25 - 2 = 423
    // y: 0 + 400*0.25 + 2 = 102; bottom: 0 + 800*0.25 - 2 = 198
    expect(videoRegion({ left: 100, top: 400, right: 500, bottom: 800 }, screen, video, 2)).toEqual({
      x: 327,
      y: 102,
      w: 96,
      h: 96,
    });
  });

  it('with no inset, is the rectangle itself', () => {
    expect(videoRegion({ left: 0, top: 0, right: 800, bottom: 1600 }, screen, video, 0)).toEqual({
      x: 300,
      y: 0,
      w: 200,
      h: 400,
    });
  });

  it('rounds inwards, never past the rectangle', () => {
    const region = videoRegion({ left: 2, top: 2, right: 19, bottom: 19 }, screen, video, 0);
    // x: 300.5 -> 301 (up); right: 304.75 -> 304 (down); y: 0.5 -> 1; bottom: 4.75 -> 4
    expect(region).toEqual({ x: 301, y: 1, w: 3, h: 3 });
  });

  it('maps the WOD_LX1 secure component into the 640x640 video', () => {
    const region = videoRegion(
      { left: 120, top: 520, right: 480, bottom: 700 },
      { width: 720, height: 1612 },
      { width: 640, height: 640 },
      3,
    );
    const scale = 640 / 1612;
    expect(region).toEqual({
      x: Math.ceil(177 + 120 * scale + 3),
      y: Math.ceil(520 * scale + 3),
      w: Math.floor(177 + 480 * scale - 3) - Math.ceil(177 + 120 * scale + 3),
      h: Math.floor(700 * scale - 3) - Math.ceil(520 * scale + 3),
    });
    expect(region).toEqual({ x: 228, y: 210, w: 136, h: 64 });
  });

  it('refuses a rectangle the inset leaves empty', () => {
    expect(() => videoRegion({ left: 0, top: 0, right: 16, bottom: 400 }, screen, video, 2)).toThrow(/nothing/);
    expect(() => videoRegion({ left: 0, top: 0, right: 400, bottom: 16 }, screen, video, 2)).toThrow(/nothing/);
    // Exactly empty: w = 0.
    expect(() => videoRegion({ left: 0, top: 0, right: 16, bottom: 400 }, screen, video, 0)).not.toThrow();
    expect(() => videoRegion({ left: 0, top: 0, right: 0, bottom: 400 }, screen, video, 0)).toThrow(/nothing/);
  });
});
