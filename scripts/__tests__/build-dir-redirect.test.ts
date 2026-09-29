import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  OLD_SHARED_BUILD_OUTPUT,
  REDIRECTED_PROJECT_PATH,
  findOldBuildPathReferences,
  redirectsStandaloneBuildDir,
} from '../build-dir-redirect';

const repoRoot = join(__dirname, '..', '..');

// This file and the module it tests are exempt: `build-dir-redirect.ts` must
// spell the offending literal out once, to search for it, and this file
// names it too, in fixtures and in this very sentence. Nothing else tracked
// gets a pass.
const SELF = ['scripts/build-dir-redirect.ts', 'scripts/__tests__/build-dir-redirect.test.ts'];

// Every tracked script or CI file that could hardcode a Gradle build-output
// path. Matches the brief's own list of what to check (scripts, CI steps) --
// deliberately not `**/*.md`: docs are handled by review, not by this guard,
// and the design doc/plan narrate this very defect in prose.
const SCANNED_GLOBS = [/^scripts\/.*\.(ts|js|sh)$/, /^\.github\/workflows\/.*\.ya?ml$/];

function trackedScriptAndCiFiles(): Record<string, string> {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => SCANNED_GLOBS.some((re) => re.test(file)))
    .filter((file) => !SELF.includes(file));
  return Object.fromEntries(tracked.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
}

// Stryker's sandbox doesn't copy `.git`, and its ignorePatterns already drop
// `examples/` from the copy -- `git ls-files` (or reading a path it excluded)
// would throw there for reasons that have nothing to do with a mutant. Same
// convention as maven-local.test.ts: skip the real-repo assertions inside the
// sandbox, and let the fixture suites below judge the mutants.
const inStrykerSandbox = __dirname.includes(`${sep}.stryker-tmp${sep}`);

(inStrykerSandbox ? describe.skip : describe)('the real repo', () => {
  it('settings.gradle redirects the standalone build directory', () => {
    const settingsGradle = readFileSync(join(repoRoot, 'settings.gradle'), 'utf8');
    expect(redirectsStandaloneBuildDir(settingsGradle)).toBe(true);
  });

  it('no tracked script or CI file references the old shared build-output path', () => {
    expect(findOldBuildPathReferences(trackedScriptAndCiFiles())).toEqual([]);
  });
});

describe('redirectsStandaloneBuildDir', () => {
  it('accepts a beforeProject hook that sets layout.buildDirectory for the right project', () => {
    const settings = `
include '${REDIRECTED_PROJECT_PATH}'
gradle.beforeProject { project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/android-bridge'))
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(true);
  });

  it('rejects settings.gradle with no redirect at all', () => {
    expect(redirectsStandaloneBuildDir(`include '${REDIRECTED_PROJECT_PATH}'\n`)).toBe(false);
  });

  it('rejects a hook that names some other project', () => {
    const settings = `
gradle.beforeProject { project ->
    if (project.path == ':some-other-module') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/other'))
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(false);
  });

  it('rejects a hook for the right project that never touches buildDirectory', () => {
    const settings = `
gradle.beforeProject { project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        println 'hi'
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(false);
  });

  it('rejects a hook that names the right project and sets layout.buildDirectory, but also assigns the deprecated buildDir property', () => {
    const settings = `
gradle.beforeProject { project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/android-bridge'))
        project.buildDir = new File(settingsDir, 'build/android-bridge')
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(false);
  });

  // Whitespace variants around `buildDir =`, exercised against a hook that
  // otherwise looks correct (names the project, sets layout.buildDirectory),
  // so a mutated width for the whitespace between `buildDir` and `=` is the
  // only thing that could flip the result.
  it('rejects buildDir = with no space before the equals', () => {
    const settings = `
gradle.beforeProject { project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/android-bridge'))
        project.buildDir= new File(settingsDir, 'build/android-bridge')
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(false);
  });

  it('rejects buildDir  = with more than one space before the equals', () => {
    const settings = `
gradle.beforeProject { project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/android-bridge'))
        project.buildDir  = new File(settingsDir, 'build/android-bridge')
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(false);
  });

  // The hook-matching regex must not require exactly one space before the
  // opening brace: real Gradle files are hand-formatted, and beforeProject's
  // own body sits right after the brace with none.
  it('matches a beforeProject hook with no space before the opening brace', () => {
    const settings = `
gradle.beforeProject{ project ->
    if (project.path == '${REDIRECTED_PROJECT_PATH}') {
        project.layout.buildDirectory.set(new File(settingsDir, 'build/android-bridge'))
    }
}
`;
    expect(redirectsStandaloneBuildDir(settings)).toBe(true);
  });
});

describe('OLD_SHARED_BUILD_OUTPUT', () => {
  // Pinned to the literal, not just exercised through the checker: the
  // checker builds its own fixtures out of this same constant, so a mutant
  // that corrupts how the constant is assembled (e.g. a joined-in stray
  // literal) would otherwise cancel out against itself and still pass.
  it('is exactly the module directory\'s own default build output', () => {
    expect(OLD_SHARED_BUILD_OUTPUT).toBe('packages/react-native/android/build/');
  });
});

describe('findOldBuildPathReferences', () => {
  it('flags a file that hardcodes the old shared output directory', () => {
    expect(
      findOldBuildPathReferences({ 'scripts/x.ts': `const p = '${OLD_SHARED_BUILD_OUTPUT}generated';` }),
    ).toEqual(['scripts/x.ts']);
  });

  it('names every offending file, not just the first', () => {
    expect(
      findOldBuildPathReferences({
        'scripts/a.ts': OLD_SHARED_BUILD_OUTPUT,
        'scripts/b.sh': `cat ${OLD_SHARED_BUILD_OUTPUT}test-results/foo.xml`,
      }),
    ).toEqual(['scripts/a.ts', 'scripts/b.sh']);
  });

  it('ignores files that never mention the old path', () => {
    expect(
      findOldBuildPathReferences({
        'scripts/clean.ts': "const p = 'build/android-bridge';",
        // The .gradle *source* file, not its build output, is fine to name.
        'scripts/other.ts': "const p = 'packages/react-native/android/build.gradle';",
      }),
    ).toEqual([]);
  });
});
