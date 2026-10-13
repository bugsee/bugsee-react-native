import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_COMMON } from '../options/common';
import type { CommonOptions } from '../options/common';
export const CONFIG_KEY = 'playground.config.v1';
/** The report-handler preset (Reports → Report handler), installed before every launch. */
export type ReportHandlerChoice = 'none' | 'labels' | 'attachFile' | 'drop';
export const REPORT_HANDLER_CHOICES: readonly ReportHandlerChoice[] = ['none', 'labels', 'attachFile', 'drop'];
export interface SavedConfig {
  version: 1; token: string; endpoint: string; common: CommonOptions;
  advanced: Record<string, string>; autoLaunch: boolean; everLaunched: boolean; reportHandler: ReportHandlerChoice;
}
export const DEFAULT_CONFIG: SavedConfig = {
  version: 1, token: '', endpoint: '', common: DEFAULT_COMMON, advanced: {}, autoLaunch: false, everLaunched: false,
  reportHandler: 'none',
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fresh = (): SavedConfig => ({ ...DEFAULT_CONFIG, common: { ...DEFAULT_COMMON }, advanced: {} });
function normaliseCommon(raw: unknown): CommonOptions {
  const out: Record<string, unknown> = { ...DEFAULT_COMMON };
  if (isObj(raw)) {
    for (const k of Object.keys(DEFAULT_COMMON) as (keyof CommonOptions)[]) {
      if (typeof raw[k] === typeof DEFAULT_COMMON[k] && (typeof raw[k] !== 'number' || Number.isFinite(raw[k]))) out[k] = raw[k];
    }
    for (const k of ['duration', 'maxDataSize'] as const) {
      if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) out[k] = raw[k];
    }
  }
  return out as unknown as CommonOptions;
}
export async function loadConfig(): Promise<SavedConfig> {
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(CONFIG_KEY)) ?? 'null');
    if (!isObj(raw) || raw.version !== 1 || typeof raw.token !== 'string') return fresh();
    const advanced: Record<string, string> = {};
    if (isObj(raw.advanced)) for (const [k, v] of Object.entries(raw.advanced)) if (typeof v === 'string') advanced[k] = v;
    return {
      version: 1,
      token: raw.token,
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : DEFAULT_CONFIG.endpoint,
      common: normaliseCommon(raw.common),
      advanced,
      autoLaunch: typeof raw.autoLaunch === 'boolean' ? raw.autoLaunch : DEFAULT_CONFIG.autoLaunch,
      everLaunched: typeof raw.everLaunched === 'boolean' ? raw.everLaunched : DEFAULT_CONFIG.everLaunched,
      reportHandler: REPORT_HANDLER_CHOICES.includes(raw.reportHandler as ReportHandlerChoice)
        ? (raw.reportHandler as ReportHandlerChoice)
        : DEFAULT_CONFIG.reportHandler,
    };
  } catch {
    return fresh();
  }
}
export async function saveConfig(c: SavedConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(c));
}

type ConfigPatcher = (patch: Partial<SavedConfig>) => Promise<void>;
let patcher: ConfigPatcher | null = null;
/**
 * The SessionProvider registers itself here, so a patch made outside React (an action) updates its state too.
 * Returns the unregister function.
 */
export function setConfigPatcher(p: ConfigPatcher): () => void {
  patcher = p;
  return () => {
    if (patcher === p) patcher = null;
  };
}
/** Saves part of the config: through the SessionProvider when one is mounted, else straight to storage. */
export async function patchConfig(patch: Partial<SavedConfig>): Promise<void> {
  if (patcher) return patcher(patch);
  await saveConfig({ ...(await loadConfig()), ...patch });
}
