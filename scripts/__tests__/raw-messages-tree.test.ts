import { join } from 'node:path';

import { scanPackages, type Violation } from '../raw-messages';

/**
 * The shipped trees, scanned by `scripts/raw-messages.ts` (its doc comment
 * states the rules and the gaps). `scanPackages` reads each package's own
 * `files` list, so a newly shipped directory or package is covered -- or
 * refused -- without editing this file. Not scanned: `examples/**` (not
 * shipped), and each package's `plugin/` and build `scripts/`, which run on
 * the developer's machine at build time -- they never execute in the app, the
 * SDK never captures their output, and what they print is build
 * configuration (app.json values, paths in the project), not user data.
 */
const repo = join(__dirname, '..', '..');

const scan = scanPackages(join(repo, 'packages'), repo);

const describeViolations = (violations: Violation[]): string =>
  violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.snippet}`).join('\n');

describe('the shipped packages carry no raw exception message or user value', () => {
  it('covers all of android/, ios/ and src/ of both packages', () => {
    expect(scan.roots).toEqual([
      'packages/react-native/src',
      'packages/react-native/android',
      'packages/react-native/ios',
      'packages/react-native-feedback/src',
      'packages/react-native-feedback/android',
      'packages/react-native-feedback/ios',
    ]);
  });

  it('has no source in a language the scanner does not understand, and no unscanned shipped directory', () => {
    expect(scan.refused).toEqual([]);
  });

  it('scans clean', () => {
    expect(describeViolations(scan.violations)).toBe('');
  });
});
