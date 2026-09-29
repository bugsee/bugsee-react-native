import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import rawManifest from '../../packages/react-native/src/options/android-options-manifest.json';
import type { OptionsManifest } from '../option-keys';
import enumFixture from '../../packages/react-native/src/options/option-enums.json';
import { readNativeVersions } from '../native-versions';
import { ANDROID_ONLY_KEYS, SHARED_KEYS } from '../../packages/react-native/src/options/keys';

/**
 * The option-manifest parity gate (plan Task 2.7).
 *
 * `bugsee/specs` sdk/options/ now defines `options-manifest.json`, but its
 * status is still "Proposed — no SDK publishes a manifest yet", so this reads
 * a committed manifest generated from the Android SDK sources in exactly that
 * shape. When a manifest is published at
 * https://download.bugsee.com/sdk/options/android/<version>.json, swapping to
 * it is a change of SOURCE, not of format, and these assertions stand.
 */
const repo = join(__dirname, '..', '..');
const bridge = readFileSync(
  join(repo, 'packages/react-native/android/src/main/java/com/bugsee/reactnative/BugseeOptionEnums.java'),
  'utf8',
);

// The JSON import widens `type` to string and drops the optional enum shape;
// the manifest's own interface is what the rest of this file reads against.
const manifest = rawManifest as unknown as OptionsManifest;
const byKey = new Map(manifest.options.map((o) => [o.key, o]));

describe('the manifest describes the SDK we actually target', () => {
  // Bumping the SDK without regenerating leaves the wrapper checking itself
  // against a previous version's option surface — which is worse than no
  // check, because it looks like one.
  it('was generated for the pinned Android SDK version', () => {
    expect(manifest.sdkVersion).toBe(readNativeVersions().android.sdk);
  });

  it('is the manifest format this test understands', () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.sdk).toBe('android');
  });

  // Some defaults are configuration-dependent; the spec requires recording
  // which build they were read from.
  it('records the build configuration its defaults came from', () => {
    expect(manifest.buildConfiguration).toBe('release');
  });

  // Regression: 7.3.0-SNAPSHOT deprecated this option (registers it through
  // OptionDescriptor.createAndRegisterDeprecated rather than
  // createAndRegister), and a regenerated manifest silently dropped it --
  // the extractor's registration pattern did not recognise the deprecated
  // call. It is still live on the pinned SDK and must stay in the committed
  // fixture, carrying the deprecation per the spec's `{ since }` shape.
  it('keeps a deprecated-but-still-registered option, with its deprecation', () => {
    const option = byKey.get('com.bugsee.option.capture.webview.domain-allowlist');
    expect(option).toEqual({
      key: 'com.bugsee.option.capture.webview.domain-allowlist',
      type: 'string',
      default: '',
      module: 'bugsee-android',
      hidden: false,
      deprecated: { since: '7.1.2' },
    });
  });
});

describe('every enum-typed option can be coerced', () => {
  const manifestEnumKeys = manifest.options
    .filter((o) => o.type === 'enum')
    .map((o) => o.key);

  it('finds enum options to check', () => {
    expect(manifestEnumKeys.length).toBeGreaterThan(0);
  });

  // The Android SDK's Map path does not coerce, so an enum-typed option with
  // no table entry is silently ignored: the app sets it, launch succeeds, and
  // the setting never applies.
  it.each(manifestEnumKeys)('%s has a bridge table entry', (key) => {
    expect(bridge).toContain(`"${key}"`);
  });
});

describe('the TypeScript enum values match the manifest', () => {
  const manifestEnums = manifest.options
    .map((o) => o.enum)
    .filter((e): e is NonNullable<typeof e> => e !== undefined);

  it.each([...new Map(manifestEnums.map((e) => [e.name, e])).values()])(
    '$name',
    (declared) => {
      const ours = (enumFixture as Record<string, Record<string, number>>)[
        declared.name
      ];
      expect(ours).toBeDefined();
      expect(ours).toEqual(declared.values);
    },
  );

  // The spec is explicit that enum.values carries the internal value, never
  // the ordinal, and this is where that would show up as a mismatch.
  it('uses internal values, so LogLevel.Error is 1 at position 0', () => {
    const logLevel = manifestEnums.find((e) => e.name === 'LogLevel');
    expect(logLevel?.values.Error).toBe(1);
    expect(Object.keys(logLevel?.values ?? {})[0]).toBe('Error');
  });
});

describe('every key the wrapper writes is one the SDK registers', () => {
  const ANDROID_ACCESSOR_KEYS = [
    'com.bugsee.option.capture.logs',
    'com.bugsee.option.capture.logs.level',
    'com.bugsee.option.capture.network',
    'com.bugsee.option.capture.breadcrumbs',
    'com.bugsee.option.capture.video',
    'com.bugsee.option.detect.crash',
    'com.bugsee.option.detect.hang',
    'com.bugsee.option.config.wifi-only-upload',
    'com.bugsee.option.config.duration',
    'com.bugsee.option.capture.video.mode',
    'com.bugsee.option.capture.logs.allsources',
    'com.bugsee.option.detect.exit.low_memory',
    'com.bugsee.option.reporting.triggers.notification-bar',
    'com.bugsee.option.$$ENDPOINT',
    // Added in Android 7.3.0.
    'com.bugsee.option.config.max-data-size',
    'com.bugsee.option.config.max-pending-reports',
    'com.bugsee.option.config.max-pending-report-age',
    'com.bugsee.option.detect.exit.bg_low_memory_as_error',
  ];

  it.each(ANDROID_ACCESSOR_KEYS)('%s is registered', (key) => {
    expect(byKey.has(key)).toBe(true);
  });

  it('agrees on the type of a key the wrapper types as a number', () => {
    expect(byKey.get('com.bugsee.option.config.duration')?.type).toBe('int');
    expect(byKey.get('com.bugsee.option.capture.video.mode')?.type).toBe('enum');
    expect(byKey.get('com.bugsee.option.config.max-data-size')?.type).toBe('int');
    expect(byKey.get('com.bugsee.option.config.max-pending-reports')?.type).toBe('int');
    expect(byKey.get('com.bugsee.option.config.max-pending-report-age')?.type).toBe('int');
  });

  it('agrees on the type of a key the wrapper types as a boolean', () => {
    expect(byKey.get('com.bugsee.option.capture.logs')?.type).toBe('boolean');
    expect(byKey.get('com.bugsee.option.detect.exit.bg_low_memory_as_error')?.type).toBe('boolean');
  });

  // $$ENDPOINT is an internal option; the manifest says so, and that is why
  // it is not in the declared key fixture.
  it('marks the endpoint override hidden', () => {
    expect(byKey.get('com.bugsee.option.$$ENDPOINT')?.hidden).toBe(true);
  });
});

// Task 3.P4: the key fixture (option-keys.json) and the manifest are read
// from different Android files -- the Options interface and
// OptionsDescriptors -- so a key one of them misses is dropped silently: the
// platform guard then treats a registered option as one Android never agreed
// to. Both must describe the same Android surface.
describe('the key fixture and the manifest agree on Android', () => {
  const fixture = new Set([...SHARED_KEYS, ...ANDROID_ONLY_KEYS]);

  it('every public option the SDK registers is in the key fixture', () => {
    const missing = manifest.options
      .filter((o) => !o.hidden && !fixture.has(o.key))
      .map((o) => o.key);
    expect(missing).toEqual([]);
  });

  it('every Android key in the fixture is registered', () => {
    expect([...fixture].filter((key) => !byKey.has(key))).toEqual([]);
  });

  // The hidden ones are internals, registered by literal rather than
  // declared, which is why the fixture cannot see them. Named, so a new one
  // is looked at rather than waved through.
  it('the only options outside the fixture are the known hidden internals', () => {
    expect(
      manifest.options.filter((o) => !fixture.has(o.key)).map((o) => [o.key, o.hidden]),
    ).toEqual([
      ['com.bugsee.option.$$DEBUG', true],
      ['com.bugsee.option.$$ENDPOINT', true],
      ['com.bugsee.option.$$WRAPPER', true],
    ]);
  });
});
