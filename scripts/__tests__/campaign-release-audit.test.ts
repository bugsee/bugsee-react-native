import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RELEASE_SUBSET, auditSuite, codeOnly, matchingClose, renderAudit } from '../campaign-release-audit';

/**
 * Campaign N-28: every MX-CFG-RELEASE suite runs under E2E_RELEASE=1 or
 * skips with a stated reason; a Debug-only assertion is always gated.
 */
const E2E = join(__dirname, '..', '..', 'examples', 'bare', 'e2e');
/** Stryker's sandbox leaves `examples/` out (stryker.scripts.json ignorePatterns); `yarn test` has it. */
const itWithExamples = existsSync(E2E) ? it : it.skip;

describe('the e2e suites in the Release subset', () => {
  itWithExamples('all exist, and every Debug-only assertion sits in a debugOnly block', () => {
    const missing = RELEASE_SUBSET.filter(suite => !existsSync(join(E2E, `${suite}.test.ts`)));
    const audits = RELEASE_SUBSET.filter(suite => !missing.includes(suite)).map(suite =>
      auditSuite(suite, readFileSync(join(E2E, `${suite}.test.ts`), 'utf8')),
    );
    const { text, ok } = renderAudit(audits, missing);
    expect({ ok, text }).toEqual({ ok: true, text: expect.stringContaining('OK: every suite runs or skips with a stated reason.') });
    // exceptions.test.ts is the one with Debug cases: they are gated, with a reason.
    const exceptions = audits.find(audit => audit.suite === 'exceptions')!;
    expect(exceptions.debugAssertions).toBeGreaterThan(0);
    expect(exceptions.gates.every(gate => gate.reason.length > 20)).toBe(true);
  });
});

describe('codeOnly', () => {
  it('blanks comments and string bodies, keeping offsets, newlines and delimiters', () => {
    const source = "a('x)y'); // c(\n/* d{ */ b(`t}`, \"q\\\"(\")";
    const code = codeOnly(source);
    expect(code).toHaveLength(source.length);
    expect(code).toBe("a('   ');      \n         b(`  `, \"    \")");
  });

  it('survives an unterminated comment or string', () => {
    expect(codeOnly('a /* x')).toBe('a     ');
    expect(codeOnly("a 'x")).toBe("a ' ");
    expect(codeOnly('a // x')).toBe('a     ');
  });
});

describe('matchingClose', () => {
  it('finds the matching bracket across nesting', () => {
    const code = 'f(a, [b], {c: (d)}) + g()';
    expect(matchingClose(code, 1)).toBe(18);
    expect(matchingClose(code, 5)).toBe(7);
    expect(matchingClose(code, 10)).toBe(17);
  });

  it('is -1 on a mismatch or no close', () => {
    expect(matchingClose('f(a]', 1)).toBe(-1);
    expect(matchingClose('f(a', 1)).toBe(-1);
  });
});

describe('auditSuite', () => {
  it('a suite with no Debug-only assertion runs', () => {
    expect(auditSuite('x', "it('a', () => { expect(run.dev).toBe(false); });")).toEqual({
      suite: 'x',
      gates: [],
      ungated: [],
      debugAssertions: 0,
    });
  });

  it('flags an ungated Debug-only assertion with its line', () => {
    const source = "describe('a', () => {\n  beforeAll(() => {\n    expect(run.dev).toBe(true);\n  });\n});\n";
    expect(auditSuite('x', source)).toEqual({ suite: 'x', gates: [], ungated: [3], debugAssertions: 1 });
  });

  it('accepts an assertion inside a block opened through a debugOnly-declared name, with a literal or constant reason', () => {
    const source = [
      "const WHY = 'asserts a Debug bundle';",
      'const describeDebug = debugOnly(describe, WHY);',
      "const itDebug = debugOnly(it, 'a literal reason');",
      "describeDebug('a', () => {",
      '  beforeAll(() => { expect(crashRun.dev).toBe(true); });',
      '});',
      "itDebug('b', () => { expect( r.dev ).toBe( true ); });",
      "describe('c', () => { expect(x.dev).toBe(true); });",
    ].join('\n');
    const audit = auditSuite('x', source);
    expect(audit.gates).toEqual([
      { line: 2, reason: 'asserts a Debug bundle' },
      { line: 3, reason: 'a literal reason' },
    ]);
    expect(audit.ungated).toEqual([8]);
    expect(audit.debugAssertions).toBe(3);
  });

  it('accepts an inline debugOnly(fn, reason)(...) call', () => {
    const source = "debugOnly(it, 'inline')('a', () => {\n  expect(run.dev).toBe(true);\n});\n";
    const audit = auditSuite('x', source);
    expect(audit.gates).toEqual([{ line: 1, reason: 'inline' }]);
    expect(audit.ungated).toEqual([]);
  });

  it('an unresolvable reason constant is named, and a gate name used as a property does not count', () => {
    const source = "let gate = debugOnly(it, REASON);\nobj.gate('x', () => { expect(run.dev).toBe(true); });\n";
    const audit = auditSuite('x', source);
    expect(audit.gates).toEqual([{ line: 1, reason: '(REASON)' }]);
    expect(audit.ungated).toEqual([2]);
  });

  it('an assertion in a comment or a string is not one', () => {
    expect(auditSuite('x', "// expect(run.dev).toBe(true)\nconst s = 'expect(run.dev).toBe(true)';").debugAssertions).toBe(0);
  });
});

describe('renderAudit', () => {
  it('says RUNS, PARTIAL (with reasons) or FAIL per suite, and MISSING', () => {
    const { text, ok } = renderAudit(
      [
        { suite: 'a', gates: [], ungated: [], debugAssertions: 0 },
        { suite: 'b', gates: [{ line: 4, reason: 'why' }], ungated: [], debugAssertions: 1 },
      ],
      [],
    );
    expect(ok).toBe(true);
    expect(text).toContain('RUNS     a');
    expect(text).toContain('PARTIAL  b');
    expect(text).toContain('skips under Release (line 4): why');
    const failed = renderAudit([{ suite: 'c', gates: [], ungated: [9], debugAssertions: 1 }], ['d']);
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain('MISSING  d.test.ts');
    expect(failed.text).toContain('FAIL     c');
    expect(failed.text).toContain('Debug-only assertion with no debugOnly gate at line 9');
    expect(failed.text).toContain('FAIL: see above.');
    expect(renderAudit([], ['e']).ok).toBe(false);
  });
});

describe('the audit, at its edges', () => {
  it('codeOnly keeps a block comment line structure and leaves division alone', () => {
    expect(codeOnly('a /* x\ny */ b')).toBe('a     \n     b');
    expect(codeOnly('a / b * c')).toBe('a / b * c');
    expect(codeOnly('x = 1 /2*/')).toBe('x = 1 /2*/');
    expect(codeOnly('a //x\nb')).toBe('a    \nb');
  });

  it('reads gates written with spacing, collapses a multi-line reason, and accepts let', () => {
    const source = [
      'let  gateA  =  debugOnly(  describe  ,   `two',
      '   lines`  );',
      "gateA('a', () => { expect(run.dev).toBe(true); });",
    ].join('\n');
    const audit = auditSuite('x', source);
    expect(audit.gates).toEqual([{ line: 1, reason: 'two lines' }]);
    expect(audit.ungated).toEqual([]);
  });

  it('a multi-line constant reason resolves', () => {
    const source = "const R = 'a\n  b';\nconst g = debugOnly(it, R);\n";
    expect(auditSuite('x', source).gates).toEqual([{ line: 3, reason: 'a b' }]);
  });

  it('an assertion written with spacing still counts, and one before the gate call is outside it', () => {
    const source = [
      'expect( run.dev ) .toBe( true );',
      "const g = debugOnly(it, 'r');",
      "g('a', () => { expect(run.dev)\n  .toBe(true); });",
    ].join('\n');
    const audit = auditSuite('x', source);
    expect(audit.debugAssertions).toBe(2);
    expect(audit.ungated).toEqual([1]);
  });

  it('an unclosed gate call covers the rest of the file', () => {
    const source = "const g = debugOnly(it, 'r');\ng('a', () => {\n  expect(run.dev).toBe(true);\n";
    expect(auditSuite('x', source).ungated).toEqual([]);
  });

  it('an inline gate with space before its call still opens a span', () => {
    const source = "debugOnly(it, 'r') ('a', () => { expect(run.dev).toBe(true); });";
    expect(auditSuite('x', source).ungated).toEqual([]);
  });

  it('the report starts with its title and a blank line', () => {
    const { text } = renderAudit([], []);
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Release-subset audit (E2E_RELEASE=1), plan MX-CFG-RELEASE / N-28',
      '',
      '',
    ]);
  });
});
