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

/**
 * The pid of a `logcat -v epoch` line (`<sec>.<ms> <pid> <tid> <level> <tag>: ...`),
 * or undefined for a line in any other shape.
 */
export function logcatPid(line: string): string | undefined {
  return /^\s*\d+\.\d+\s+(\d+)\s+\d+\s+[VDIWEFS]\s/.exec(line)?.[1];
}

/**
 * The banner printed by process `pid` only, in `logcat -v epoch` form. Any
 * other app on the device that embeds the SDK prints the same banner with its
 * own version; matching it would check that app's build, not ours.
 */
export function androidBannerOf(pid: string): RegExp {
  if (!/^\d+$/.test(pid)) {
    throw new Error(`not a pid: ${JSON.stringify(pid)}`);
  }
  return new RegExp(`^\\s*\\d+\\.\\d+\\s+${pid}\\s+\\d+\\s+[VDIWEFS]\\s.*${BANNER.source}`);
}
