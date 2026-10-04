import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scannerFor, walk, type Violation } from '../raw-messages';

/**
 * The shipped trees, scanned by `scripts/raw-messages.ts` (its doc comment
 * states the rules and the gaps). Every package under `packages/` is covered
 * through its `android/src/main/java`, `ios` and `src` roots, so a new
 * package is scanned without editing this file. Not scanned: `examples/**`
 * (not shipped), and each package's `plugin/` and build `scripts/`, which run
 * on the developer's machine at build time -- they never execute in the app,
 * the SDK never captures their output, and what they print is build
 * configuration (app.json values, paths in the project), not user data.
 */
const repo = join(__dirname, '..', '..');
const packagesDir = join(repo, 'packages');

const ROOT_KINDS = [join('android', 'src', 'main', 'java'), 'ios', 'src'];

const roots = readdirSync(packagesDir)
  .flatMap((pkg) => ROOT_KINDS.map((kind) => join(packagesDir, pkg, kind)))
  .filter((dir) => existsSync(dir));

const files = roots.flatMap((root) => walk(root));

const describeViolations = (violations: Violation[]): string =>
  violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.snippet}`).join('\n');

describe('the shipped packages carry no raw exception message or user value', () => {
  it('covers both packages on every platform', () => {
    const covered = roots.map((root) => relative(repo, root)).sort();
    expect(covered).toEqual([
      'packages/react-native-feedback/android/src/main/java',
      'packages/react-native-feedback/ios',
      'packages/react-native-feedback/src',
      'packages/react-native/android/src/main/java',
      'packages/react-native/ios',
      'packages/react-native/src',
    ]);
  });

  it('has no source in a language the scanner does not understand', () => {
    const refused = files
      .map((file) => [relative(repo, file), scannerFor(file)] as const)
      .filter(([, scanner]) => typeof scanner === 'string')
      .map(([file, why]) => `${file}: ${String(why)}`);
    expect(refused).toEqual([]);
  });

  it('scans clean', () => {
    const violations = files.flatMap((file) => {
      const scanner = scannerFor(file);
      return typeof scanner === 'function' ? scanner(relative(repo, file), readFileSync(file, 'utf8')) : [];
    });
    expect(describeViolations(violations)).toBe('');
  });
});
