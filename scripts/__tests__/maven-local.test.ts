import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `mavenLocal` is a human's own machine, not a build input CI or another
 * developer can reproduce, and this machine's `~/.m2` already holds stale
 * non-SNAPSHOT `com.bugsee` builds. It must therefore appear only inside the
 * `android.sdk.endsWith('-SNAPSHOT')` guard, and even there only filtered to
 * `com.bugsee` `-SNAPSHOT` versions -- never able to satisfy a normal request.
 *
 * Checked as text, not by running Gradle: these files are evaluated in
 * contexts (a standalone unit-test build, an autolinked example app) that a
 * plain Jest test cannot stand up cheaply, and the invariant is structural --
 * "is this token inside that guard" -- which a small brace-matching scan
 * answers directly.
 */
const repoRoot = join(__dirname, '..', '..');

const FILES = [
  'settings.gradle',
  'examples/bare/android/build.gradle',
  'examples/bare/android/settings.gradle',
  'packages/react-native/android/build.gradle',
] as const;

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

/**
 * Blanks out `//` and `/* *\/` comments, preserving every other character's
 * offset (and line breaks, so a line-comment doesn't swallow the newline).
 * Comments are exactly where prose about this rule -- "mavenLocal is guarded
 * by the SNAPSHOT pin" -- would otherwise be misread as the guard itself.
 */
function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

/** Byte offsets of every `mavenLocal` token in `source`. */
function mavenLocalOffsets(source: string): number[] {
  const offsets: number[] = [];
  const re = /\bmavenLocal\b/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    offsets.push(m.index);
  }
  return offsets;
}

/**
 * Offsets of every `{` that encloses `offset`, innermost first -- e.g. for
 * `mavenLocal` inside `if (...) { allprojects { repositories { mavenLocal`,
 * all three opening braces.
 */
function enclosingBraceOffsets(source: string, offset: number): number[] {
  const braces: number[] = [];
  let depth = 0;
  for (let i = offset - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === '}') {
      depth += 1;
    } else if (ch === '{') {
      if (depth === 0) {
        braces.push(i);
      } else {
        depth -= 1;
      }
    }
  }
  return braces;
}

/**
 * True when `offset` sits inside the body of an `if (...) { }` whose
 * condition tests `android.sdk.endsWith('-SNAPSHOT')` -- at ANY enclosing
 * level, not only the immediate one: the example nests `mavenLocal` inside
 * `allprojects { repositories { ... } }`, itself inside the guard.
 */
function isGuardedBySnapshotCheck(source: string, offset: number): boolean {
  return enclosingBraceOffsets(source, offset).some((braceIndex) => {
    // A window, not a balanced-paren parse: the condition itself calls
    // endsWith(...), which nests parens a simple capture group cannot walk
    // through. Braces bound the window instead, since a condition cannot
    // legally contain one.
    const windowStart = Math.max(0, braceIndex - 400);
    const before = source.slice(windowStart, braceIndex).trimEnd();
    return /if\s*\([^{}]*\.sdk\.endsWith\(\s*['"]-SNAPSHOT['"]\s*\)[^{}]*\)\s*$/.test(before);
  });
}

/** The full `{ ... }` body of the `mavenLocal` block starting at `offset`. */
function mavenLocalBody(source: string, offset: number): string {
  const openIndex = source.indexOf('{', offset);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error(`unbalanced braces scanning mavenLocal block at offset ${offset}`);
}

// The Gradle source is a Groovy single-quoted string, where a literal
// backslash is written `\\` -- so the file's actual bytes for the escaped
// dot are TWO backslash characters, not one. String.raw keeps this literal
// instead of a JS string swallowing one level of escaping.
const CONTENT_FILTER = String.raw`includeVersionByRegex('com\\.bugsee', '.*', '.*-SNAPSHOT')`;

describe('mavenLocal is used only where a SNAPSHOT pin needs it', () => {
  it('when no pin is a SNAPSHOT, no tracked Gradle file mentions mavenLocal', () => {
    // Every occurrence found anywhere must live inside the SNAPSHOT guard --
    // equivalently, with a released (non-SNAPSHOT) pin the guard is false and
    // none of these blocks run, so mavenLocal never actually applies.
    for (const file of FILES) {
      const source = stripComments(read(file));
      for (const offset of mavenLocalOffsets(source)) {
        expect(isGuardedBySnapshotCheck(source, offset)).toBe(true);
      }
    }
  });

  it('when a pin is a SNAPSHOT, every mavenLocal is guarded by the pin and filtered to com.bugsee -SNAPSHOT versions', () => {
    let occurrences = 0;
    for (const file of FILES) {
      const source = stripComments(read(file));
      for (const offset of mavenLocalOffsets(source)) {
        occurrences += 1;
        expect(isGuardedBySnapshotCheck(source, offset)).toBe(true);
        expect(mavenLocalBody(source, offset)).toContain(CONTENT_FILTER);
      }
    }
    // Sanity: native-versions.json pins a SNAPSHOT right now, so this suite
    // is not vacuously passing over zero occurrences.
    expect(occurrences).toBeGreaterThan(0);
  });
});
