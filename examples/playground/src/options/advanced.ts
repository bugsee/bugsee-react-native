import { Platform } from 'react-native';
import keys from '@bugsee/react-native/src/options/option-keys.json';
import { COMMON_KEYS } from './common';
const platformKeys = Platform.OS === 'ios' ? keys.ios : keys.android;
export const ADVANCED_KEYS: readonly string[] = [...new Set([...keys.shared, ...platformKeys])]
  .filter((k) => !(COMMON_KEYS as readonly string[]).includes(k))
  .sort();
export function parseOptionValue(s: string): boolean | number | string {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}
