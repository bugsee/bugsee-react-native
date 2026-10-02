jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../NativeBugseeFeedback', () => require('../testSupport/nativeFeedback').nativeMock);

import { Platform } from 'react-native';
import {
  FEEDBACK_APPEARANCE,
  appearance,
  clearAppearanceCache,
  parseFeedbackColor,
  type FeedbackAppearanceName,
} from '../appearance';
import { native } from '../testSupport/nativeFeedback';

const ANDROID_KEYS = [
  'Feedback::ActionBarColor',
  'Feedback::ActionBarButtonBackgroundClickedColor',
  'Feedback::BackgroundColor',
  'Feedback::IncomingBubbleColor',
  'Feedback::OutgoingBubbleColor',
  'Feedback::IncomingTextColor',
  'Feedback::OutgoingTextColor',
  'Feedback::DateTextColor',
  'Feedback::TitleTextColor',
  'Feedback::EmailSkipTextColor',
  'Feedback::EmailSkipBackgroundClickedColor',
  'Feedback::EmailBackgroundColor',
  'Feedback::EmailContinueNotActiveColor',
  'Feedback::EmailContinueActiveColor',
  'Feedback::EmailContinueClickedColor',
  'Feedback::InputTextColor',
  'Feedback::InputTextHintColor',
  'Feedback::BottomDelimiterColor',
  'Feedback::LoadingBarBackgroundColor',
  'Feedback::LoadingTextColor',
  'Feedback::ErrorTextColor',
  'Feedback::VersionChangedBackgroundColor',
  'Feedback::VersionChangedTextColor',
];

const IOS_KEYS = [
  'feedbackBarsColor',
  'feedbackBackgroundColor',
  'feedbackIncomingBubbleColor',
  'feedbackOutgoingBubbleColor',
  'feedbackIncomingTextColor',
  'feedbackOutgoingTextColor',
  'feedbackTitleTextColor',
  'feedbackEmailSkipColor',
  'feedbackEmailBackgroundColor',
  'feedbackEmailContinueNotActiveColor',
  'feedbackEmailContinueActiveColor',
  'feedbackInputBackgroundColor',
  'feedbackInputTextColor',
  'feedbackCloseButtonColor',
  'feedbackNavigationBarColor',
];

beforeEach(() => {
  native.reset();
  clearAppearanceCache();
  (Platform as { OS: string }).OS = 'android';
});

describe('parseFeedbackColor', () => {
  it('expands #RGB and defaults alpha to opaque', () => {
    expect(parseFeedbackColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 255 });
  });

  it('expands #RGBA with alpha last', () => {
    expect(parseFeedbackColor('#abc8')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0x88 });
  });

  it('reads #RRGGBB', () => {
    expect(parseFeedbackColor('#112233')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 255 });
  });

  it('reads #RRGGBBAA with alpha last', () => {
    expect(parseFeedbackColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 0x80 });
  });

  it('accepts a missing hash and surrounding space', () => {
    expect(parseFeedbackColor('  FFFFFF ')).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('rejects a non-hex string', () => {
    expect(parseFeedbackColor('#gg0000')).toBeUndefined();
    expect(parseFeedbackColor('#12345')).toBeUndefined();
    expect(parseFeedbackColor('')).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(parseFeedbackColor(1 as unknown as string)).toBeUndefined();
  });
});

describe('appearance', () => {
  const bindings = Object.values(FEEDBACK_APPEARANCE) as ReadonlyArray<{
    readonly android?: string;
    readonly ios?: string;
  }>;

  it('maps every Android key onto a FeedbackAppearance constant', () => {
    const used = bindings
      .map((binding) => binding.android)
      .filter((key): key is string => key !== undefined);
    expect(used.slice().sort()).toEqual(ANDROID_KEYS.slice().sort());
    expect(new Set(used).size).toBe(used.length);
  });

  it('maps every iOS key onto a BugseeTheme feedback property', () => {
    const used = bindings
      .map((binding) => binding.ios)
      .filter((key): key is string => key !== undefined);
    expect(used.slice().sort()).toEqual(IOS_KEYS.slice().sort());
    expect(new Set(used).size).toBe(used.length);
  });

  it('sends the Android native key and the parsed components', () => {
    appearance.incomingBubbleColor = '#11223344';
    expect(native.setAppearanceColor).toHaveBeenCalledWith(
      'Feedback::IncomingBubbleColor',
      0x11,
      0x22,
      0x33,
      0x44,
    );
    expect(appearance.incomingBubbleColor).toBe('#11223344');
  });

  it('sends the iOS property name on iOS', () => {
    (Platform as { OS: string }).OS = 'ios';
    appearance.incomingBubbleColor = '#abcdef';
    expect(native.setAppearanceColor).toHaveBeenCalledWith(
      'feedbackIncomingBubbleColor',
      0xab,
      0xcd,
      0xef,
      255,
    );
  });

  it('refuses an Android-only color on iOS and does not call native', () => {
    (Platform as { OS: string }).OS = 'ios';
    expect(() => {
      appearance.dateTextColor = '#ffffff';
    }).toThrow(/not available on ios/);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
    expect(appearance.dateTextColor).toBeUndefined();
  });

  it('refuses an iOS-only color on Android', () => {
    expect(() => {
      appearance.barsColor = '#ffffff';
    }).toThrow(/not available on android/);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
  });

  it('refuses a bad color before calling native', () => {
    expect(() => {
      appearance.backgroundColor = 'red';
    }).toThrow(RangeError);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
    expect(appearance.backgroundColor).toBeUndefined();
  });

  it('refuses a non-string color', () => {
    expect(() => {
      appearance.backgroundColor = 1 as unknown as string;
    }).toThrow(TypeError);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
  });

  it('reads undefined until a color is set', () => {
    const name: FeedbackAppearanceName = 'backgroundColor';
    expect(appearance[name]).toBeUndefined();
  });
});
