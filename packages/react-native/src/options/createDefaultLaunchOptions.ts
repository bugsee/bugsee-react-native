import { Platform } from 'react-native';
import type { BugseeLaunchOptions } from './BugseeLaunchOptions';
import { AndroidLaunchOptions } from './AndroidLaunchOptions';
import { IOSLaunchOptions } from './IOSLaunchOptions';

/**
 * A launch-options object for the running platform, empty.
 *
 * Deliberately NOT pre-populated with defaults. The 6.x wrapper did that and
 * drifted: it shipped `videoMode = V3`, a value 7.x removed, and set iOS-only
 * frame-rate keys on Android. The SDKs know their own defaults, and
 * `getLaunchOptions()` reports the resolved set after launch.
 */
export function createDefaultLaunchOptions(
  platform: string = Platform.OS,
): BugseeLaunchOptions {
  if (platform === 'ios') {
    return new IOSLaunchOptions();
  }
  if (platform === 'android') {
    return new AndroidLaunchOptions();
  }
  throw new Error(
    `Bugsee supports ios and android; there is no native SDK for ${platform}.`,
  );
}
