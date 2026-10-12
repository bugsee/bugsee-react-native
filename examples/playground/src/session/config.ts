import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_COMMON } from '../options/common';
import type { CommonOptions } from '../options/common';
export const CONFIG_KEY = 'playground.config.v1';
export interface SavedConfig {
  version: 1; token: string; endpoint: string; common: CommonOptions;
  advanced: Record<string, string>; autoLaunch: boolean; everLaunched: boolean;
}
export const DEFAULT_CONFIG: SavedConfig = {
  version: 1, token: '', endpoint: '', common: DEFAULT_COMMON, advanced: {}, autoLaunch: false, everLaunched: false,
};
export async function loadConfig(): Promise<SavedConfig> {
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(CONFIG_KEY)) ?? 'null');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || typeof raw.token !== 'string') {
      return DEFAULT_CONFIG;
    }
    return { ...DEFAULT_CONFIG, ...raw, common: { ...DEFAULT_COMMON, ...(raw.common ?? {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}
export async function saveConfig(c: SavedConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(c));
}
