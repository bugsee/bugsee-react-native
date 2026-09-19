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
