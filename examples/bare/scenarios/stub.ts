/**
 * The HTTP stub's base URL as this app must ask for it (e2e/stub-server.ts):
 * Android, always http://127.0.0.1:8899, which the e2e tunnels to the stub
 * (`adb reverse`); iOS, the launch argument `-bugseeE2eStub <url>`, which the
 * e2e passes (startRun's `stub` option), else the same loopback default.
 *
 * Usable from any scenario: `fetch(stubUrl('/status/500'))`. A path must not
 * contain "bugsee" (the iOS SDK drops such requests; campaign-rules).
 */
import { Platform, Settings } from 'react-native';

export const ANDROID_STUB_BASE = 'http://127.0.0.1:8899';

export function stubBase(): string {
  if (Platform.OS === 'ios') {
    const passed: unknown = Settings.get('bugseeE2eStub');
    if (typeof passed === 'string' && /^http:\/\/[\w.-]+:\d+$/.test(passed)) {
      return passed;
    }
  }
  return ANDROID_STUB_BASE;
}

export function stubUrl(path: string): string {
  if (!path.startsWith('/') || /bugsee/i.test(path)) {
    throw new Error(`stubUrl: ${path} must start with "/" and must not contain "bugsee"`);
  }
  return `${stubBase()}${path}`;
}
