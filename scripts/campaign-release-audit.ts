/**
 * The Release-subset audit (plan N-28, MX-CFG-RELEASE), pure half:
 * every suite in the Release subset either runs under `E2E_RELEASE=1` or
 * skips with a stated reason -- never fails because it was written for a
 * Debug build.
 *
 * What a suite says about itself, read from its source:
 *   - a Debug-only assertion, `expect(<run>.dev).toBe(true)`, must sit inside
 *     a block gated by the harness's `debugOnly(fn, reason)` (examples/bare
 *     e2e/harness.ts), which skips it under `E2E_RELEASE=1` and states why;
 *   - each `debugOnly(..., '<reason>')` is listed with its reason.
 * scripts/cli-campaign-release-audit.ts prints the table and fails on any
 * ungated Debug-only assertion; scripts/__tests__/campaign-release-audit.test.ts
 * runs the same check in `yarn test`.
 */

/** MX-CFG-RELEASE's suites (plan 1.9), as e2e file names without `.test.ts`. */
export const RELEASE_SUBSET = [
  'launch',
  'data',
  'console',
  'console-dedup',
  'exceptions',
  'js-crash',
  'network',
  'network-filter',
  'report-handler',
  'reporting',
  'apm',
  'attributes',
  'composed-debug-id',
  'wrapper-identity',
  'view-tree',
  'secure-component',
] as const;

/**
 * `source` with every comment and string/template body blanked to spaces,
 * same length, so offsets still line up and brackets inside text do not
 * count. String delimiters are kept.
 */
export function codeOnly(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let k = i + 1;
      while (k < source.length && source[k] !== ch) {
        k += source[k] === '\\' ? 2 : 1;
      }
      blank(i + 1, Math.min(k, source.length));
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** The offset of the bracket closing the one at `open` in `code` (from `codeOnly`), or -1. */
export function matchingClose(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]!;
    if (pairs[ch] !== undefined) {
      stack.push(pairs[ch]!);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) {
        return -1;
      }
      if (stack.length === 0) {
        return i;
      }
    }
  }
  return -1;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** The text of `const <name> = '<text>'` in `source`, or `(<name>)` when there is none. */
function constantText(source: string, name: string): string {
  const declared = new RegExp(`const\\s+${name}\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`, 's').exec(source);
  return declared === null ? `(${name})` : declared[2]!;
}

export interface DebugGate {
  readonly line: number;
  readonly reason: string;
}

export interface SuiteAudit {
  readonly suite: string;
  readonly gates: readonly DebugGate[];
  /** Line numbers of Debug-only assertions no `debugOnly` block covers. */
  readonly ungated: readonly number[];
  /** Debug-only assertions in all, gated or not. */
  readonly debugAssertions: number;
}

/** Audits one suite's source (see the top of this file). */
export function auditSuite(suite: string, source: string): SuiteAudit {
  const code = codeOnly(source);
  const gates: DebugGate[] = [];
  const gatedNames: string[] = [];
  for (const match of source.matchAll(/debugOnly\(\s*[\w.]+\s*,\s*(?:(['"`])((?:\\.|(?!\1).)*)\1|(\w+))\s*\)/gs)) {
    const reason = match[3] === undefined ? match[2]! : constantText(source, match[3]);
    gates.push({ line: lineOf(source, match.index!), reason: reason.replace(/\s+/g, ' ').trim() });
    const declared = /(?:const|let)\s+(\w+)\s*=\s*$/.exec(source.slice(0, match.index!));
    if (declared !== null) {
      gatedNames.push(declared[1]!);
    }
  }
  // Every call through a gate: `name(` or `debugOnly(...)(`, spanning its arguments.
  const spans: Array<[number, number]> = [];
  for (const name of gatedNames) {
    for (const call of code.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
      const open = call.index! + call[0].length - 1;
      spans.push([open, matchingClose(code, open)]);
    }
  }
  for (const call of code.matchAll(/debugOnly\(/g)) {
    const first = matchingClose(code, call.index! + 'debugOnly'.length);
    const rest = /^\s*\(/.exec(code.slice(first + 1));
    if (rest !== null) {
      const open = first + 1 + rest[0].length - 1;
      spans.push([open, matchingClose(code, open)]);
    }
  }
  const ungated: number[] = [];
  let debugAssertions = 0;
  for (const assertion of code.matchAll(/expect\(\s*[\w.]+\.dev\s*\)\s*\.toBe\(\s*true\s*\)/g)) {
    debugAssertions += 1;
    const at = assertion.index!;
    if (!spans.some(([from, to]) => from < at && (to < 0 || at < to))) {
      ungated.push(lineOf(source, at));
    }
  }
  return { suite, gates, ungated, debugAssertions };
}

/** The audit as a printable table, and whether it passed. */
export function renderAudit(audits: readonly SuiteAudit[], missing: readonly string[]): { text: string; ok: boolean } {
  const lines = ['Release-subset audit (E2E_RELEASE=1), plan MX-CFG-RELEASE / N-28', ''];
  for (const name of missing) {
    lines.push(`MISSING  ${name}.test.ts`);
  }
  for (const audit of audits) {
    const state = audit.ungated.length > 0 ? 'FAIL   ' : audit.gates.length > 0 ? 'PARTIAL' : 'RUNS   ';
    lines.push(`${state}  ${audit.suite}`);
    for (const gate of audit.gates) {
      lines.push(`           skips under Release (line ${gate.line}): ${gate.reason}`);
    }
    for (const line of audit.ungated) {
      lines.push(`           Debug-only assertion with no debugOnly gate at line ${line}`);
    }
  }
  const ok = missing.length === 0 && audits.every(audit => audit.ungated.length === 0);
  lines.push('', ok ? 'OK: every suite runs or skips with a stated reason.' : 'FAIL: see above.');
  return { text: lines.join('\n'), ok };
}
