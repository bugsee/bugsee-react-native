import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The run-once marker the Expo plugin writes carries the package version, so a literal that lags
// the release makes prebuild think an old plugin version ran.
it("the plugin's run-once version is the package version", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
  expect(source).toContain(`createRunOncePlugin(withBugsee, '@bugsee/react-native', '${pkg.version}')`);
});
