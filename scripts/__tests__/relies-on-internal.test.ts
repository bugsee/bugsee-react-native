import { RELIES_ON_INTERNAL } from '../../packages/react-native/src/options/noAccessor';
import androidManifest from '../../packages/react-native/src/options/android-options-manifest.json';
import iosManifest from '../../packages/react-native/src/options/ios-options-manifest.json';

/**
 * The internal options the package's code depends on must be real, current ones: an entry for an option
 * no pinned SDK registers would silence nothing and mislead whoever reads the list.
 */
describe('RELIES_ON_INTERNAL', () => {
  const hidden = (options: { key: string; hidden?: boolean }[]): Set<string> =>
    new Set(options.filter((option) => option.hidden === true).map((option) => option.key));

  it.each(Object.keys(RELIES_ON_INTERNAL))('%s is an internal option of both pinned SDKs', (key) => {
    expect(hidden(androidManifest.options).has(key)).toBe(true);
    expect(hidden(iosManifest.options).has(key)).toBe(true);
  });

  it('gives every entry a reason', () => {
    for (const reason of Object.values(RELIES_ON_INTERNAL)) {
      expect(reason.trim()).not.toBe('');
    }
  });
});
