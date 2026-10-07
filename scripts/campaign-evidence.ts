/**
 * The beta campaign's evidence collector (plan N-26, section 4.2), pure half.
 * scripts/cli-campaign-evidence.ts reads the files and writes the outputs.
 *
 * In:  the plan's checklist rows (IDs, items and their `suite > title`
 *      proofs), Jest `--json` results of every device/build run, filed as
 *      `<root>/<lane>/<target>/<item-or-suite>-r<k>-<UTC>.json` by
 *      scripts/cli-campaign-run.ts, the `it.failing` sidecar the campaign
 *      test environment writes next to each, and manual cells (CSV).
 * Out: the section 4.2 table (Markdown) and the same rows as CSV.
 *
 * How a test result counts toward an item:
 *   - its full name carries the item's ID in brackets, e.g. `[API-01c]`;
 *   - or the item's proof names it as `suite > title` (a title ending in
 *     `...` matches as a prefix);
 *   - or the run's file name starts with the item's ID
 *     (`MX-RN-83-smoke-r1-...`): then every test of that run counts.
 * Per run, an item passes when every counted test passed and fails when
 * any failed; a run in which every counted test was skipped does not count.
 * A test that ran as `it.failing` (the sidecar says so) and "passed" is the
 * known bug still failing: the run counts as FAIL (known).
 */

export const TARGETS = ['A', 'S', 'X', 'B', 'STG'] as const;
export type Target = (typeof TARGETS)[number];

export interface PlanItem {
  readonly id: string;
  readonly item: string;
  /** `suite > title` proofs named in the row. */
  readonly proofs: readonly string[];
}

const ID_CELL = /^([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)/;

/** The IDs a first cell names: `X-1`, or a range `X-81 .. X-87`, or a list `X-54/55/56`. */
export function idsOfCell(cell: string): string[] {
  const text = cell.trim();
  const range = /^([A-Z][A-Z0-9-]*-)(\d+)\s*\.\.\s*\1(\d+)\b/.exec(text);
  if (range !== null) {
    const out: string[] = [];
    for (let n = Number(range[2]); n <= Number(range[3]); n += 1) {
      out.push(`${range[1]}${n}`);
    }
    return out;
  }
  const list = /^([A-Z][A-Z0-9-]*-)(\d+(?:\/\d+)+)\b/.exec(text);
  if (list !== null) {
    return list[2]!.split('/').map(n => `${list[1]}${n}`);
  }
  const single = ID_CELL.exec(text);
  return single === null ? [] : [single[1]!];
}

function cellsOf(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim());
}

/**
 * The checklist rows: every table row from section 0.4 (gate G0) through
 * section 1 whose first cell is an ID. Header and separator rows are not.
 */
export function parsePlan(markdown: string): PlanItem[] {
  const items: PlanItem[] = [];
  let inScope = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{2,3} 0\.4\b/.test(line)) {
      inScope = true;
      continue;
    }
    if (/^## 2\./.test(line)) {
      break;
    }
    if (!inScope || !line.trimStart().startsWith('|')) {
      continue;
    }
    const cells = cellsOf(line);
    const ids = idsOfCell(cells[0] ?? '');
    if (ids.length === 0) {
      continue;
    }
    const proofs = [...line.matchAll(/`([^`]+?)`/g)]
      .map(match => match[1]!)
      .filter(text => /^[\w-]+ > \S/.test(text));
    for (const id of ids) {
      items.push({ id, item: cells[1] ?? '', proofs });
    }
  }
  return items;
}

/** One test's result in one run. */
export interface TestResult {
  readonly suite: string;
  /** Describe titles and the test title, joined by spaces (Jest's `fullName`). */
  readonly fullName: string;
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  /** Declared `it.failing` (from the sidecar). */
  readonly failing: boolean;
}

export interface RunRecord {
  readonly lane: string;
  readonly target: Target;
  /** The file's base name without `.json`: `<item-or-suite>-r<k>-<UTC>`. */
  readonly name: string;
  /** Path relative to the log root, for the evidence column. */
  readonly path: string;
  readonly tests: readonly TestResult[];
}

/** `<lane>/<target>/<name>.json`, relative to the root; undefined when it is not one. */
export function runPathParts(relative: string): { lane: string; target: Target; name: string } | undefined {
  const match = /^([^/]+)\/([^/]+)\/([^/]+)\.json$/.exec(relative.replace(/\\/g, '/'));
  if (match === null || !(TARGETS as readonly string[]).includes(match[2]!)) {
    return undefined;
  }
  return { lane: match[1]!, target: match[2] as Target, name: match[3]! };
}

interface JestJson {
  readonly testResults?: ReadonlyArray<{
    readonly name?: string;
    readonly testFilePath?: string;
    readonly assertionResults?: ReadonlyArray<{
      readonly fullName?: string;
      readonly title?: string;
      readonly status?: string;
    }>;
  }>;
}

/** The suite a test file is: `.../launch.test.ts` -> `launch`. */
export function suiteOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return base.replace(/\.test\.[cm]?[jt]sx?$/, '');
}

/**
 * Jest `--json` output, with the `it.failing` sidecar (one JSON line per
 * test: `{"fullName": ..., "failing": true|false}`).
 */
export function parseJestJson(json: string, sidecar = ''): TestResult[] {
  const failing = new Set<string>();
  for (const line of sidecar.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const entry = JSON.parse(line) as { fullName?: unknown; failing?: unknown };
    if (entry.failing === true && typeof entry.fullName === 'string') {
      failing.add(entry.fullName);
    }
  }
  const parsed = JSON.parse(json) as JestJson;
  const out: TestResult[] = [];
  for (const file of parsed.testResults ?? []) {
    const suite = suiteOf(file.testFilePath ?? file.name ?? '');
    for (const assertion of file.assertionResults ?? []) {
      const fullName = assertion.fullName ?? '';
      const status = assertion.status === 'passed' ? 'passed' : assertion.status === 'failed' ? 'failed' : 'skipped';
      out.push({ suite, fullName, title: assertion.title ?? '', status, failing: failing.has(fullName) });
    }
  }
  return out;
}

/** Whether `proof` (`suite > title`, maybe ending in `...`) names `test`. */
export function proofMatches(proof: string, test: TestResult): boolean {
  const split = proof.indexOf(' > ');
  if (split < 0) {
    return false;
  }
  const suite = proof.slice(0, split).trim();
  if (suite !== test.suite) {
    return false;
  }
  const title = proof.slice(split + 3).trim();
  if (title.endsWith('...')) {
    const prefix = title.slice(0, -3);
    return test.title.startsWith(prefix) || test.fullName.includes(prefix);
  }
  return test.title === title || test.fullName.endsWith(` ${title}`) || test.fullName === title;
}

function tagged(id: string, test: TestResult): boolean {
  return test.fullName.includes(`[${id}]`);
}

function runIsFor(id: string, run: RunRecord): boolean {
  return run.name === id || run.name.startsWith(`${id}-`);
}

export type RunOutcome = 'pass' | 'fail' | 'known';

/** What one run says about one item, or undefined when it says nothing. */
export function outcomeOf(item: PlanItem, run: RunRecord): RunOutcome | undefined {
  const whole = runIsFor(item.id, run);
  const counted = run.tests.filter(
    test => whole || tagged(item.id, test) || item.proofs.some(proof => proofMatches(proof, test)),
  );
  const ran = counted.filter(test => test.status !== 'skipped');
  if (ran.length === 0) {
    return undefined;
  }
  if (ran.some(test => test.status === 'failed')) {
    return 'fail';
  }
  return ran.some(test => test.failing) ? 'known' : 'pass';
}

/** One cell in section 4.2's vocabulary, from a target's run outcomes. */
export function cellOf(outcomes: readonly RunOutcome[]): string {
  if (outcomes.length === 0) {
    return '-';
  }
  const m = outcomes.length;
  const passes = outcomes.filter(o => o === 'pass').length;
  const known = outcomes.filter(o => o === 'known').length;
  // `(known)` only when every run is the pinned bug: a real failure next to
  // it is a failure, never signed off as the known one.
  if (known === m) {
    return `FAIL ${m}/${m} (known)`;
  }
  if (passes === m) {
    return `PASS ${m}/${m}`;
  }
  if (passes === 0) {
    return `FAIL ${m}/${m}`;
  }
  return `FLAKY ${passes}/${m}`;
}

const SEVERITY: ReadonlyArray<[RegExp, number]> = [
  [/^FAIL\b(?!.*\(known\))/, 6],
  [/^FAIL\b/, 5],
  [/^FLAKY\b/, 4],
  [/^BLOCKED\b/, 3],
  [/^PASS\b/, 1],
];

/**
 * The worst cell: FAIL, then FAIL (known), then FLAKY, then BLOCKED, then
 * PASS; N/A and `-` do not count.
 */
export function verdictOf(cells: readonly string[]): string {
  let worst: { rank: number; cell: string } | undefined;
  for (const cell of cells) {
    const rank = SEVERITY.find(([pattern]) => pattern.test(cell))?.[1];
    if (rank !== undefined && (worst === undefined || rank > worst.rank)) {
      worst = { rank, cell };
    }
  }
  if (worst === undefined) {
    return cells.some(cell => cell.startsWith('N/A')) ? 'N/A' : 'NOT RUN';
  }
  const word = worst.cell.split(' ')[0]!;
  return worst.cell.includes('(known)') ? `${word} (known)` : word;
}

/** A cell given by hand (manual, staging, build): overrides the computed one. */
export interface ManualCell {
  readonly id: string;
  readonly target: Target;
  readonly cell: string;
  readonly evidence: string;
}

/** `id,target,cell,evidence` CSV with a header row; quoted fields allowed. */
export function parseManualCsv(text: string): ManualCell[] {
  const rows = parseCsv(text);
  const out: ManualCell[] = [];
  for (const row of rows.slice(1)) {
    if (row.length === 0 || (row.length === 1 && row[0] === '')) {
      continue;
    }
    const [id, target, cell, evidence] = row;
    if (!(TARGETS as readonly string[]).includes(target ?? '')) {
      throw new Error(`manual cells: unknown target ${JSON.stringify(target)} for ${String(id)}`);
    }
    out.push({ id: id!, target: target as Target, cell: cell ?? '', evidence: evidence ?? '' });
  }
  return out;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface EvidenceRow {
  readonly id: string;
  readonly item: string;
  readonly cells: Readonly<Record<Target, string>>;
  readonly verdict: string;
  readonly evidence: string;
}

/** Every plan item's row, from the runs and the manual cells. */
export function buildRows(items: readonly PlanItem[], runs: readonly RunRecord[], manual: readonly ManualCell[]): EvidenceRow[] {
  return items.map(item => {
    const cells = {} as Record<Target, string>;
    const evidence: string[] = [];
    for (const target of TARGETS) {
      const counted = runs
        .filter(run => run.target === target)
        .map(run => ({ run, outcome: outcomeOf(item, run) }))
        .filter((entry): entry is { run: RunRecord; outcome: RunOutcome } => entry.outcome !== undefined);
      cells[target] = cellOf(counted.map(entry => entry.outcome));
      if (counted.length > 0) {
        const paths = counted.map(entry => entry.run.path);
        evidence.push(`${target}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3})` : ''}`);
      }
    }
    for (const cell of manual.filter(entry => entry.id === item.id)) {
      cells[cell.target] = cell.cell;
      if (cell.evidence !== '') {
        evidence.push(`${cell.target}: ${cell.evidence}`);
      }
    }
    return { id: item.id, item: item.item, cells, verdict: verdictOf(TARGETS.map(t => cells[t])), evidence: evidence.join('; ') };
  });
}

/** Replaces every occurrence of each secret with `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets.filter(s => s.length >= 8)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMarkdown(rows: readonly EvidenceRow[], header: readonly string[], secrets: readonly string[]): string {
  const lines = [
    '# Beta campaign evidence',
    '',
    ...header.map(line => `- ${line}`),
    '',
    '| ID | Item | A (WOD_LX1) | S (sim) | X (XS) | B | STG | Verdict | Evidence / notes |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row =>
      `| ${[row.id, row.item, ...TARGETS.map(t => row.cells[t]), row.verdict, row.evidence].map(mdCell).join(' | ')} |`,
    ),
    '',
  ];
  return redact(lines.join('\n'), secrets);
}

export function renderCsv(rows: readonly EvidenceRow[], secrets: readonly string[]): string {
  const lines = [
    'id,item,A,S,X,B,STG,verdict,evidence',
    ...rows.map(row => [row.id, row.item, ...TARGETS.map(t => row.cells[t]), row.verdict, row.evidence].map(csvField).join(',')),
    '',
  ];
  return redact(lines.join('\n'), secrets);
}
