import { androidBannerOf, checkAndroidBanner, logcatPid } from '../sdk-banner';
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

describe('the banner of one process', () => {
  const ours = '1760240000.123  4321  4321 D Bugsee  : Bugsee Android SDK 7.3.1 [0aa9ae1ff]';
  const foreign = '1760240000.456  9876  9890 D Bugsee  : Bugsee Android SDK 7.3.0-SNAPSHOT [1234567]';

  it('reads the pid of a logcat -v epoch line', () => {
    expect(logcatPid(ours)).toBe('4321');
    expect(logcatPid(foreign)).toBe('9876');
  });

  it('has no pid for a line in another shape', () => {
    expect(logcatPid('Bugsee Android SDK 7.3.1 [0aa9ae1ff]')).toBeUndefined();
    expect(logcatPid('--------- beginning of main')).toBeUndefined();
    expect(logcatPid('10-12 10:00:00.123  4321  4321 D Bugsee  : x')).toBeUndefined();
  });

  it("matches our process's banner and not another app's", () => {
    expect(androidBannerOf('4321').test(ours)).toBe(true);
    expect(androidBannerOf('9876').test(ours)).toBe(false);
    expect(androidBannerOf('9876').test(foreign)).toBe(true);
  });

  it('matches the pid exactly, not as a prefix or in the thread column', () => {
    expect(androidBannerOf('432').test(ours)).toBe(false);
    expect(androidBannerOf('9890').test(foreign)).toBe(false);
  });

  it('matches only a banner line of that process', () => {
    expect(androidBannerOf('4321').test('1760240000.123  4321  4321 D ReactNativeJS: BUGSEE_E2E scenario=x')).toBe(false);
  });

  it('refuses something that is not a pid', () => {
    expect(() => androidBannerOf('')).toThrow(/not a pid/);
    expect(() => androidBannerOf('.*')).toThrow(/not a pid/);
  });
});
