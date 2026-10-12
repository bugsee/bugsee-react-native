import { Platform } from 'react-native';
import Bugsee, { BugseeLaunchOptions, createDefaultLaunchOptions, endpointFor } from '@bugsee/react-native';
import { applyCommon } from '../options/common';
import { parseOptionValue } from '../options/advanced';
import { installReportHandler } from '../reportHandlers';
import type { SavedConfig } from './config';
export function buildLaunchOptions(c: SavedConfig, platform: 'ios' | 'android'): Record<string, unknown> {
  const o = createDefaultLaunchOptions(platform);
  applyCommon(o, c.common);
  for (const [k, v] of Object.entries(c.advanced)) o.setCustomOption(k, parseOptionValue(v));
  return { ...BugseeLaunchOptions.serialize(o), ...endpointFor(platform, c.endpoint) };
}
const os = () => Platform.OS as 'ios' | 'android';
/** Installs the saved report handler first, so it also sees the crash this launch recovers. */
export function launchWith(c: SavedConfig): Promise<boolean> {
  installReportHandler(c.reportHandler);
  return Bugsee.launch(c.token.trim(), buildLaunchOptions(c, os()));
}
export function relaunchWith(c: SavedConfig): Promise<boolean> {
  installReportHandler(c.reportHandler);
  return Bugsee.relaunch(buildLaunchOptions(c, os()));
}
