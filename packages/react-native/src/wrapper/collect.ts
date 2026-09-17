/**
 * Gathers the facts the wrapper reports about itself.
 *
 * These are JS-side facts — the React Native version, the engine, the build
 * configuration — so JS collects them and hands them down, rather than each
 * bridge trying to work them out natively.
 */
import { Platform } from 'react-native';
import type { WrapperFacts } from './identity';

interface ReactNativeVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string | null;
}

/** `0.87.1`, or `0.88.0-rc.1`, or `unknown`. */
export function formatReactNativeVersion(
  version: ReactNativeVersion | undefined,
): string {
  if (
    version === undefined ||
    typeof version.major !== 'number' ||
    typeof version.minor !== 'number' ||
    typeof version.patch !== 'number'
  ) {
    return 'unknown';
  }
  // Not `major || 0`: every component of 0.0.0 is falsy and would be dropped.
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

declare const __DEV__: boolean;

export function collectWrapperFacts(version: string): WrapperFacts {
  return {
    version,
    reactNativeVersion: formatReactNativeVersion(
      Platform.constants?.reactNativeVersion,
    ),
    // Hermes announces itself with a global; there is no API for it.
    hermes: (globalThis as { HermesInternal?: unknown }).HermesInternal != null,
    dev: typeof __DEV__ === 'boolean' ? __DEV__ : false,
  };
}
