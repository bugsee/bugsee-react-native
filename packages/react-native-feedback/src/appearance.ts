import { Platform } from 'react-native';

import NativeBugseeFeedback from './NativeBugseeFeedback';

/**
 * One camelCase name, two native keys.
 *
 * Android keys are the `FeedbackAppearance` constant values in
 * `bugsee-android-feedback` 7.3.0 (`Feedback::ActionBarColor`, …). iOS keys
 * are `BugseeTheme` properties in the 7.0.0-beta4 `Bugsee.xcframework`
 * header. A name that exists on only one platform has only that side; setting
 * it on the other throws, so a color that will not be applied is not stored
 * as if it had been.
 */
export const FEEDBACK_APPEARANCE = {
  actionBarColor: { android: 'Feedback::ActionBarColor' },
  actionBarButtonBackgroundClickedColor: {
    android: 'Feedback::ActionBarButtonBackgroundClickedColor',
  },
  backgroundColor: {
    android: 'Feedback::BackgroundColor',
    ios: 'feedbackBackgroundColor',
  },
  barsColor: { ios: 'feedbackBarsColor' },
  bottomDelimiterColor: { android: 'Feedback::BottomDelimiterColor' },
  closeButtonColor: { ios: 'feedbackCloseButtonColor' },
  dateTextColor: { android: 'Feedback::DateTextColor' },
  emailBackgroundColor: {
    android: 'Feedback::EmailBackgroundColor',
    ios: 'feedbackEmailBackgroundColor',
  },
  emailContinueActiveColor: {
    android: 'Feedback::EmailContinueActiveColor',
    ios: 'feedbackEmailContinueActiveColor',
  },
  emailContinueClickedColor: { android: 'Feedback::EmailContinueClickedColor' },
  emailContinueNotActiveColor: {
    android: 'Feedback::EmailContinueNotActiveColor',
    ios: 'feedbackEmailContinueNotActiveColor',
  },
  emailSkipBackgroundClickedColor: {
    android: 'Feedback::EmailSkipBackgroundClickedColor',
  },
  emailSkipColor: { ios: 'feedbackEmailSkipColor' },
  emailSkipTextColor: { android: 'Feedback::EmailSkipTextColor' },
  errorTextColor: { android: 'Feedback::ErrorTextColor' },
  incomingBubbleColor: {
    android: 'Feedback::IncomingBubbleColor',
    ios: 'feedbackIncomingBubbleColor',
  },
  incomingTextColor: {
    android: 'Feedback::IncomingTextColor',
    ios: 'feedbackIncomingTextColor',
  },
  inputBackgroundColor: { ios: 'feedbackInputBackgroundColor' },
  inputTextColor: {
    android: 'Feedback::InputTextColor',
    ios: 'feedbackInputTextColor',
  },
  inputTextHintColor: { android: 'Feedback::InputTextHintColor' },
  loadingBarBackgroundColor: { android: 'Feedback::LoadingBarBackgroundColor' },
  loadingTextColor: { android: 'Feedback::LoadingTextColor' },
  navigationBarColor: { ios: 'feedbackNavigationBarColor' },
  outgoingBubbleColor: {
    android: 'Feedback::OutgoingBubbleColor',
    ios: 'feedbackOutgoingBubbleColor',
  },
  outgoingTextColor: {
    android: 'Feedback::OutgoingTextColor',
    ios: 'feedbackOutgoingTextColor',
  },
  titleTextColor: {
    android: 'Feedback::TitleTextColor',
    ios: 'feedbackTitleTextColor',
  },
  versionChangedBackgroundColor: {
    android: 'Feedback::VersionChangedBackgroundColor',
  },
  versionChangedTextColor: { android: 'Feedback::VersionChangedTextColor' },
} as const;

export type FeedbackAppearanceName = keyof typeof FEEDBACK_APPEARANCE;

export type FeedbackAppearance = {
  [K in FeedbackAppearanceName]: string | undefined;
};

const HEX = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * CSS hex: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` (alpha last). A leading
 * `#` is optional. `#RRGGBB` is opaque.
 */
export function parseFeedbackColor(input: string): Rgba | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const match = HEX.exec(input.trim());
  if (match === null) {
    return undefined;
  }
  const body = match[1];
  if (body === undefined) {
    return undefined;
  }
  const hex =
    body.length <= 4
      ? body
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : body;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
  if ([r, g, b, a].some((n) => Number.isNaN(n))) {
    return undefined;
  }
  return { r, g, b, a };
}

const cache = new Map<FeedbackAppearanceName, string>();

function nativeKey(name: FeedbackAppearanceName, platform: string): string {
  const binding: { readonly android?: string; readonly ios?: string } =
    FEEDBACK_APPEARANCE[name];
  const key = platform === 'android' ? binding.android : binding.ios;
  if (key === undefined) {
    throw new RangeError(
      `Bugsee feedback appearance ${name} is not available on ${platform}`,
    );
  }
  return key;
}

function apply(name: FeedbackAppearanceName, color: string): void {
  if (typeof color !== 'string') {
    throw new TypeError(
      `Bugsee feedback appearance ${name} requires a hex color string, got ${typeof color}`,
    );
  }
  const parsed = parseFeedbackColor(color);
  if (parsed === undefined) {
    // The key only: the rejected text is the app's.
    throw new RangeError(`Bugsee feedback appearance ${name} requires a hex color`);
  }
  const key = nativeKey(name, Platform.OS);
  NativeBugseeFeedback.setAppearanceColor(key, parsed.r, parsed.g, parsed.b, parsed.a);
  cache.set(name, color);
}

/** Drops remembered colors. The native side is not told; tests use this. */
export function clearAppearanceCache(): void {
  cache.clear();
}

export function createAppearance(): FeedbackAppearance {
  const target = {} as FeedbackAppearance;
  const names = Object.keys(FEEDBACK_APPEARANCE) as FeedbackAppearanceName[];
  for (const name of names) {
    Object.defineProperty(target, name, {
      enumerable: true,
      configurable: false,
      get: () => cache.get(name),
      set: (color: string) => {
        apply(name, color);
      },
    });
  }
  return target;
}

export const appearance: FeedbackAppearance = createAppearance();
