import { isPlaceholderToken } from './properties';

export interface AutoLaunchInput {
  readonly appToken?: string;
  /** Off unless set. Manifest auto-launch starts the native SDK before JS. */
  readonly autoLaunch?: boolean;
}

/**
 * The `com.bugsee.app-token` meta-data value, or null when the manifest
 * should be left alone. A placeholder token is not written: the native SDK
 * would launch it against the production API.
 */
export function manifestAutoLaunchToken(input: AutoLaunchInput): string | null {
  if (input.autoLaunch !== true) {
    return null;
  }
  const token = input.appToken ?? '';
  if (token.length === 0 || isPlaceholderToken(token)) {
    return null;
  }
  return token;
}
