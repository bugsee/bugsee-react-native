/**
 * `mavenLocal` is a human's own machine, not a build input CI or another
 * developer can reproduce, and this machine's `~/.m2` already holds stale
 * non-SNAPSHOT `com.bugsee` builds. So:
 *
 * - while `android.sdk` is a `-SNAPSHOT` pin, `mavenLocal` may appear only
 *   inside the `android.sdk.endsWith('-SNAPSHOT')` guard, and even there only
 *   filtered to `com.bugsee` `-SNAPSHOT` versions -- never able to satisfy a
 *   normal request -- and it must appear (the pin cannot resolve without it);
 * - once `android.sdk` is a released version, it must not appear at all.
 *
 * Checked as text, not by running Gradle: these files are evaluated in
 * contexts (a standalone unit-test build, an autolinked example app) that a
 * plain Jest test cannot stand up cheaply, and the invariant is structural --
 * "is this token inside that guard" -- which a small brace-matching scan
 * answers directly.
 */

/** Every tracked Gradle file that declares repositories. */
export const MAVEN_LOCAL_FILES = [
  'settings.gradle',
  'examples/bare/android/build.gradle',
  'examples/bare/android/settings.gradle',
  'packages/react-native/android/build.gradle',
] as const;

// The Gradle source is a Groovy single-quoted string, where a literal
// backslash is written `\\` -- so the file's actual bytes for the escaped
// dot are TWO backslash characters, not one. String.raw keeps this literal
// instead of a JS string swallowing one level of escaping.
export const CONTENT_FILTER = String.raw`includeVersionByRegex('com\\.bugsee', '.*', '.*-SNAPSHOT')`;

/**
 * Blanks out `//` and `/* *\/` comments, preserving every other character's
 * offset (and line breaks, so a line-comment doesn't swallow the newline).
 * Comments are exactly where prose about this rule -- "mavenLocal is guarded
 * by the SNAPSHOT pin" -- would otherwise be misread as the guard itself.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

/** Byte offsets of every `mavenLocal` token in `source`. */
export function mavenLocalOffsets(source: string): number[] {
  const offsets: number[] = [];
  const re = /\bmavenLocal\b/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    offsets.push(m.index);
  }
  return offsets;
}

const SNAPSHOT_GUARD = /if\s*\([^{}]*\.sdk\.endsWith\(\s*['"]-SNAPSHOT['"]\s*\)[^{}]*\)$/;

/**
 * Whether an enclosing `if (...) { }` tests
 * `android.sdk.endsWith('-SNAPSHOT')`, searching ALL enclosing levels, not
 * only the immediate one: the example nests `mavenLocal` inside `allprojects
 * { repositories { ... } }`, itself inside the guard. Walks backwards from
 * `offset`, skipping every `{ }` pair that closed before it.
 */
export function isGuardedBySnapshotCheck(source: string, offset: number): boolean {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i -= 1) {
    if (source[i] === '}') {
      depth += 1;
    } else if (source[i] === '{') {
      if (depth > 0) {
        depth -= 1;
      } else {
        // An enclosing brace. A window, not a balanced-paren parse: the
        // condition itself calls endsWith(...), which nests parens a simple
        // capture group cannot walk through. Braces bound the window
        // instead, since a condition cannot legally contain one.
        const before = source.slice(Math.max(0, i - 400), i).trimEnd();
        if (SNAPSHOT_GUARD.test(before)) return true;
      }
    }
  }
  return false;
}

/**
 * The `{ ... }` body of the `mavenLocal` block starting at `offset`, or `''`
 * for a bare `mavenLocal()` that has none.
 */
export function mavenLocalBody(source: string, offset: number): string {
  const rest = source.slice(offset + 'mavenLocal'.length);
  const open = /^\s*(?:\(\s*\)\s*)?\{/.exec(rest);
  if (open === null) return '';
  const openIndex = offset + 'mavenLocal'.length + open[0].length - 1;
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

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Every way `files` (path -> Gradle source) breaks the rule for the Android
 * pin `sdk`. Empty means conforming.
 */
export function mavenLocalProblems(
  sdk: string,
  files: Readonly<Record<string, string>>,
): string[] {
  const snapshot = sdk.endsWith('-SNAPSHOT');
  const problems: string[] = [];
  let found = false;
  for (const [file, raw] of Object.entries(files)) {
    const source = stripComments(raw);
    for (const offset of mavenLocalOffsets(source)) {
      found = true;
      const where = `${file}:${lineOf(source, offset)}`;
      if (!snapshot) {
        problems.push(`${where}: mavenLocal must be removed, ${sdk} is a released pin`);
        continue;
      }
      if (!isGuardedBySnapshotCheck(source, offset)) {
        problems.push(`${where}: mavenLocal is not inside the android.sdk.endsWith('-SNAPSHOT') guard`);
      }
      if (!mavenLocalBody(source, offset).includes(CONTENT_FILTER)) {
        problems.push(`${where}: mavenLocal is not filtered to com.bugsee -SNAPSHOT versions`);
      }
    }
  }
  if (snapshot && !found) {
    problems.push(`${sdk} is a SNAPSHOT pin, but no Gradle file adds the guarded mavenLocal it resolves from`);
  }
  return problems;
}
