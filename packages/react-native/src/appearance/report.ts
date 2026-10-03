import { Platform } from 'react-native';

import NativeBugsee from '../NativeBugsee';

/**
 * One camelCase name, two native keys.
 *
 * Android values are the `ReportAppearance` constants in bugsee-android 7.3.0
 * (`setColor(ReportAppearance.X, int)`). iOS values are writable report color
 * properties on `BugseeTheme` in the vendored 7.0.0-beta3 header. A name that
 * exists on only one platform has only that side; setting it on the other
 * throws, so a color that will not be applied is not stored as if it had been.
 *
 * String placeholders (`Report::SummaryPlaceholder`, `reportSummaryPlaceholder`)
 * are not colors. Android sets them with `setString`, not `setColor`, so they
 * are not on this surface.
 *
 * Feedback colors are not here. They live in `@bugsee/react-native-feedback`.
 */
export const REPORT_APPEARANCE = {
  actionBarButtonBackgroundClickedColor: {
    android: 'Report::ActionBarButtonBackgroundClickedColor',
  },
  actionBarColor: { android: 'Report::ActionBarColor' },
  actionBarTextColor: { android: 'Report::ActionBarTextColor' },
  backgroundColor: {
    android: 'Report::BackgroundColor',
    ios: 'reportBackgroundColor',
  },
  cellBackgroundColor: { ios: 'reportCellBackgroundColor' },
  closeButtonColor: { ios: 'reportCloseButtonColor' },
  editTextBackgroundColor: { android: 'Report::EditTextBackgroundColor' },
  hintColor: { android: 'Report::HintColor' },
  navigationBarColor: { ios: 'reportNavigationBarColor' },
  placeholderColor: { ios: 'reportPlaceholderColor' },
  sendButtonColor: { ios: 'reportSendButtonColor' },
  severityLabelActiveColor: { android: 'Report::SeverityLabelActiveColor' },
  textColor: { android: 'Report::TextColor', ios: 'reportTextColor' },
  versionColor: { android: 'Report::VersionColor', ios: 'reportVersionColor' },
} as const;

export type ReportAppearanceName = keyof typeof REPORT_APPEARANCE;

export type ReportAppearance = {
  [K in ReportAppearanceName]: string | undefined;
};

const HEX = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** CSS hex: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` (alpha last). `#RRGGBB` is opaque. */
function parseReportColor(input: string): Rgba | undefined {
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

function unknownKey(name: string): RangeError {
  return new RangeError(`Bugsee appearance ${name} is not a report color`);
}

function nativeKey(name: ReportAppearanceName, platform: string): string {
  const binding: { readonly android?: string; readonly ios?: string } =
    REPORT_APPEARANCE[name];
  const key = platform === 'android' ? binding.android : binding.ios;
  if (key === undefined) {
    throw new RangeError(
      `Bugsee appearance ${name} is not available on ${platform}`,
    );
  }
  return key;
}

function assertName(name: string): ReportAppearanceName {
  if (!Object.prototype.hasOwnProperty.call(REPORT_APPEARANCE, name)) {
    throw unknownKey(name);
  }
  return name as ReportAppearanceName;
}

function read(name: ReportAppearanceName): string | undefined {
  const key = nativeKey(name, Platform.OS);
  const hex = NativeBugsee.getAppearanceColor(key);
  if (typeof hex !== 'string' || hex.length === 0) {
    return undefined;
  }
  return hex;
}

function write(name: ReportAppearanceName, color: string): void {
  if (typeof color !== 'string') {
    throw new TypeError(
      `Bugsee appearance ${name} requires a hex color string, got ${typeof color}`,
    );
  }
  const parsed = parseReportColor(color);
  if (parsed === undefined) {
    throw new RangeError(
      `Bugsee appearance ${name} requires a hex color, got ${JSON.stringify(color)}`,
    );
  }
  const key = nativeKey(name, Platform.OS);
  const applied = NativeBugsee.setAppearanceColor(
    key,
    parsed.r,
    parsed.g,
    parsed.b,
    parsed.a,
  );
  if (applied !== true) {
    throw new Error(`Bugsee appearance ${name} was not applied`);
  }
}

export function createAppearance(): ReportAppearance {
  return new Proxy({} as ReportAppearance, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined;
      }
      return read(assertName(prop));
    },
    set(_target, prop, value: string) {
      if (typeof prop !== 'string') {
        throw unknownKey(String(prop));
      }
      write(assertName(prop), value);
      return true;
    },
  });
}

export const appearance: ReportAppearance = createAppearance();
