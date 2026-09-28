import type { NativeVersions } from './native-versions';

/**
 * `Package.resolved`'s placeholder revision for a pin that has never been
 * resolved against a real commit -- see 3.P2. A release must not ship it.
 */
const PLACEHOLDER_REVISION = '0'.repeat(40);

interface PackageResolved {
  pins: readonly {
    identity: string;
    state?: { revision?: string };
  }[];
}

/**
 * Every reason `native-versions.json`, as it stands, must not be released.
 * Empty means releasable. Each line is meant to be read by a human staring at
 * a failed `npm publish`, so it names the offending value, not just "invalid".
 */
export function releaseBlockers(
  versions: NativeVersions,
  supportPackageResolved: string,
): string[] {
  const blockers: string[] = [];

  // Generic: whichever pin holds a SNAPSHOT, wherever a future platform adds
  // one, this catches it without needing to be told the key's name.
  for (const [platform, group] of Object.entries(versions)) {
    for (const [key, value] of Object.entries(group as Record<string, string>)) {
      if (typeof value === 'string' && value.endsWith('-SNAPSHOT')) {
        blockers.push(
          `${platform}.${key} is pinned to ${value}, a local SNAPSHOT build -- ` +
            `not a released Bugsee SDK.`,
        );
      }
    }
  }

  if (versions.android.snapshotCommit !== undefined) {
    blockers.push(
      `android.snapshotCommit (${versions.android.snapshotCommit}) is set. ` +
        `It only has meaning while android.sdk is a SNAPSHOT built from that ` +
        `commit; a release must not carry it.`,
    );
  }

  const resolved = JSON.parse(supportPackageResolved) as PackageResolved;
  const spmPin = resolved.pins.find((pin) => pin.identity === 'spm');
  if (spmPin?.state?.revision === PLACEHOLDER_REVISION) {
    blockers.push(
      `ios/Support/Package.resolved pins spm to the placeholder revision ` +
        `${PLACEHOLDER_REVISION}, not a commit that was actually resolved.`,
    );
  }

  return blockers;
}
