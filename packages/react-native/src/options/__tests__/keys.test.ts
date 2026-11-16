import {
  ANDROID_ONLY_KEYS,
  RN_OPTION_KEYS,
  IOS_ONLY_KEYS,
  SHARED_KEYS,
  keysFor,
} from '../keys';

describe('the extracted key surface', () => {
  it('has a non-trivial shared set, which is the premise of the design', () => {
    // If this collapses, the extractor missed a source rather than the SDKs
    // having diverged -- the 7.x design note is that both accept one
    // namespace, and a wrapper with no shared keys would be a translation
    // layer again.
    expect(SHARED_KEYS.length).toBeGreaterThan(40);
  });

  it('puts every key in exactly one bucket', () => {
    const all = [...SHARED_KEYS, ...IOS_ONLY_KEYS, ...ANDROID_ONLY_KEYS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('namespaces every key', () => {
    for (const key of [...SHARED_KEYS, ...IOS_ONLY_KEYS, ...ANDROID_ONLY_KEYS]) {
      expect(key).toMatch(/^com\.bugsee\.option\./);
    }
  });

  it('accepts a platform-specific key only for its own platform', () => {
    const ios = keysFor('ios');
    const android = keysFor('android');
    for (const key of IOS_ONLY_KEYS) {
      expect(ios.has(key)).toBe(true);
      expect(android.has(key)).toBe(false);
    }
    for (const key of ANDROID_ONLY_KEYS) {
      expect(android.has(key)).toBe(true);
      expect(ios.has(key)).toBe(false);
    }
  });

  it('accepts every shared key on both', () => {
    for (const key of SHARED_KEYS) {
      expect(keysFor('ios').has(key)).toBe(true);
      expect(keysFor('android').has(key)).toBe(true);
    }
  });
});

describe('options the wrapper defines for itself', () => {
  it('are accepted on both platforms, so the unknown-key warning stays quiet for them', () => {
    for (const key of RN_OPTION_KEYS) {
      expect(keysFor('ios').has(key)).toBe(true);
      expect(keysFor('android').has(key)).toBe(true);
    }
  });

  it('never collide with a key an SDK registers', () => {
    const sdk = new Set([...SHARED_KEYS, ...IOS_ONLY_KEYS, ...ANDROID_ONLY_KEYS]);
    expect(RN_OPTION_KEYS.filter((key) => sdk.has(key))).toEqual([]);
  });
});
