import { readNativeVersions, type NativeVersions } from '../native-versions';

const valid: NativeVersions = {
  android: { sdk: '7.2.0', gradlePlugin: '4.0.6' },
  ios: { sdk: '7.0.0-beta1', spmUrl: 'https://github.com/bugsee/spm' },
};

describe('readNativeVersions', () => {
  it('exposes the pinned native versions', () => {
    const v = readNativeVersions();
    expect(v.android.sdk).toBe('7.2.0');
    expect(v.android.gradlePlugin).toBe('4.0.6');
    expect(v.ios.sdk).toBe('7.0.0-beta1');
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
});
