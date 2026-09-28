import { readNativeVersions, type NativeVersions } from '../native-versions';

const valid: NativeVersions = {
  android: { sdk: '7.2.0', gradlePlugin: '4.0.7' },
  ios: { sdk: '7.0.0-beta2', spmUrl: 'https://github.com/bugsee/spm' },
};

describe('readNativeVersions', () => {
  it('exposes the pinned native versions', () => {
    const v = readNativeVersions();
    expect(v.android.sdk).toBe('7.3.0-SNAPSHOT');
    expect(v.android.gradlePlugin).toBe('4.0.7');
    expect(v.android.snapshotCommit).toBe('234dcddfcb972da008eeeb0e3ad8757e27ba3e50');
    expect(v.ios.sdk).toBe('7.0.0-beta3');
    expect(v.ios.spmUrl).toBe('https://github.com/bugsee/spm');
  });

  // SwiftPM will not admit a prerelease into a version range, so an iOS pin
  // expressed as a range resolves to nothing at all. Catch it here rather
  // than in a customer's failing `pod install`.
  it.each(['^7.0.0', '~7.0.0', '7.0.0 - 7.1.0', '>=7.0.0', 'latest', ''])(
    'rejects the range-ish iOS pin %p',
    (sdk) => {
      expect(() => readNativeVersions({ ...valid, ios: { ...valid.ios, sdk } }))
        .toThrow(/exact/i);
    },
  );

  it('names the offending key so the failure is actionable', () => {
    expect(() => readNativeVersions({ ...valid, android: { ...valid.android, sdk: '7.x' } }))
      .toThrow(/android\.sdk/);
  });

  // Two-digit components are real (7.10.0, 0.81.10). A regex accepting only
  // single digits would reject them as "not exact".
  it('accepts multi-digit version components', () => {
    expect(() => readNativeVersions({ ...valid, android: { ...valid.android, sdk: '7.10.0' } }))
      .not.toThrow();
    expect(() => readNativeVersions({ ...valid, android: { ...valid.android, sdk: '10.2.30' } }))
      .not.toThrow();
  });

  // The message is the whole product of a CI failure: it has to say what is
  // wrong and why the rule exists, or the next person just loosens the regex.
  it('explains why a range cannot work, not merely that it failed', () => {
    expect(() => readNativeVersions({ ...valid, ios: { ...valid.ios, sdk: '^7.0.0' } }))
      .toThrow(/SwiftPM will not resolve a prerelease/);
    expect(() => readNativeVersions({ ...valid, ios: { ...valid.ios, sdk: '^7.0.0' } }))
      .toThrow(/7\.0\.0-beta1/);
  });

  it('accepts a prerelease, which the iOS pin currently is', () => {
    expect(() => readNativeVersions({ ...valid, ios: { ...valid.ios, sdk: '8.0.0-rc.2' } }))
      .not.toThrow();
  });

  // spmUrl is a URL, not a version; validating it as one would be wrong.
  it('does not version-check spmUrl', () => {
    expect(() => readNativeVersions({ ...valid, ios: { ...valid.ios, spmUrl: 'https://example.com/x' } }))
      .not.toThrow();
  });

  describe('android.snapshotCommit', () => {
    const snapshotCommit = '234dcddfcb972da008eeeb0e3ad8757e27ba3e50';

    it('pins Android 7.3.0-SNAPSHOT with the commit it was built from', () => {
      const v = readNativeVersions({
        ...valid,
        android: { ...valid.android, sdk: '7.3.0-SNAPSHOT', snapshotCommit },
      });
      expect(v.android.sdk).toBe('7.3.0-SNAPSHOT');
      expect(v.android.snapshotCommit).toBe(snapshotCommit);
    });

    it('rejects a SNAPSHOT pin without snapshotCommit', () => {
      expect(() =>
        readNativeVersions({ ...valid, android: { ...valid.android, sdk: '7.3.0-SNAPSHOT' } }),
      ).toThrow(
        'native-versions.android.snapshotCommit is required when android.sdk ' +
          'is a SNAPSHOT (got "7.3.0-SNAPSHOT"), so the pin can always be ' +
          'traced back to the clone it was built from.',
      );
    });

    it('rejects snapshotCommit on a release pin', () => {
      expect(() =>
        readNativeVersions({
          ...valid,
          android: { ...valid.android, sdk: '7.3.0', snapshotCommit },
        }),
      ).toThrow(
        `native-versions.android.snapshotCommit is set ("${snapshotCommit}") ` +
          'but android.sdk ("7.3.0") is not a SNAPSHOT. A released ' +
          'version carries no snapshot provenance; remove the field.',
      );
    });

    it.each([
      '234dcdd', // short: the banner's 7-char form, not the full SHA
      `${snapshotCommit}f`, // 41 hex chars: the FIRST 40 are valid, so this
      // would pass a regex missing its trailing $ anchor
      `x${snapshotCommit}`, // 41 chars: 'x' + a full valid SHA -- the LAST 40
      // are valid hex, so this would pass a regex missing its leading ^ anchor
      'ZZZZdddfcb972da008eeeb0e3ad8757e27ba3e50', // 40 chars, non-hex
      '',
    ])(
      'rejects a short or non-hex snapshotCommit %p',
      (bad) => {
        expect(() =>
          readNativeVersions({
            ...valid,
            android: { ...valid.android, sdk: '7.3.0-SNAPSHOT', snapshotCommit: bad },
          }),
        ).toThrow(/android\.snapshotCommit must be a full 40-character hex/);
      },
    );

    it('names the rejected value in full', () => {
      expect(() =>
        readNativeVersions({
          ...valid,
          android: { ...valid.android, sdk: '7.3.0-SNAPSHOT', snapshotCommit: '234dcdd' },
        }),
      ).toThrow(
        'native-versions.android.snapshotCommit must be a full 40-character hex ' +
          'commit SHA, got "234dcdd".',
      );
    });
  });
});
