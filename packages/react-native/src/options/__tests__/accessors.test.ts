import { BugseeLaunchOptions } from '../BugseeLaunchOptions';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { ANDROID_ONLY_KEYS, IOS_ONLY_KEYS, SHARED_KEYS } from '../keys';

/**
 * The accessor-to-key contract, written out rather than derived.
 *
 * Deriving it from the implementation would assert nothing: a typo in a key
 * would appear on both sides and pass. A wrong key is silent -- the option
 * simply never reaches the SDK, and the SDK applies its default -- so this is
 * the only thing that catches it.
 */
const SHARED: [string, string, unknown][] = [
  ['captureLogs', 'com.bugsee.option.capture.logs', true],
  ['captureLogsLevel', 'com.bugsee.option.capture.logs.level', 2],
  ['captureNetwork', 'com.bugsee.option.capture.network', true],
  ['captureBreadcrumbs', 'com.bugsee.option.capture.breadcrumbs', true],
  ['captureVideo', 'com.bugsee.option.capture.video', false],
  ['detectAndReportCrash', 'com.bugsee.option.detect.crash', true],
  ['detectAndReportHang', 'com.bugsee.option.detect.hang', true],
  ['wifiOnlyUpload', 'com.bugsee.option.config.wifi-only-upload', true],
  ['duration', 'com.bugsee.option.config.duration', 90],
];

const IOS: [string, string, unknown][] = [
  ['captureAVPlayer', 'com.bugsee.option.capture.avplayer', true],
  ['captureMachExceptions', 'com.bugsee.option.capture.mach-exceptions', true],
  ['captureDiskSpace', 'com.bugsee.option.capture.disk-space', true],
  ['detectAndReportKill', 'com.bugsee.option.detect.kill', true],
  ['maxDataSize', 'com.bugsee.option.config.max-data-size', 5_000_000],
];

const ANDROID: [string, string, unknown][] = [
  ['videoMode', 'com.bugsee.option.capture.video.mode', 20],
  ['logsUseAllSources', 'com.bugsee.option.capture.logs.allsources', true],
  [
    'detectAndReportExitLowMemory',
    'com.bugsee.option.detect.exit.low_memory',
    true,
  ],
  [
    'triggerByNotification',
    'com.bugsee.option.reporting.triggers.notification-bar',
    true,
  ],
];

type Bag = Record<string, unknown>;

describe.each([
  ['shared, on iOS', SHARED, () => new IOSLaunchOptions()],
  ['shared, on Android', SHARED, () => new AndroidLaunchOptions()],
  ['iOS-only', IOS, () => new IOSLaunchOptions()],
  ['Android-only', ANDROID, () => new AndroidLaunchOptions()],
] as const)('%s accessors', (_name, table, make) => {
  it.each(table)('%s writes %s', (accessor, key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    expect(BugseeLaunchOptions.serialize(options as never)).toEqual({
      [key]: value,
    });
  });

  it.each(table)('%s reads back what it wrote', (accessor, _key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    expect(options[accessor]).toEqual(value);
  });

  it.each(table)('%s deletes on undefined', (accessor, _key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    options[accessor] = undefined;
    expect(BugseeLaunchOptions.serialize(options as never)).toEqual({});
  });
});

// A key that is not in the extracted set is one the SDK will ignore.
describe('every accessor targets a key the SDK actually accepts', () => {
  it.each(SHARED)('%s -> %s is shared', (_a, key) => {
    expect(SHARED_KEYS).toContain(key);
  });

  it.each(IOS)('%s -> %s is iOS-only', (_a, key) => {
    expect(IOS_ONLY_KEYS).toContain(key);
  });

  it.each(ANDROID)('%s -> %s is Android-only', (_a, key) => {
    expect(ANDROID_ONLY_KEYS).toContain(key);
  });
});
