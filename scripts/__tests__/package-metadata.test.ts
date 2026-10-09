import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * npm publishes README.md and LICENSE from a package root whatever `files`
 * says. The vendored XCFramework archive carries the iOS SDK's own README and
 * LICENSE beside `Bugsee.xcframework/`, and extracting the whole archive into
 * this package overwrote both — so it shipped the SDK's CocoaPods
 * instructions as its README and PLCrashReporter's licence as its licence,
 * silently rewritten on every SDK bump.
 *
 * The podspec now extracts only `Bugsee.xcframework/*`. These assert the
 * result, because the next person to write an unzip will not read the
 * podspec's comment.
 */
const pkg = join(__dirname, '..', '..', 'packages', 'react-native');
const read = (name: string) => readFileSync(join(pkg, name), 'utf8');

describe('the published README is this package', () => {
  it('names the npm package', () => {
    expect(read('README.md')).toMatch(/@bugsee\/react-native/);
  });

  it('is not the iOS SDK README', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/binary "https:\/\/download\.bugsee\.com/);
    expect(readme).not.toMatch(/carthage update/i);
  });

  it('states the requirements a consumer needs', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/0\.81/);
    expect(readme).toMatch(/15\.0/);
    expect(readme).toMatch(/API 21/);
  });
});

describe('the published LICENSE is this package', () => {
  it('is not a third-party licence from inside the SDK archive', () => {
    expect(read('LICENSE')).not.toMatch(/PLCrashReporter/);
  });

  it('matches the repository licence', () => {
    expect(read('LICENSE')).toBe(
      readFileSync(join(__dirname, '..', '..', 'LICENSE'), 'utf8'),
    );
  });
});

describe('the vendoring step', () => {
  // The cause, not just the symptom: an unscoped extract puts every top-level
  // entry of the archive into the package root.
  it('extracts only the framework from the archive', () => {
    const podspec = read('BugseeReactNative.podspec');
    expect(podspec).toMatch(/unzip[^\n]*'Bugsee\.xcframework\/\*'/);
  });
});

describe('the release guard', () => {
  // The repo pins yarn 4. `yarn npm publish` runs `prepublish` then `prepack`
  // and never `prepublishOnly`; a tarball from `yarn pack`/`npm pack` skips
  // `prepublishOnly` too. `prepack` is the one hook all four run.
  const scripts = (
    JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
  ).scripts ?? {};

  // First, and chained with &&: a refused pin stops the pack before anything
  // is staged (prepack also stages native-versions.json, BLK-17).
  it('runs on prepack, before anything else', () => {
    expect(scripts.prepack).toBe(
      'node ../../scripts/cli-check-releasable-pins.ts && node ../../scripts/cli-pack-native-versions.ts stage',
    );
  });

  it('removes the staged native-versions.json on postpack', () => {
    expect(scripts.postpack).toBe('node ../../scripts/cli-pack-native-versions.ts unstage');
  });

  it('is not left on a hook yarn 4 never runs', () => {
    expect(scripts.prepublishOnly ?? '').not.toMatch(/releasable-pins/);
  });
});

describe('the README integration steps', () => {
  const readme = read('README.md');
  const versions = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'native-versions.json'), 'utf8'),
  ) as { android: { gradlePlugin: string } };

  // A `plugins {}` block cannot read a file, so the README states the pin as
  // a literal; it must be the one the package is built against.
  it('pins the Bugsee Gradle plugin at native-versions.json android.gradlePlugin', () => {
    const pins = [...readme.matchAll(/id 'com\.bugsee\.android\.gradle' version '([^']+)'/g)].map((m) => m[1]);
    expect(pins).toEqual([versions.android.gradlePlugin]);
  });

  // R-1: `serialize` is static; `options.serialize()` was a TypeError.
  it('serializes launch options with the static form', () => {
    expect(readme).toMatch(/BugseeLaunchOptions\.serialize\(options\)/);
    expect(readme).not.toMatch(/options\.serialize\(\)/);
  });

  it('documents the iOS bundle phase through bugsee-xcode.sh', () => {
    expect(readme).toMatch(/node_modules\/@bugsee\/react-native\/scripts\/bugsee-xcode\.sh/);
  });
});
