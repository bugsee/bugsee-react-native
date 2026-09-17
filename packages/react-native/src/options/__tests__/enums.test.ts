import fixture from '../option-enums.json';
import {
  FrameRate,
  IssueSeverity,
  LogLevel,
  VideoMode,
  VideoQuality,
} from '../enums';

/**
 * The TS constants are written out, and the fixture is extracted from the SDK
 * sources. This asserts they agree.
 *
 * Writing them by hand is how `IssueSeverity` acquired a `Low` constant that
 * does not exist and lost `Blocker`, shifting three values — each of which the
 * SDK would have accepted as a different, valid severity.
 */
const DECLARED = {
  LogLevel,
  VideoMode,
  VideoQuality,
  FrameRate,
  IssueSeverity,
} as const;

describe('the enum constants match the SDK', () => {
  it.each(Object.keys(DECLARED))('%s agrees with the extracted fixture', (name) => {
    expect(DECLARED[name as keyof typeof DECLARED])
      .toEqual((fixture as Record<string, Record<string, number>>)[name]);
  });

  it('covers every enum the fixture carries', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(Object.keys(fixture).sort());
  });
});

describe('the values that diverge from ordinals', () => {
  // These four are why numbers cross the bridge as internal values and the
  // Android side converts with fromIntValue/fromRawValue, never values()[n].
  it('LogLevel.Error is 1 at ordinal 0', () => {
    expect(LogLevel.Error).toBe(1);
    expect(Object.values(LogLevel).indexOf(LogLevel.Error)).toBe(0);
  });

  it('VideoMode.Fullscreen is 20 at ordinal 3', () => {
    expect(VideoMode.Fullscreen).toBe(20);
    expect(Object.values(VideoMode).indexOf(VideoMode.Fullscreen)).toBe(3);
  });

  it('FrameRate and IssueSeverity are offset by one', () => {
    expect(FrameRate.Low).toBe(1);
    expect(IssueSeverity.VeryLow).toBe(1);
  });

  // The one that coincides, which is why it cannot stand in for the others.
  it('VideoQuality coincides with its ordinals', () => {
    Object.values(VideoQuality).forEach((value, ordinal) => {
      expect(value).toBe(ordinal);
    });
  });
});
