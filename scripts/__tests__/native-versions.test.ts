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
