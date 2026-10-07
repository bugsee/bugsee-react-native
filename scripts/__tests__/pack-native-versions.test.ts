import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageNativeVersions, unstageNativeVersions } from '../pack-native-versions';

/**
 * prepack copies the repo-root native-versions.json into each package root,
 * where the podspec and the Android build look for it inside an app's
 * node_modules; postpack removes the copy again (BLK-17).
 */
const PINS = '{\n  "android": { "sdk": "7.3.0", "gradlePlugin": "4.0.7" },\n  "ios": { "sdk": "7.0.0-beta5" }\n}\n';

let repo: string;
let pkg: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bugsee-stage-'));
  pkg = join(repo, 'packages', 'react-native');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(repo, 'native-versions.json'), PINS);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@bugsee/react-native' }));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('stageNativeVersions', () => {
  it('copies the root pins into the package byte for byte and returns the path', () => {
    const staged = stageNativeVersions(repo, pkg);

    expect(staged).toBe(join(pkg, 'native-versions.json'));
    expect(readFileSync(staged, 'utf8')).toBe(PINS);
  });

  it('replaces a stale copy left by an earlier pack', () => {
    writeFileSync(join(pkg, 'native-versions.json'), '{"stale":true}');

    stageNativeVersions(repo, pkg);

    expect(readFileSync(join(pkg, 'native-versions.json'), 'utf8')).toBe(PINS);
  });

  it('refuses root pins that are not JSON, and writes nothing', () => {
    writeFileSync(join(repo, 'native-versions.json'), '{ not json');

    expect(() => stageNativeVersions(repo, pkg)).toThrow(/native-versions\.json is not valid JSON/);
    // The parser's own message (where it choked) stays reachable.
    try {
      stageNativeVersions(repo, pkg);
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
    expect.assertions(3);
    expect(existsSync(join(pkg, 'native-versions.json'))).toBe(false);
  });

  it('refuses a directory that is not a @bugsee package', () => {
    expect(() => stageNativeVersions(repo, repo)).toThrow(/not a @bugsee package/);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'other' }));
    expect(() => stageNativeVersions(repo, pkg)).toThrow(/not a @bugsee package/);
    expect(existsSync(join(pkg, 'native-versions.json'))).toBe(false);
  });
});

describe('unstageNativeVersions', () => {
  it('removes the staged copy and says so', () => {
    stageNativeVersions(repo, pkg);

    expect(unstageNativeVersions(pkg)).toBe(true);
    expect(existsSync(join(pkg, 'native-versions.json'))).toBe(false);
  });

  it('is a no-op when nothing is staged', () => {
    expect(unstageNativeVersions(pkg)).toBe(false);
  });

  // Run from the wrong directory it must never take the source of truth with it.
  it('never deletes the repo-root pins', () => {
    expect(() => unstageNativeVersions(repo)).toThrow(/not a @bugsee package/);
    expect(readFileSync(join(repo, 'native-versions.json'), 'utf8')).toBe(PINS);
  });
});
