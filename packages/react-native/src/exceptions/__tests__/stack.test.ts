import { cleanSource, fileKey, parseStack, STACK_MAX_INPUT_LENGTH, STACK_MAX_LINE_LENGTH } from '../stack';
import {
  V8_NODE_SAMPLE,
  JSC_SAMPLE,
  HERMES_RELEASE_SAMPLE,
  HERMES_DEBUG_SAMPLE,
  COMPONENT_STACK_SAMPLE_HERMES,
  COMPONENT_STACK_SAMPLE_JSC,
} from './fixtures/captured-stacks';

describe('parseStack', () => {
  it('parses a Hermes release frame (address at)', () => {
    const frames = parseStack(
      '    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)',
    );

    expect(frames).toEqual([
      {
        raw: '    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)',
        file: 'address at index.android.bundle',
        methodName: 'bugseeE2EThrowSite',
        lineNumber: 1,
        column: 20417,
      },
    ]);
  });

  it('parses a Hermes frame from a Metro URL', () => {
    const line =
      '    at bugseeE2EThrowSite (http://localhost:8081/index.bundle?platform=android&dev=true&minify=false:2:20417)';
    const frames = parseStack(line);

    expect(frames).toEqual([
      {
        raw: line,
        file: 'http://localhost:8081/index.bundle?platform=android&dev=true&minify=false',
        methodName: 'bugseeE2EThrowSite',
        lineNumber: 2,
        column: 20417,
      },
    ]);
  });

  it('parses a native frame with no location', () => {
    const frames = parseStack('    at forEach (native)');

    expect(frames).toEqual([
      {
        raw: '    at forEach (native)',
        file: null,
        methodName: 'forEach',
        lineNumber: null,
        column: null,
      },
    ]);
  });

  it('parses a JSC frame (name@file:line:col)', () => {
    const frames = parseStack('global@app.bundle:100:20');

    expect(frames).toEqual([
      {
        raw: 'global@app.bundle:100:20',
        file: 'app.bundle',
        methodName: 'global',
        lineNumber: 100,
        column: 20,
      },
    ]);
  });

  it('parses a V8 frame (at name (file:line:col))', () => {
    const frames = parseStack('    at Object.foo (/path/to/file.js:10:15)');

    expect(frames).toEqual([
      {
        raw: '    at Object.foo (/path/to/file.js:10:15)',
        file: '/path/to/file.js',
        methodName: 'Object.foo',
        lineNumber: 10,
        column: 15,
      },
    ]);
  });

  it('parses a component-stack line (in X (at file:line))', () => {
    const frames = parseStack('    in MyComponent (at App.js:42)');

    expect(frames).toEqual([
      {
        raw: '    in MyComponent (at App.js:42)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: null,
      },
    ]);
  });

  it('skips the "Name: message" header and blank lines', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      '',
      '    at foo (/a.js:1:2)',
    ].join('\n');

    const frames = parseStack(stack);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: '/a.js', methodName: 'foo' });
  });

  it('parses a JSC frame with no name prefix (file:line:col)', () => {
    const frames = parseStack('app.bundle:7:8');

    expect(frames).toEqual([
      {
        raw: 'app.bundle:7:8',
        file: 'app.bundle',
        methodName: null,
        lineNumber: 7,
        column: 8,
      },
    ]);
  });

  it('parses a JSC frame with no column (file:line)', () => {
    const frames = parseStack('app.bundle:7');

    expect(frames).toEqual([
      { raw: 'app.bundle:7', file: 'app.bundle', methodName: null, lineNumber: 7, column: null },
    ]);
  });

  it('tolerates a missing space before the opening parenthesis (Chrome)', () => {
    const frames = parseStack('    at foo(/a.js:1:2)');

    expect(frames).toEqual([
      { raw: '    at foo(/a.js:1:2)', file: '/a.js', methodName: 'foo', lineNumber: 1, column: 2 },
    ]);
  });

  it('parses a Windows drive-letter path (Chrome)', () => {
    const frames = parseStack('    at foo (c:\\app\\file.js:1:2)');

    expect(frames).toEqual([
      {
        raw: '    at foo (c:\\app\\file.js:1:2)',
        file: 'c:\\app\\file.js',
        methodName: 'foo',
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('tolerates a missing closing parenthesis (Chrome)', () => {
    const frames = parseStack('    at foo (/a.js:1:2');

    expect(frames).toEqual([
      { raw: '    at foo (/a.js:1:2', file: '/a.js', methodName: 'foo', lineNumber: 1, column: 2 },
    ]);
  });

  it('does not treat a garbage-prefixed "at" line as a frame (Chrome)', () => {
    expect(parseStack('xat foo (/a.js:1:2)')).toEqual([]);
  });

  it('does not treat a garbage-prefixed "at" line as a frame (Hermes address)', () => {
    expect(parseStack('xat foo (address at index.android.bundle:1:2)')).toEqual([]);
  });

  it('rejects trailing garbage after the closing parenthesis (Hermes address)', () => {
    expect(
      parseStack('    at foo (address at index.android.bundle:1:2) trailing junk'),
    ).toEqual([]);
  });

  it('tolerates trailing whitespace, and only whitespace, after the closing parenthesis (Hermes address)', () => {
    const frames = parseStack('    at foo (address at index.android.bundle:1:2)   ');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: 'address at index.android.bundle' });
  });

  it('parses multi-digit line and column numbers (Hermes address)', () => {
    const frames = parseStack('    at foo (address at index.android.bundle:1234:5678)');

    expect(frames).toEqual([
      {
        raw: '    at foo (address at index.android.bundle:1234:5678)',
        file: 'address at index.android.bundle',
        methodName: 'foo',
        lineNumber: 1234,
        column: 5678,
      },
    ]);
  });

  it('requires a run of whitespace, not exactly one space (component stack)', () => {
    const frames = parseStack('    in  MyComponent  (at  App.js:42)');

    expect(frames).toEqual([
      {
        raw: '    in  MyComponent  (at  App.js:42)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: null,
      },
    ]);
  });

  it('parses a component-stack line with a multi-digit column', () => {
    const frames = parseStack('    in MyComponent (at App.js:42:17)');

    expect(frames).toEqual([
      {
        raw: '    in MyComponent (at App.js:42:17)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: 17,
      },
    ]);
  });

  it("defaults an empty component name to '<unknown>'", () => {
    const frames = parseStack('    in  (at App.js:1)');

    expect(frames[0]?.methodName).toBe('<unknown>');
  });

  it('rejects trailing garbage after the closing parenthesis (component stack)', () => {
    expect(parseStack('    in MyComponent (at App.js:42) trailing junk')).toEqual([]);
  });

  it('tolerates trailing whitespace, and only whitespace, after the closing parenthesis (component stack)', () => {
    const frames = parseStack('    in MyComponent (at App.js:42)   ');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: 'App.js', methodName: 'MyComponent' });
  });
});

describe('fileKey', () => {
  it('strips file:// and "address at " only', () => {
    expect(fileKey('file:///Users/x/Bundle.app/index.android.bundle')).toBe(
      '/Users/x/Bundle.app/index.android.bundle',
    );
    expect(fileKey('address at index.android.bundle')).toBe('index.android.bundle');
    expect(fileKey('index.android.bundle')).toBe('index.android.bundle');
  });

  it('strips them only as a genuine prefix, not wherever they occur', () => {
    expect(fileKey('xfile://something')).toBe('xfile://something');
    expect(fileKey('xaddress at foo')).toBe('xaddress at foo');
  });
});

describe('cleanSource', () => {
  it('strips an iOS .app prefix, the iOS data container and the Android data directory', () => {
    expect(
      cleanSource(
        '/private/var/containers/Bundle/Application/ABC-123/MyApp.app/main.jsbundle',
      ),
    ).toBe('main.jsbundle');

    expect(
      cleanSource(
        '/var/mobile/Containers/Data/Application/XYZ-456/Documents/CodePush/bundle.js',
      ),
    ).toBe('Documents/CodePush/bundle.js');

    expect(cleanSource('/data/user/42/com.example.foo/files/bundle.js')).toBe(
      'files/bundle.js',
    );
    expect(cleanSource('/data/data/com.example.foo/files/bundle.js')).toBe(
      'files/bundle.js',
    );
  });

  it("is '' for null", () => {
    expect(cleanSource(null)).toBe('');
  });

  it('also strips file:// and "address at " (steps 1-2)', () => {
    expect(cleanSource('file:///a/b.js')).toBe('/a/b.js');
    expect(cleanSource('address at index.android.bundle')).toBe('index.android.bundle');
  });

  it('strips the Android and iOS data-directory patterns only as a genuine prefix', () => {
    expect(cleanSource('prefix/data/data/com.example.foo/file.js')).toBe(
      'prefix/data/data/com.example.foo/file.js',
    );
    expect(cleanSource('prefix/data/user/0/com.example.foo/file.js')).toBe(
      'prefix/data/user/0/com.example.foo/file.js',
    );
    expect(
      cleanSource('prefix/var/mobile/Containers/Data/Application/ABC/file.js'),
    ).toBe('prefix/var/mobile/Containers/Data/Application/ABC/file.js');
  });

  it('strips an iOS .app bundle path only when it can start matching at the very beginning', () => {
    // `.` does not match a newline, so an anchored match cannot start before
    // one; without the anchor the pattern would instead match starting after it.
    expect(cleanSource('garbage\n/real/path/MyApp.app/main.js')).toBe(
      'garbage\n/real/path/MyApp.app/main.js',
    );
  });
});

describe('parseStack: bounded against a hostile stack (review C1)', () => {
  // A generous, CI-safe budget. Every case here previously took from over a
  // second to (extrapolated) minutes; a correct, bounded parse finishes in
  // low single-digit milliseconds, so 100 ms leaves ample headroom without
  // making the test flaky on a loaded CI box.
  const TIME_BUDGET_MS = 100;

  function assertFast(fn: () => void): number {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
    return elapsed;
  }

  // A trailing non-space character at this length survives both length
  // caps (so it is still there for `trim()` to see) but keeps the line
  // itself well under `STACK_MAX_LINE_LENGTH`, so these cases stress a
  // pattern's own backtracking, not just "does the cap apply". A run this
  // long, with no trailing marker, would instead `trim()` down to nothing
  // before any pattern ran -- see the "whole-input/whole-line cap" cases
  // below for that (different, still real) property.
  const SURVIVING_PADDING = 1800;

  it('a 1 MB single line of spaces (the review\'s literal case; trims to empty before any pattern runs)', () => {
    assertFast(() => parseStack(' '.repeat(1024 * 1024)));
  });

  it('a 200,000-space line (the review\'s literal JSC_RE case; same fast path)', () => {
    assertFast(() => parseStack(' '.repeat(200000)));
  });

  it('a 1 MB "in " + spaces line (the review\'s literal COMPONENT_STACK_RE case)', () => {
    assertFast(() => parseStack(`in ${' '.repeat(1024 * 1024)}x`));
  });

  it('"in " + padding + "x" that survives to COMPONENT_STACK_RE intact', () => {
    // This is the case that actually exercises the pattern: with the old
    // `/^\s*in\s+(.*?)\s*\(at.../` (this file's own history), 2,000 spaces
    // here took 1.5 s; the fix (no separate `\s*` between the name group
    // and the parenthesis) takes under 1 ms for the same input.
    assertFast(() => parseStack(`in ${' '.repeat(SURVIVING_PADDING)}x`));
  });

  it('padding + a trailing letter that survives to JSC_RE intact, no "@" and no digits', () => {
    assertFast(() => parseStack(`a${' '.repeat(SURVIVING_PADDING)}b`));
  });

  it('"at a (/x:1:1" + padding + "x" that survives to CHROME_RE intact, never closed', () => {
    assertFast(() => parseStack(`at a (/x:1:1${' '.repeat(SURVIVING_PADDING)}x`));
  });

  it('"at /x" + padding + "x" that survives to NODE_RE intact, no trailing digits at all', () => {
    // The second-order bug this fix's own first draft had: a single
    // combined "at NAME? (FILE" pattern (an optional name group ending in
    // one literal space, or later a `\s*`, before the file group) still
    // took over 3 s directly on a 1 MB line here, even with its outer
    // `^\s*`/`\s*$` already removed -- the name group's search for a
    // single-space terminator, combined with the file group's own
    // expensive failed scan, was still quadratic. Splitting it into
    // NODE_PAREN_RE and NODE_BARE_RE (neither with a separator quantifier
    // of its own) fixed it: under 1 ms for the same input.
    assertFast(() => parseStack(`at /x${' '.repeat(SURVIVING_PADDING)}x`));
  });

  it('"at foo (" + padding + "x" that survives to NODE_RE intact, never closed', () => {
    assertFast(() => parseStack(`at foo (${' '.repeat(SURVIVING_PADDING)}x`));
  });

  it('a component-stack line with a long run of closing parentheses', () => {
    assertFast(() => parseStack(`in a ${')'.repeat(SURVIVING_PADDING)}x`));
  });

  it('a Chrome-shaped line with a long run of closing parentheses', () => {
    assertFast(() => parseStack(`at a (${')'.repeat(SURVIVING_PADDING)}x`));
  });

  it('100,000 short, individually valid lines', () => {
    const stack = Array.from({ length: 100000 }, (_, i) => `    at fn${i} (/a.js:${i}:1)`).join(
      '\n',
    );
    let frames: ReturnType<typeof parseStack> = [];
    assertFast(() => {
      frames = parseStack(stack, 256);
    });
    expect(frames).toHaveLength(256);
  });

  it('a 1,000,000-line stack stops at maxFrames instead of parsing every line', () => {
    const stack = Array.from(
      { length: 1_000_000 },
      (_, i) => `    at fn${i} (/a.js:${i}:1)`,
    ).join('\n');
    let frames: ReturnType<typeof parseStack> = [];
    assertFast(() => {
      frames = parseStack(stack, 256);
    });
    expect(frames).toHaveLength(256);
    expect(frames[0]).toMatchObject({ methodName: 'fn0' });
  });

  it('exports its bounds as documented constants', () => {
    expect(STACK_MAX_INPUT_LENGTH).toBe(64 * 1024);
    expect(STACK_MAX_LINE_LENGTH).toBe(2 * 1024);
  });

  it('caps the whole stack before splitting into lines', () => {
    const hugeLine = 'x'.repeat(STACK_MAX_INPUT_LENGTH * 2);
    // Nothing here can parse as a frame; the point is only that this
    // returns (fast) instead of processing 2x the input cap.
    assertFast(() => parseStack(hugeLine));
  });

  it('caps each line before matching, independent of the whole-stack cap', () => {
    // A single very long, but individually well-formed, frame line: still
    // capped per-line, so its file is truncated rather than blowing up a
    // regex on the full length.
    const hugeFile = '/a/' + 'b'.repeat(STACK_MAX_LINE_LENGTH * 4);
    const frames = parseStack(`    at fn (${hugeFile}:1:2)`);
    expect(frames[0]?.raw.length).toBeLessThanOrEqual(STACK_MAX_LINE_LENGTH);
  });

  // A JSC-shaped line ("name@file:line:col") has no optional trailing
  // punctuation to obscure the cut, so trimming its very last character --
  // exactly what happens one byte past a cap -- changes a two-digit column
  // into its own first digit. That pins the boundary exactly, both caps.
  function jscLine(totalLength: number): string {
    const suffix = '@a.js:1:22';
    return 'n'.repeat(totalLength - suffix.length) + suffix;
  }

  it('does not cut a single line that is exactly STACK_MAX_LINE_LENGTH long', () => {
    const line = jscLine(STACK_MAX_LINE_LENGTH);
    expect(line).toHaveLength(STACK_MAX_LINE_LENGTH);
    expect(parseStack(line)[0]?.column).toBe(22);
  });

  it('cuts a single line one character past STACK_MAX_LINE_LENGTH, losing its final digit', () => {
    const line = jscLine(STACK_MAX_LINE_LENGTH + 1);
    expect(line).toHaveLength(STACK_MAX_LINE_LENGTH + 1);
    expect(parseStack(line)[0]?.column).toBe(2);
  });

  function stackOfTotalLength(totalLength: number): string {
    const suffix = '\na.js:1:22';
    return 'x'.repeat(totalLength - suffix.length) + suffix;
  }

  it('does not cut the whole stack when it is exactly STACK_MAX_INPUT_LENGTH long', () => {
    const stack = stackOfTotalLength(STACK_MAX_INPUT_LENGTH);
    expect(stack).toHaveLength(STACK_MAX_INPUT_LENGTH);
    const frames = parseStack(stack);
    expect(frames[frames.length - 1]?.column).toBe(22);
  });

  it('cuts the whole stack one character past STACK_MAX_INPUT_LENGTH, losing its final digit', () => {
    const stack = stackOfTotalLength(STACK_MAX_INPUT_LENGTH + 1);
    expect(stack).toHaveLength(STACK_MAX_INPUT_LENGTH + 1);
    const frames = parseStack(stack);
    expect(frames[frames.length - 1]?.column).toBe(2);
  });
});

describe('parseStack: a full-size stack of worst-case lines (review N1)', () => {
  // Round 1's per-line timing tests found the two regexes N1 flags (see
  // their own comments in stack.ts), but a per-line budget under 100 ms
  // hides a per-line cost of a few milliseconds -- multiplied by every
  // line in a real, cap-sized stack, that still blows the budget. These
  // time a *whole* STACK_MAX_INPUT_LENGTH-sized stack of the worst line
  // each pattern is now linear on, not one line of it.
  const TIME_BUDGET_MS = 100;

  function assertFast(fn: () => void): number {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
    return elapsed;
  }

  it("a full stack of the review's CHROME_RE worst-case line ('at ' + ' (/'x680 + '\\rx')", () => {
    const worstLine = `at ${' (/'.repeat(680)}\rx`;
    const lineCount = Math.ceil(STACK_MAX_INPUT_LENGTH / (worstLine.length + 1)) + 1;
    const stack = Array.from({ length: lineCount }, () => worstLine).join('\n');
    expect(stack.length).toBeGreaterThanOrEqual(STACK_MAX_INPUT_LENGTH);

    const elapsed = assertFast(() => parseStack(stack));
    console.log(`CHROME_RE worst-case full stack (${stack.length} chars): ${elapsed.toFixed(2)} ms`);
  });

  it("a full stack of the review's COMPONENT_STACK_RE worst-case line ('in (at' + spaces + 'x')", () => {
    const worstLine = `in (at${' '.repeat(2040)}x`;
    const lineCount = Math.ceil(STACK_MAX_INPUT_LENGTH / (worstLine.length + 1)) + 1;
    const stack = Array.from({ length: lineCount }, () => worstLine).join('\n');
    expect(stack.length).toBeGreaterThanOrEqual(STACK_MAX_INPUT_LENGTH);

    const elapsed = assertFast(() => parseStack(stack));
    console.log(`COMPONENT_STACK_RE worst-case full stack (${stack.length} chars): ${elapsed.toFixed(2)} ms`);
  });
});

describe('parseStack: a garbage-prefixed line is rejected, not matched starting later (review M1)', () => {
  it('component-stack: "xin A (at f.js:1)" and "Within A (at f.js:1)" are not frames', () => {
    expect(parseStack('xin A (at f.js:1)')).toEqual([]);
    expect(parseStack('Within A (at f.js:1)')).toEqual([]);
  });

  it('JSC: a carriage return where the file must start rejects the line, not just that position', () => {
    // `\r` is whitespace, so `\S` (the file group's required first
    // character) cannot match it; the only way to still get a frame is for
    // the match to slide past the `x@\r` prefix to start at "file:1:2" --
    // which only an unanchored pattern would allow.
    expect(parseStack('x@\rfile:1:2')).toEqual([]);
  });
});

describe('parseStack: a V8/Hermes anonymous or relative-file frame (6.x parity, review M3)', () => {
  it('a V8 anonymous frame with an absolute path and no function name', () => {
    const frames = parseStack('    at /Users/me/app/index.js:10:5');
    expect(frames).toEqual([
      {
        raw: '    at /Users/me/app/index.js:10:5',
        file: '/Users/me/app/index.js',
        methodName: null,
        lineNumber: 10,
        column: 5,
      },
    ]);
  });

  it('a V8 anonymous frame served from a Metro URL, no function name', () => {
    const line = '    at http://localhost:8081/index.bundle?platform=ios:10:5';
    const frames = parseStack(line);
    expect(frames).toEqual([
      {
        raw: line,
        file: 'http://localhost:8081/index.bundle?platform=ios',
        methodName: null,
        lineNumber: 10,
        column: 5,
      },
    ]);
  });

  it('a Chrome-shaped frame whose file has no recognised scheme (a relative bundle file)', () => {
    expect(parseStack('    at foo (index.android.bundle:1:1234)')).toEqual([
      {
        raw: '    at foo (index.android.bundle:1:1234)',
        file: 'index.android.bundle',
        methodName: 'foo',
        lineNumber: 1,
        column: 1234,
      },
    ]);

    expect(parseStack('    at foo (InternalBytecode.js:1:1234)')).toEqual([
      {
        raw: '    at foo (InternalBytecode.js:1:1234)',
        file: 'InternalBytecode.js',
        methodName: 'foo',
        lineNumber: 1,
        column: 1234,
      },
    ]);
  });

  it('a parenthesised no-scheme frame with a line but no column', () => {
    expect(parseStack('    at foo (index.android.bundle:1)')).toEqual([
      {
        raw: '    at foo (index.android.bundle:1)',
        file: 'index.android.bundle',
        methodName: 'foo',
        lineNumber: 1,
        column: null,
      },
    ]);
  });

  it('a bare anonymous frame with a multi-digit line and no column', () => {
    expect(parseStack('    at /a/b.js:1234')).toEqual([
      {
        raw: '    at /a/b.js:1234',
        file: '/a/b.js',
        methodName: null,
        lineNumber: 1234,
        column: null,
      },
    ]);
  });

  it("a garbage-prefixed 'at' line falls through to JSC's broader match, not NODE_BARE_RE's own (unanchored) one", () => {
    // NODE_BARE_RE's `^at ` requires the line to start there; "xat ..."
    // fails it and falls through to JSC_RE, which has no "at" concept at
    // all and keeps the "xat " prefix as part of the file. Without
    // NODE_BARE_RE's own anchor, it would instead match starting at
    // "at /a/b.js:1:2" (skipping the leading "x"), giving a clean
    // "/a/b.js" -- a different, wrong file.
    expect(parseStack('xat /a/b.js:1:2')).toEqual([
      {
        raw: 'xat /a/b.js:1:2',
        file: 'xat /a/b.js',
        methodName: null,
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('still lets a real Chrome/Hermes/JSC/component-stack line take priority', () => {
    // NODE_RE is tried after Hermes-address and before JSC; it must not
    // shadow any of the other four shapes.
    expect(parseStack('    at forEach (native)')[0]).toMatchObject({ file: null });
    expect(
      parseStack('    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)')[0],
    ).toMatchObject({ file: 'address at index.android.bundle' });
  });
});

describe('parseStack: Hermes-address frames with parentheses or an empty name, restored (review N3)', () => {
  it('a Hermes address frame whose file contains parentheses (an iOS app bundle name)', () => {
    const line = '    at bugseeE2EThrowSite (address at /My App (Beta).app/main.jsbundle:1:2)';
    expect(parseStack(line)).toEqual([
      {
        raw: line,
        file: 'address at /My App (Beta).app/main.jsbundle',
        methodName: 'bugseeE2EThrowSite',
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('a Hermes address frame with an empty name (two spaces before the parenthesis)', () => {
    const line = '    at  (address at index.android.bundle:1:2)';
    expect(parseStack(line)).toEqual([
      {
        raw: line,
        file: 'address at index.android.bundle',
        methodName: null,
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('a Hermes address frame with both an empty name and a file containing parentheses', () => {
    const line = '    at  (address at /My App (Beta).app/main.jsbundle:1:2)';
    expect(parseStack(line)).toEqual([
      {
        raw: line,
        file: 'address at /My App (Beta).app/main.jsbundle',
        methodName: null,
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('a Hermes address frame with a parenthesised file and no column', () => {
    const line = '    at n (address at /My App (Beta).app/main.jsbundle:1)';
    expect(parseStack(line)).toEqual([
      {
        raw: line,
        file: 'address at /My App (Beta).app/main.jsbundle',
        methodName: 'n',
        lineNumber: 1,
        column: null,
      },
    ]);
  });

  it("a name containing '(' is a known, accepted limitation (not restored)", () => {
    // Allowing '(' back into the *name* group would let it compete with
    // the file group over the same characters again -- the exact shape
    // C1/N1 removed it to avoid. An unrestricted name is rare in practice
    // (no captured fixture has one); a file containing parens, restored
    // above, is the realistic case (an iOS app bundle's display name).
    expect(parseStack('    at eval(app.js) (address at index.android.bundle:1:2)')).toEqual([]);
  });
});

describe('parseStack: real, captured multi-line stacks (review M2)', () => {
  it('a real V8 stack (node) parses every frame, including "node:" and anonymous ones', () => {
    const frames = parseStack(V8_NODE_SAMPLE);

    expect(frames).toHaveLength(10);
    expect(frames.map((f) => f.methodName)).toEqual([
      'level3',
      'level2',
      null, // an anonymous frame, no function name, no parentheses
      'Array.forEach', // CHROME_RE's "<anonymous>" file keyword
      'level1',
      'Object.<anonymous>',
      'Module._compile', // NODE_PAREN_RE: a "node:" file has no recognised scheme
      'Object..js',
      'Module.load',
      'Module._load',
    ]);
    expect(frames[2]).toMatchObject({ file: '/tmp/capture/sample.js', lineNumber: 9, column: 5 });
    expect(frames[3]).toMatchObject({ file: '<anonymous>' });
    expect(frames[6]).toMatchObject({
      file: 'node:internal/modules/cjs/loader',
      lineNumber: 1830,
      column: 14,
    });
  });

  it('a real JSC stack parses named, anonymous and space-containing frames, and drops the native one', () => {
    const frames = parseStack(JSC_SAMPLE);

    // "forEach@[native code]" has no location and is dropped (R9/"others
    // skipped"; 6.x kept it as `<unknown> () ()`, an intended change, M3).
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.methodName)).toEqual([
      'level3',
      'level2',
      null, // "@sample.js:9:11" -- an anonymous frame, empty name before "@"
      'level1',
      'global code', // a name containing a space
    ]);
    expect(frames[2]).toMatchObject({ file: 'sample.js', lineNumber: 9, column: 11 });
    expect(frames[4]).toMatchObject({ file: 'sample.js', lineNumber: 13, column: 9 });
  });

  it('a Hermes release-shaped stack parses "address at" and native frames', () => {
    const frames = parseStack(HERMES_RELEASE_SAMPLE);

    expect(frames).toHaveLength(4);
    expect(frames[0]).toMatchObject({
      file: 'address at index.android.bundle',
      methodName: 'bugseeE2EThrowSite',
    });
    expect(frames[2]).toMatchObject({ file: 'address at InternalBytecode.js' });
    expect(frames[3]).toMatchObject({ file: null, methodName: 'forEach' });
  });

  it('a Hermes debug-shaped (Metro URL) stack parses both frames', () => {
    const frames = parseStack(HERMES_DEBUG_SAMPLE);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.file).toBe(
      'http://localhost:8081/index.bundle//&platform=android&dev=true&minify=false',
    );
  });

  it("a real React 19 componentStack (Hermes shape) parses the user component and the built-in's <anonymous>", () => {
    const frames = parseStack(COMPONENT_STACK_SAMPLE_HERMES);

    expect(frames).toEqual([
      {
        raw: '    at MyScreen (App.js:42:10)',
        file: 'App.js',
        methodName: 'MyScreen',
        lineNumber: 42,
        column: 10,
      },
      {
        raw: '    at View (<anonymous>)',
        file: '<anonymous>',
        methodName: 'View',
        lineNumber: null,
        column: null,
      },
      {
        raw: '    at App (index.js:7:5)',
        file: 'index.js',
        methodName: 'App',
        lineNumber: 7,
        column: 5,
      },
    ]);
  });

  it("a real React 19 componentStack (JSC shape) parses the user component and the built-in's unknown:0:0", () => {
    const frames = parseStack(COMPONENT_STACK_SAMPLE_JSC);

    expect(frames).toEqual([
      {
        raw: 'MyScreen@App.js:42:10',
        file: 'App.js',
        methodName: 'MyScreen',
        lineNumber: 42,
        column: 10,
      },
      {
        raw: 'View@unknown:0:0',
        file: 'unknown',
        methodName: 'View',
        lineNumber: 0,
        column: 0,
      },
      {
        raw: 'App@index.js:7:5',
        file: 'index.js',
        methodName: 'App',
        lineNumber: 7,
        column: 5,
      },
    ]);
  });
});
