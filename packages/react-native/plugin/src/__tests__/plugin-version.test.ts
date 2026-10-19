import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The run-once marker the Expo plugin writes carries the package version, so a literal that lags
// the release makes prebuild think an old plugin version ran.
it("the plugin's run-once version is the package version", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  // Expo loads the committed build, which is what the tarball ships and nothing rebuilds at pack time,
  // so the build is checked as well as the source.
  for (const file of [join('..', 'index.ts'), join('..', '..', 'build', 'index.js')]) {
    const text = readFileSync(join(__dirname, file), 'utf8');
    expect(text).toMatch(new RegExp(`createRunOncePlugin\\)?\\(withBugsee, '@bugsee/react-native', '${pkg.version}'\\)`));
  }
});
