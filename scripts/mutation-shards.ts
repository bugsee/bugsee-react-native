/**
 * Splits a Stryker gate into shards that run as parallel CI jobs, and puts
 * their reports back together so the gate's `break` is enforced on the whole.
 *
 * Stryker 10 has no sharding of its own. What it has is `mutate` entries of
 * the form `file:startLine-endLine`, and a mutant is placed only when its
 * whole location lies inside one of the file's ranges. So a range boundary
 * that falls inside a mutant (a function body's BlockStatement spans the
 * whole function) silently drops that mutant from every shard. The plan below
 * only ever cuts between lines no mutant spans, and the ranges of one file
 * meet end to end, so every line and every mutant lands in exactly one shard.
 *
 * Everything here is pure; scripts/cli-mutation.ts does the I/O and asks
 * Stryker's own instrumenter where the mutants are.
 */

/** One mutant's extent, in 1-based lines. */
export interface MutantSpan {
  startLine: number;
  endLine: number;
}

export interface FileMutants {
  /** Path relative to the repo root, as it appears in `mutate`. */
  name: string;
  /** Number of lines in the file, so a final range can run to its end. */
  lineCount: number;
  spans: readonly MutantSpan[];
}

/**
 * A run of mutants that has to stay in one shard: the lines from the first
 * one's start to the furthest end, with no line in between that a cut could
 * use.
 */
export interface MutantGroup {
  startLine: number;
  endLine: number;
  mutants: number;
}

export interface Shard {
  /** `mutate` entries: a bare path for a whole file, `path:a-b` for a slice. */
  mutate: string[];
  mutants: number;
}

/**
 * Groups a file's mutants into the smallest runs that can each go to a
 * different shard. Cutting after line L is safe only when no mutant starts
 * on or before L and ends after it.
 */
export function mutantGroups(spans: readonly MutantSpan[]): MutantGroup[] {
  const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const groups: MutantGroup[] = [];
  for (const span of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && span.startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, span.endLine);
      last.mutants += 1;
    } else {
      groups.push({ startLine: span.startLine, endLine: span.endLine, mutants: 1 });
    }
  }
  return groups;
}

interface Unit extends MutantGroup {
  file: FileMutants;
  /** Index of this group within its file, and how many groups the file has. */
  index: number;
  of: number;
}

/**
 * Cuts the gate's mutants into `n` shards of as even a mutant count as the
 * safe cut points allow. Files keep their order, so a shard is a contiguous
 * stretch of the sorted file list, whole files in the middle and at most a
 * slice at either end. Files without a single mutant are left out: they add
 * nothing to any score.
 */
export function planShards(files: readonly FileMutants[], n: number): Shard[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, got ${n}`);
  const units: Unit[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const groups = mutantGroups(file.spans);
    groups.forEach((group, index) => units.push({ ...group, file, index, of: groups.length }));
  }
  if (units.length < n) {
    throw new Error(`cannot cut ${units.length} indivisible mutant group(s) into ${n} shards; use fewer shards`);
  }

  // Each shard aims at an equal part of what the shards before it left over,
  // and takes a group only while that brings it closer to the aim. Never
  // fewer groups left than shards still to open, so no shard comes out empty.
  const runs: Unit[][] = [[]];
  let rest = units.reduce((sum, unit) => sum + unit.mutants, 0);
  let load = 0;
  units.forEach((unit, i) => {
    const current = runs[runs.length - 1]!;
    const shardsLeft = n - runs.length;
    const aim = rest / (shardsLeft + 1);
    const overshoots = load + unit.mutants / 2 > aim;
    if (current.length > 0 && shardsLeft > 0 && (overshoots || units.length - i === shardsLeft)) {
      rest -= load;
      runs.push([unit]);
      load = unit.mutants;
    } else {
      current.push(unit);
      load += unit.mutants;
    }
  });

  return runs.map((run) => ({
    mutate: toMutateEntries(run),
    mutants: run.reduce((sum, unit) => sum + unit.mutants, 0),
  }));
}

function toMutateEntries(run: readonly Unit[]): string[] {
  const entries: string[] = [];
  let i = 0;
  while (i < run.length) {
    const first = run[i]!;
    let j = i;
    while (j + 1 < run.length && run[j + 1]!.file === first.file) j += 1;
    const last = run[j]!;
    const { file } = first;
    if (first.index === 0 && last.index === last.of - 1) {
      entries.push(file.name);
    } else {
      // A slice starts right after the previous group's last line (or at the
      // top of the file) and ends on its own last group's last line (or at
      // the bottom), so consecutive slices of one file leave no line out.
      const groups = mutantGroups(file.spans);
      const start = first.index === 0 ? 1 : groups[first.index - 1]!.endLine + 1;
      const end = last.index === last.of - 1 ? file.lineCount : last.endLine;
      entries.push(`${file.name}:${start}-${end}`);
    }
    i = j + 1;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Reports

/** The parts of Stryker's JSON report (mutation-testing-report-schema) used here. */
export interface ReportMutant {
  id: string;
  killedBy?: string[];
  coveredBy?: string[];
  [key: string]: unknown;
}

export interface ReportFile {
  mutants: ReportMutant[];
  [key: string]: unknown;
}

export interface ReportTest {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface MutationReport {
  files: Record<string, ReportFile>;
  testFiles?: Record<string, { tests: ReportTest[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Merges shard reports into one report of the whole gate. Mutant ids are only
 * unique within a run, so each shard's are prefixed with its position. Test
 * ids are numbers Stryker hands out per run as well; a test is the same test
 * in every shard when its file and name match, so those get one merged id and
 * every killedBy/coveredBy is rewritten to it.
 */
export function mergeReports(reports: readonly MutationReport[]): MutationReport {
  if (reports.length === 0) throw new Error('no shard reports to merge');
  const files: Record<string, ReportFile> = {};
  const testFiles: Record<string, { tests: ReportTest[]; [key: string]: unknown }> = {};
  const mergedTestId = new Map<string, string>();

  reports.forEach((report, shard) => {
    const testIds = new Map<string, string>();
    for (const [fileName, testFile] of Object.entries(report.testFiles ?? {})) {
      const merged = (testFiles[fileName] ??= { ...testFile, tests: [] });
      for (const test of testFile.tests) {
        const key = `${fileName}\u0000${test.name}`;
        let id = mergedTestId.get(key);
        if (id === undefined) {
          id = String(mergedTestId.size);
          mergedTestId.set(key, id);
          merged.tests.push({ ...test, id });
        }
        testIds.set(test.id, id);
      }
    }
    const remap = (ids: string[] | undefined): string[] | undefined =>
      ids?.map((id) => testIds.get(id) ?? `${shard}-${id}`);

    for (const [fileName, file] of Object.entries(report.files)) {
      const mutants = file.mutants.map((mutant) => {
        const next: ReportMutant = { ...mutant, id: `${shard}-${mutant.id}` };
        if (mutant.killedBy !== undefined) next.killedBy = remap(mutant.killedBy);
        if (mutant.coveredBy !== undefined) next.coveredBy = remap(mutant.coveredBy);
        return next;
      });
      const existing = files[fileName];
      if (existing === undefined) files[fileName] = { ...file, mutants };
      else existing.mutants.push(...mutants);
    }
  });

  const merged: MutationReport = { ...reports[0], files };
  if (Object.keys(testFiles).length > 0) merged.testFiles = testFiles;
  else delete merged.testFiles;
  return merged;
}

export function countMutants(report: MutationReport): number {
  return Object.values(report.files).reduce((sum, file) => sum + file.mutants.length, 0);
}

// ---------------------------------------------------------------------------
// Which gates a change touches

/**
 * Changes to any of these can move every gate's result: the toolchain and its
 * lockfile, the shared Jest config (in package.json), the TypeScript configs
 * the tests compile with, the workflows, and the sharding itself.
 */
export const ALL_GATES_TRIGGERS: readonly string[] = [
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  '.yarn/',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.mutation.json',
  '.github/workflows/ci.yml',
  '.github/workflows/mutation-gate.yml',
  'scripts/mutation-shards.ts',
  'scripts/cli-mutation.ts',
];

/**
 * The fixed leading part of a glob: up to the last `/` before the first glob
 * character, or the whole pattern when it has none. Matching a changed path
 * against that prefix can only ever over-select a gate, never miss one.
 */
export function globPrefix(glob: string): string {
  const pattern = glob.replace(/^<rootDir>\//, '').replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, '');
  const firstMagic = pattern.search(/[*?[{(!]/);
  if (firstMagic === -1) return pattern;
  return pattern.slice(0, pattern.lastIndexOf('/', firstMagic) + 1);
}

/**
 * Files a gate's tests read at runtime, beyond what they import: the corpus a
 * mutated parser is scored against. A change there can turn a killed mutant
 * into a survivor with every test still green, so it selects the gate. Kept
 * wide on purpose; when in doubt, a gate runs.
 *
 * scripts: single-source and platform-floors read the Gradle, Swift and SPM
 * manifests and native-versions.json; raw-messages-tree walks packages/;
 * docs-versions reads docs/. src: option-manifest-parity reads
 * native-versions.json through scripts/native-versions.ts, and types its
 * manifest with scripts/option-keys.ts.
 */
export const GATE_INPUTS: Readonly<Record<string, readonly string[]>> = {
  scripts: [
    'packages/',
    'docs/',
    'examples/',
    'gradle/',
    'native-versions.json',
    'settings.gradle',
    'gradle.properties',
  ],
  src: ['native-versions.json', 'scripts/native-versions.ts', 'scripts/option-keys.ts'],
};

/** What a gate's path filter is made of: its Stryker config and what it reads. */
export interface GateScope {
  name: string;
  /** The gate's own config file, e.g. `stryker.src.json`. */
  configFile: string;
  /** Its `mutate` patterns. Negations are ignored, which only widens the filter. */
  mutate: readonly string[];
  /**
   * The Jest `testMatch` the gate runs with. Absent means the repo-wide
   * default, and then any change at all selects the gate.
   */
  testMatch?: readonly string[];
}

/** The gates a pull request's changed files can affect, in the order given. */
export function gatesForChanges(gates: readonly GateScope[], changed: readonly string[]): string[] {
  const under = (prefixes: readonly string[]) => (file: string) =>
    prefixes.some((prefix) =>
      prefix === '' || (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix),
    );
  if (changed.some(under(ALL_GATES_TRIGGERS))) return gates.map((gate) => gate.name);
  return gates
    .filter((gate) => {
      if (gate.testMatch === undefined) return changed.length > 0;
      const prefixes = [
        gate.configFile,
        ...(Object.hasOwn(GATE_INPUTS, gate.name) ? GATE_INPUTS[gate.name]! : []),
        ...[...gate.mutate, ...gate.testMatch].filter((p) => !p.startsWith('!')).map(globPrefix),
      ];
      return changed.some(under(prefixes));
    })
    .map((gate) => gate.name);
}
