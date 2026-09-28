import type { NativeVersions } from './native-versions';

/**
 * `Log.d("Bugsee", "Bugsee Android SDK " + VERSION_NAME + " [" + BUILD_CHECKSUM + "]")`
 * (`BugseeInternal.java`) -- the one line on Android that proves which build
 * actually launched, rather than which one we asked Gradle to resolve.
 */
const BANNER = /Bugsee Android SDK (\S+) \[([0-9a-f]{7,40})\]/;

export type BannerCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks a captured banner line against the pin, so a device test asserts
 * the SDK that actually launched rather than trusting a human to read the
 * logcat by eye.
 */
export function checkAndroidBanner(
  line: string,
  versions: NativeVersions,
): BannerCheck {
  const match = BANNER.exec(line);
  if (match === null) {
    return { ok: false, reason: `not a Bugsee Android SDK banner line: ${JSON.stringify(line)}` };
  }
  const [, version, sha] = match as unknown as [string, string, string];

  if (version !== versions.android.sdk) {
    return {
      ok: false,
      reason:
        `banner reports version ${version}, but native-versions.json pins ` +
        `android.sdk to ${versions.android.sdk}.`,
    };
  }

  const { snapshotCommit } = versions.android;
  if (snapshotCommit !== undefined && !snapshotCommit.startsWith(sha)) {
    return {
      ok: false,
      reason:
        `banner commit ${sha} does not match the pinned snapshotCommit ` +
        `${snapshotCommit} -- the app did not launch the SDK build this pin ` +
        `claims it did.`,
    };
  }

  return { ok: true };
}
