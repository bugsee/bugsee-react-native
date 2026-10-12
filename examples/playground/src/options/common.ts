import { LogLevel } from '@bugsee/react-native';
import type { BugseeLaunchOptions } from '@bugsee/react-native';
export interface CommonOptions {
  video: boolean; network: boolean; logs: boolean; logLevel: LogLevel; breadcrumbs: boolean;
  crash: boolean; hang: boolean; duration?: number; maxDataSize?: number; wifiOnly: boolean;
}
export const DEFAULT_COMMON: CommonOptions = {
  video: true, network: true, logs: true, logLevel: LogLevel.Verbose, breadcrumbs: true, crash: true, hang: true, wifiOnly: false,
};
export const COMMON_KEYS = [
  'com.bugsee.option.capture.video', 'com.bugsee.option.capture.network', 'com.bugsee.option.capture.logs',
  'com.bugsee.option.capture.logs.level', 'com.bugsee.option.capture.breadcrumbs', 'com.bugsee.option.detect.crash',
  'com.bugsee.option.detect.hang', 'com.bugsee.option.config.duration', 'com.bugsee.option.config.max-data-size',
  'com.bugsee.option.config.wifi-only-upload',
] as const;
export function applyCommon(o: BugseeLaunchOptions, c: CommonOptions): void {
  o.captureVideo = c.video; o.captureNetwork = c.network; o.captureLogs = c.logs; o.captureLogsLevel = c.logLevel;
  o.captureBreadcrumbs = c.breadcrumbs; o.detectAndReportCrash = c.crash; o.detectAndReportHang = c.hang;
  o.duration = c.duration; o.maxDataSize = c.maxDataSize; o.wifiOnlyUpload = c.wifiOnly;
}
