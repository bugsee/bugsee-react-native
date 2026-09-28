import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  CONTENT_FILTER,
  MAVEN_LOCAL_FILES,
  mavenLocalBody,
  mavenLocalOffsets,
  mavenLocalProblems,
  stripComments,
} from '../maven-local';
import { readNativeVersions } from '../native-versions';

const repoRoot = join(__dirname, '..', '..');

function trackedFiles(): Record<string, string> {
  return Object.fromEntries(
    MAVEN_LOCAL_FILES.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]),
  );
}

// Stryker's sandbox leaves examples/ out (stryker.scripts.json
// ignorePatterns), and its findRelatedTests picks this file up because it
// imports the checker. There, only the fixture suites below run -- they are
// what the checker's mutants are judged against.
const inStrykerSandbox = __dirname.includes(`${sep}.stryker-tmp${sep}`);

(inStrykerSandbox ? describe.skip : describe)('the tracked Gradle files, against the pinned Android SDK', () => {
  const sdk = readNativeVersions().android.sdk;
  // Read inside the test, not the describe body: a skipped describe's body
  // still runs.
  const occurrencesIn = (files: Record<string, string>) =>
    Object.values(files).reduce(
      (n, source) => n + mavenLocalOffsets(stripComments(source)).length,
      0,
    );

  if (sdk.endsWith('-SNAPSHOT')) {
    it(`${sdk} is a SNAPSHOT: mavenLocal is present, and every one is guarded and filtered`, () => {
      const files = trackedFiles();
      expect(occurrencesIn(files)).toBeGreaterThan(0);
      expect(mavenLocalProblems(sdk, files)).toEqual([]);
    });
  } else {
    it(`${sdk} is released: no tracked Gradle file mentions mavenLocal`, () => {
      const files = trackedFiles();
      expect(occurrencesIn(files)).toBe(0);
      expect(mavenLocalProblems(sdk, files)).toEqual([]);
    });
  }
});

// Fixtures, so both branches of the checker run whatever the pin is today.
const GUARDED = `
def versions = new groovy.json.JsonSlurper().parse(file('native-versions.json'))
// mavenLocal only while the pin is a SNAPSHOT
if (versions.android.sdk.endsWith('-SNAPSHOT')) {
    allprojects {
        repositories {
            mavenLocal {
                content { ${CONTENT_FILTER} }
            }
        }
    }
}
repositories { mavenCentral() }
`;
const CLEAN = `
// no mavenLocal here any more
repositories { google(); mavenCentral() }
`;
const UNGUARDED = `
repositories {
    mavenLocal {
        content { ${CONTENT_FILTER} }
    }
}
`;
const UNFILTERED = `
if (versions.android.sdk.endsWith('-SNAPSHOT')) {
    repositories { mavenLocal() }
}
`;
const OTHER_GUARD = `
if (project.hasProperty('useLocal')) {
    repositories {
        mavenLocal { content { ${CONTENT_FILTER} } }
    }
}
`;
// A bare mavenLocal() followed by an unrelated filtered block: the filter
// belongs to the later block, not to this one.
const BARE_THEN_FILTERED = `
if (versions.android.sdk.endsWith('-SNAPSHOT')) {
    repositories {
        mavenLocal()
        maven { url 'x'; content { ${CONTENT_FILTER} } }
    }
}
`;

// A guard that closed before mavenLocal does not guard it.
const AFTER_CLOSED_GUARD = `
if (versions.android.sdk.endsWith('-SNAPSHOT')) {
    repositories { mavenCentral() }
}
repositories {
    mavenLocal { content { ${CONTENT_FILTER} } }
}
`;
// Spacing and extra clauses the guard pattern must tolerate, and closed
// sibling blocks between the guard and mavenLocal that must be skipped.
const GUARDED_VARIANTS = `
if(versions.android.sdk.endsWith( '-SNAPSHOT' ) && !gradle.startParameter.offline){
    allprojects {
        buildscript { repositories { google() } }
        repositories {
            mavenCentral()
            mavenLocal(){content { ${CONTENT_FILTER} }}
            mavenLocal( ) { content { ${CONTENT_FILTER} } }
        }
    }
}
`;

describe('mavenLocalProblems with a SNAPSHOT pin', () => {
  it('accepts guard and block spelling variants, skipping closed sibling blocks', () => {
    expect(mavenLocalProblems('7.3.0-SNAPSHOT', { 'v.gradle': GUARDED_VARIANTS })).toEqual([]);
  });

  it('accepts a block directly inside the guard', () => {
    const direct = `if (versions.android.sdk.endsWith('-SNAPSHOT')) { mavenLocal { content { ${CONTENT_FILTER} } } }`;
    expect(mavenLocalProblems('7.3.0-SNAPSHOT', { 'd.gradle': direct })).toEqual([]);
  });

  it('rejects a block after a guard that has already closed', () => {
    expect(mavenLocalProblems('7.3.0-SNAPSHOT', { 'k.gradle': AFTER_CLOSED_GUARD })).toEqual([
      "k.gradle:6: mavenLocal is not inside the android.sdk.endsWith('-SNAPSHOT') guard",
    ]);
  });


  const sdk = '7.3.0-SNAPSHOT';

  it('accepts guarded, filtered blocks', () => {
    expect(mavenLocalProblems(sdk, { 'a.gradle': GUARDED, 'b.gradle': CLEAN })).toEqual([]);
  });

  it('rejects having no mavenLocal at all, since the pin cannot resolve', () => {
    expect(mavenLocalProblems(sdk, { 'b.gradle': CLEAN })).toEqual([
      '7.3.0-SNAPSHOT is a SNAPSHOT pin, but no Gradle file adds the guarded mavenLocal it resolves from',
    ]);
  });

  it('rejects an unguarded block, naming the file and line', () => {
    expect(mavenLocalProblems(sdk, { 'u.gradle': UNGUARDED })).toEqual([
      "u.gradle:3: mavenLocal is not inside the android.sdk.endsWith('-SNAPSHOT') guard",
    ]);
  });

  it('rejects a block guarded by some other condition', () => {
    expect(mavenLocalProblems(sdk, { 'o.gradle': OTHER_GUARD })).toEqual([
      "o.gradle:4: mavenLocal is not inside the android.sdk.endsWith('-SNAPSHOT') guard",
    ]);
  });

  it('rejects a guarded but unfiltered block', () => {
    expect(mavenLocalProblems(sdk, { 'f.gradle': UNFILTERED })).toEqual([
      'f.gradle:3: mavenLocal is not filtered to com.bugsee -SNAPSHOT versions',
    ]);
  });

  it('does not credit a bare mavenLocal() with a later block’s filter', () => {
    expect(mavenLocalProblems(sdk, { 'g.gradle': BARE_THEN_FILTERED })).toEqual([
      'g.gradle:4: mavenLocal is not filtered to com.bugsee -SNAPSHOT versions',
    ]);
  });

  it('ignores mavenLocal in comments', () => {
    const commented = `/* mavenLocal { } */\n// mavenLocal()\n${GUARDED}`;
    expect(mavenLocalProblems(sdk, { 'c.gradle': commented })).toEqual([]);
    expect(mavenLocalProblems(sdk, { 'c.gradle': '// mavenLocal()\n' })).toHaveLength(1);
  });
});

describe('mavenLocalProblems with a released pin', () => {
  const sdk = '7.3.0';

  it('accepts files with no mavenLocal', () => {
    expect(mavenLocalProblems(sdk, { 'b.gradle': CLEAN, 'c.gradle': '// mavenLocal\n' })).toEqual([]);
  });

  it('rejects even a guarded, filtered block: it must be deleted', () => {
    expect(mavenLocalProblems(sdk, { 'a.gradle': GUARDED })).toEqual([
      'a.gradle:7: mavenLocal must be removed, 7.3.0 is a released pin',
    ]);
  });

  it('rejects every occurrence, in every file', () => {
    expect(
      mavenLocalProblems(sdk, { 'a.gradle': GUARDED, 'u.gradle': UNGUARDED }),
    ).toHaveLength(2);
  });
});

describe('mavenLocalBody', () => {
  it('returns the braced body of a block', () => {
    expect(mavenLocalBody('mavenLocal { a { b } } c', 0)).toBe('{ a { b } }');
  });

  it('returns the body of the mavenLocal() { } form', () => {
    expect(mavenLocalBody('mavenLocal() { x }', 0)).toBe('{ x }');
  });

  it('returns nothing for a bare mavenLocal()', () => {
    expect(mavenLocalBody('mavenLocal()\nmaven { x }', 0)).toBe('');
  });

  it('throws on unbalanced braces', () => {
    expect(() => mavenLocalBody('mavenLocal { {', 0)).toThrow(/unbalanced/);
  });
});

describe('stripComments', () => {
  it('blanks comments but keeps offsets and newlines', () => {
    const source = 'a // b\n/* c\nd */ e';
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped).toBe('a     \n    \n     e');
  });
});
