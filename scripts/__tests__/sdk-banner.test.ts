import { checkAndroidBanner } from '../sdk-banner';
import type { NativeVersions } from '../native-versions';

const snapshotCommit = '234dcddfcb972da008eeeb0e3ad8757e27ba3e50';

const snapshotPinned: NativeVersions = {
  android: { sdk: '7.3.0-SNAPSHOT', gradlePlugin: '4.0.7', snapshotCommit },
  ios: { sdk: '7.0.0-beta2', spmUrl: 'https://github.com/bugsee/spm' },
};

const releasePinned: NativeVersions = {
  android: { sdk: '7.3.0', gradlePlugin: '4.0.7' },
  ios: { sdk: '7.0.0-beta2', spmUrl: 'https://github.com/bugsee/spm' },
};

describe('checkAndroidBanner', () => {
  it('accepts the SNAPSHOT banner whose SHA prefixes snapshotCommit', () => {
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0-SNAPSHOT [234dcdd]';
    expect(checkAndroidBanner(line, snapshotPinned)).toEqual({ ok: true });
  });

  // No snapshotCommit to compare against on a release pin: the sha in the
  // banner is irrelevant, and a version match alone is ok.
  it('accepts a release banner whatever the sha is, since there is no snapshotCommit to check', () => {
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0 [ffffffffffffffffffffffffffffffffffffffff]';
    expect(checkAndroidBanner(line, releasePinned)).toEqual({ ok: true });
  });

  it('rejects a banner from a different commit, naming both SHAs', () => {
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0-SNAPSHOT [aaaaaaa]';
    const result = checkAndroidBanner(line, snapshotPinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(
      'banner commit aaaaaaa does not match the pinned snapshotCommit ' +
        `${snapshotCommit} -- the app did not launch the SDK build this pin ` +
        'claims it did.',
    );
  });

  // A published build outranked the local one: mavenLocal's content filter is
  // supposed to make this impossible, but the harness must not merely assume
  // that -- it has to notice if the wrong artifact still launched.
  it('rejects 7.3.0 when 7.3.0-SNAPSHOT is pinned', () => {
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0 [234dcdd]';
    const result = checkAndroidBanner(line, snapshotPinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(
      'banner reports version 7.3.0, but native-versions.json pins ' +
        'android.sdk to 7.3.0-SNAPSHOT.',
    );
  });

  // Stale mavenLocal leaked in: the pin says release, but a SNAPSHOT that
  // happens to share a version prefix in ~/.m2 actually launched.
  it('rejects 7.3.0-SNAPSHOT when 7.3.0 is pinned', () => {
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0-SNAPSHOT [234dcdd]';
    const result = checkAndroidBanner(line, releasePinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(
      'banner reports version 7.3.0-SNAPSHOT, but native-versions.json pins ' +
        'android.sdk to 7.3.0.',
    );
  });

  it('rejects a line that is not the banner', () => {
    const result = checkAndroidBanner('I/ReactNativeJS: BUGSEE_E2E launching on android', snapshotPinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(
      'not a Bugsee Android SDK banner line: "I/ReactNativeJS: BUGSEE_E2E launching on android"',
    );
  });

  // Pins down the two capture groups' shapes, so a loosened or narrowed
  // regex (matching a single character, or the wrong character class) is
  // caught rather than merely happening to still match these fixtures.
  it('requires the version to be more than a single character', () => {
    // If the version group matched only one character, this would still
    // "match" with version="7" and status trailing on into an unrelated
    // capture -- assert the whole line is read, not a prefix of it.
    const line = 'D/Bugsee: Bugsee Android SDK 7.3.0-SNAPSHOT [234dcdd]';
    const result = checkAndroidBanner(line, snapshotPinned);
    expect(result).toEqual({ ok: true });
    // A one-character version group could never equal the full pinned
    // string, so confirm a banner whose version genuinely is one character
    // is rejected by name, not silently coerced into matching.
    const shortVersionLine = 'D/Bugsee: Bugsee Android SDK 7 [234dcdd]';
    const shortResult = checkAndroidBanner(shortVersionLine, snapshotPinned);
    expect(shortResult).toEqual({
      ok: false,
      reason:
        'banner reports version 7, but native-versions.json pins android.sdk to 7.3.0-SNAPSHOT.',
    });
  });

  it('does not match a sha made only of non-hex characters', () => {
    const result = checkAndroidBanner(
      'D/Bugsee: Bugsee Android SDK 7.3.0-SNAPSHOT [ZZZZZZZ]',
      snapshotPinned,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/not a Bugsee Android SDK banner/);
  });
});
