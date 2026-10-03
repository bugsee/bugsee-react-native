jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Platform } from 'react-native';
import Bugsee from '../../index';
import { native } from '../../__mocks__/native';
import { REPORT_APPEARANCE, type ReportAppearanceName } from '../report';

/**
 * `ReportAppearance` constants in bugsee-android 7.3.0. The 6.x names
 * (`ReportActionBarColor`, no `Report::` prefix) are not these.
 */
const ANDROID_ENUM: Record<string, string> = {
  actionBarButtonBackgroundClickedColor: 'Report::ActionBarButtonBackgroundClickedColor',
  actionBarColor: 'Report::ActionBarColor',
  actionBarTextColor: 'Report::ActionBarTextColor',
  backgroundColor: 'Report::BackgroundColor',
  editTextBackgroundColor: 'Report::EditTextBackgroundColor',
  hintColor: 'Report::HintColor',
  severityLabelActiveColor: 'Report::SeverityLabelActiveColor',
  textColor: 'Report::TextColor',
  versionColor: 'Report::VersionColor',
};

/**
 * Writable report color properties on `BugseeTheme` in the vendored
 * 7.0.0-beta3 header. Feedback properties and the readonly palette are not
 * report appearance.
 */
const IOS_PROPERTY: Record<string, string> = {
  backgroundColor: 'reportBackgroundColor',
  cellBackgroundColor: 'reportCellBackgroundColor',
  closeButtonColor: 'reportCloseButtonColor',
  navigationBarColor: 'reportNavigationBarColor',
  placeholderColor: 'reportPlaceholderColor',
  sendButtonColor: 'reportSendButtonColor',
  textColor: 'reportTextColor',
  versionColor: 'reportVersionColor',
};

const PUBLIC_KEYS = Object.keys(REPORT_APPEARANCE).sort();

beforeEach(() => {
  native.reset();
  native.setAppearanceColor.mockReturnValue(true);
  native.getAppearanceColor.mockReturnValue('');
  (Platform as { OS: string }).OS = 'android';
});

describe('report appearance mapping', () => {
  it.each(PUBLIC_KEYS)('%s maps to the Android enum and the iOS property', (key) => {
    const binding = REPORT_APPEARANCE[key as ReportAppearanceName] as {
      readonly android?: string;
      readonly ios?: string;
    };
    expect(binding.android).toBe(ANDROID_ENUM[key]);
    expect(binding.ios).toBe(IOS_PROPERTY[key]);
  });

  it('covers every 7.x report color and no 6.x Android name', () => {
    expect(PUBLIC_KEYS).toEqual(
      [...new Set([...Object.keys(ANDROID_ENUM), ...Object.keys(IOS_PROPERTY)])].sort(),
    );
    const androidValues = PUBLIC_KEYS.map(
      (key) =>
        (REPORT_APPEARANCE[key as ReportAppearanceName] as { android?: string }).android,
    ).filter((value): value is string => value !== undefined);
    expect(androidValues.every((value) => value.startsWith('Report::'))).toBe(true);
    expect(androidValues).not.toContain('ReportActionBarColor');
    expect(androidValues).not.toContain('ReportBackgroundColor');
  });

  it('sends the Android enum and the parsed components', () => {
    Bugsee.appearance.backgroundColor = '#11223344';
    expect(native.setAppearanceColor).toHaveBeenCalledWith(
      'Report::BackgroundColor',
      0x11,
      0x22,
      0x33,
      0x44,
    );
  });

  it('sends the iOS property name on iOS', () => {
    (Platform as { OS: string }).OS = 'ios';
    Bugsee.appearance.backgroundColor = '#abcdef';
    expect(native.setAppearanceColor).toHaveBeenCalledWith(
      'reportBackgroundColor',
      0xab,
      0xcd,
      0xef,
      255,
    );
  });

  it('reads the color the SDK reports', () => {
    native.getAppearanceColor.mockReturnValue('#11223344');
    expect(Bugsee.appearance.backgroundColor).toBe('#11223344');
    expect(native.getAppearanceColor).toHaveBeenCalledWith('Report::BackgroundColor');
  });

  it('rejects an unknown key the same way on both platforms', () => {
    const messages: string[] = [];
    for (const os of ['android', 'ios']) {
      (Platform as { OS: string }).OS = os;
      expect(() => {
        (Bugsee.appearance as Record<string, string>).notAReportColor = '#ffffff';
      }).toThrow(RangeError);
      try {
        (Bugsee.appearance as Record<string, string>).notAReportColor = '#ffffff';
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toMatch(/notAReportColor/);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
  });

  it('refuses a color the current platform does not have', () => {
    expect(() => {
      Bugsee.appearance.cellBackgroundColor = '#ffffff';
    }).toThrow(/not available on android/);
    (Platform as { OS: string }).OS = 'ios';
    expect(() => {
      Bugsee.appearance.actionBarColor = '#ffffff';
    }).toThrow(/not available on ios/);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
  });

  it('reads a color the current platform does not have as undefined', () => {
    expect(Bugsee.appearance.cellBackgroundColor).toBeUndefined();
    expect(native.getAppearanceColor).not.toHaveBeenCalled();
    (Platform as { OS: string }).OS = 'ios';
    expect(Bugsee.appearance.actionBarColor).toBeUndefined();
    expect(native.getAppearanceColor).not.toHaveBeenCalled();
  });

  it('lists the report colors and leaves inspection properties alone', () => {
    expect(Object.keys(Bugsee.appearance).sort()).toEqual(PUBLIC_KEYS);
    expect('backgroundColor' in Bugsee.appearance).toBe(true);
    expect(Bugsee.appearance.constructor).toBe(Object);
    expect(typeof Bugsee.appearance.toString).toBe('function');
    expect(() => Bugsee.appearance.toString()).not.toThrow();
    expect((Bugsee.appearance as { then?: unknown }).then).toBeUndefined();
    expect(native.getAppearanceColor).not.toHaveBeenCalled();
  });

  it('refuses a bad color before calling native', () => {
    expect(() => {
      Bugsee.appearance.backgroundColor = 'red';
    }).toThrow(RangeError);
    expect(native.setAppearanceColor).not.toHaveBeenCalled();
  });
});

describe('deleteCollectedDataOnDevice', () => {
  it('passes includingIntermediate true through', async () => {
    native.deleteCollectedDataOnDevice.mockResolvedValue(true);
    await expect(Bugsee.deleteCollectedDataOnDevice(true)).resolves.toBe(true);
    expect(native.deleteCollectedDataOnDevice).toHaveBeenCalledWith(true);
  });

  it('passes includingIntermediate false through', async () => {
    native.deleteCollectedDataOnDevice.mockResolvedValue(false);
    await expect(Bugsee.deleteCollectedDataOnDevice(false)).resolves.toBe(false);
    expect(native.deleteCollectedDataOnDevice).toHaveBeenCalledWith(false);
  });

  it('refuses immediately while launched and settles the Stopped path', () => {
    const source = readFileSync(join(__dirname, '../../../ios/BugseeModule.mm'), 'utf8');
    const start = source.indexOf('- (void)deleteCollectedDataOnDevice:');
    const end = source.indexOf('- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:', start);
    const method = source.slice(start, end);
    const hop = method.indexOf('BGSRNRunOnMain(');
    const status = method.indexOf('instance.status');
    const nilStopped = method.indexOf('BugseeStatusStopped');
    const launched = method.indexOf('status != BugseeStatusStopped');
    const call = method.indexOf('[Bugsee deleteCollectedDataOnDevice:includingIntermediate');
    const earlyResolve = method.indexOf('resolve(@NO)');
    const launchedReturn = method.indexOf('\n      return;', earlyResolve);
    const settle = method.indexOf('BGSRNSettleOnce(BGSRNUnhandledCompletionDeadlineMs');
    const stoppedCall = method.indexOf(
      '[Bugsee deleteCollectedDataOnDevice:includingIntermediate',
      settle,
    );
    expect(hop).toBeGreaterThan(-1);
    expect(method).not.toContain('BGSRNRunOnMainSync');
    expect(status).toBeGreaterThan(hop);
    expect(nilStopped).toBeGreaterThan(status);
    expect(launched).toBeGreaterThan(nilStopped);
    expect(call).toBeGreaterThan(launched);
    expect(earlyResolve).toBeGreaterThan(call);
    expect(launchedReturn).toBeGreaterThan(earlyResolve);
    expect(settle).toBeGreaterThan(launchedReturn);
    expect(method.slice(0, settle)).not.toContain('BGSRNSettleOnce');
    expect(method.slice(0, settle)).not.toContain('BGSRNUnhandledCompletionDeadlineMs');
    expect(stoppedCall).toBeGreaterThan(settle);
    expect(method.slice(settle)).toContain('@(success)');
    expect(method).toContain('includingIntermediate');
  });
});
