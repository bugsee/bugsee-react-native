import fixture from '../option-enums.json';
import {
  FrameRate,
  IssueSeverity,
  LogLevel,
  VideoMode,
  VideoQuality,
  WITHHELD_FROM_JS,
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

type Members = Record<string, number>;
const FIXTURE = fixture as Record<string, Members>;

describe('the enum constants match the SDK', () => {
  it.each(Object.keys(DECLARED))('%s accounts for every member the SDK has', (name) => {
    const declared = DECLARED[name as keyof typeof DECLARED] as Members;
    const withheld = (WITHHELD_FROM_JS as Record<string, Members>)[name] ?? {};

    // Every SDK member is either exposed or deliberately withheld. A member
    // that is neither fails here, which is the point: a value added to the
    // SDK must be a decision, not something that appears or vanishes silently.
    expect({ ...declared, ...withheld }).toEqual(FIXTURE[name]);
  });

  it('covers every enum the fixture carries', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it('never withholds a member the SDK does not have', () => {
    for (const [name, withheld] of Object.entries(
      WITHHELD_FROM_JS as Record<string, Members>
    )) {
      for (const [member, value] of Object.entries(withheld)) {
        expect(FIXTURE[name]?.[member]).toBe(value);
      }
    }
  });

  it('never withholds and exposes the same member', () => {
    for (const [name, withheld] of Object.entries(
      WITHHELD_FROM_JS as Record<string, Members>
    )) {
      const declared = DECLARED[name as keyof typeof DECLARED] as Members;
      expect(Object.keys(declared)).not.toEqual(
        expect.arrayContaining(Object.keys(withheld))
      );
    }
  });
});

describe('FrameRate.Raw is withheld until iOS has it', () => {
  // Android FrameRate has Raw = 4; iOS BugseeFrameRate stops at High = 3.
  // One JS enum cannot span that, so Raw is not exposed. Verified against
  // ios/sdk origin/nextgen BugseeConstants.h on 2026-09-22.
  it('is absent from the exposed enum', () => {
    expect(FrameRate).not.toHaveProperty('Raw');
  });

  it('is recorded as withheld, with the SDK value it would have', () => {
    expect(WITHHELD_FROM_JS.FrameRate).toEqual({ Raw: 4 });
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
