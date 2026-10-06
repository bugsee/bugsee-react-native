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
 * One group can still be bigger than a shard should be: a long function whose
 * BlockStatement mutant spans every other mutant in it. Such a group is split
 * by mutator instead, into shards of their own that each mutate the group's
 * lines with the other mutators excluded (`mutator.excludedMutations`).
 * That is not quite a partition: Stryker reports an excluded mutant as
 * Ignored, and the CallExpression mutator drops a statement's mutant only
 * when another live mutant sits inside the statement, so with those
 * excluded it places a few mutants the whole run never has. The merge keeps
 * from such a shard exactly the mutants the whole gate has (by `mutantKey`)
 * of the mutators the shard kept, so each mutant comes from the one shard
 * that ran it.
 *
 * Everything here is pure; scripts/cli-mutation.ts does the I/O and asks
 * Stryker's own instrumenter where the mutants are.
 */

/** One mutant's extent, in 1-based lines. */
export interface MutantSpan {
  startLine: number;
  endLine: number;
  /** Stryker's mutator name, e.g. `ConditionalExpression`. */
  mutator: string;
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
  /** How many of them each mutator makes. */
  byMutator: Map<string, number>;
}

export interface Shard {
  /** `mutate` entries: a bare path for a whole file, `path:a-b` for a slice. */
  mutate: string[];
  mutants: number;
  /** Mutators this shard leaves to others: set only on a split group's shards. */
  excludedMutations?: string[];
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
      last.byMutator.set(span.mutator, (last.byMutator.get(span.mutator) ?? 0) + 1);
    } else {
      groups.push({
        startLine: span.startLine,
        endLine: span.endLine,
        mutants: 1,
        byMutator: new Map([[span.mutator, 1]]),
      });
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
 * slice at either end. A group bigger than an even share gets shards of its
 * own, split by mutator (see the top of this file). Files without a single
 * mutant are left out: they add nothing to any score.
 */
export function planShards(files: readonly FileMutants[], n: number): Shard[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, got ${n}`);
  const units: Unit[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const groups = mutantGroups(file.spans);
    groups.forEach((group, index) => units.push({ ...group, file, index, of: groups.length }));
  }
  const total = units.reduce((sum, unit) => sum + unit.mutants, 0);
  const share = total / n;

  // How many shards each oversized group takes: enough for an even share
  // each, but no more than it has mutators, and leaving at least one shard
  // for everything else.
  const heavy = new Map<Unit, number>();
  for (const unit of units) {
    if (n > 1 && unit.mutants > share) {
      heavy.set(unit, Math.min(Math.ceil(unit.mutants / share), unit.byMutator.size));
    }
  }
  const light = units.filter((unit) => !heavy.has(unit));
  const heavyShards = () => [...heavy.values()].reduce((sum, k) => sum + k, 0);
  const reserved = light.length > 0 ? 1 : 0;
  while (heavyShards() + reserved > n) {
    const [unit, k] = [...heavy].sort((a, b) => b[1] - a[1])[0]!;
    if (k > 1) heavy.set(unit, k - 1);
    else heavy.delete(unit);
  }
  for (const [unit, k] of heavy) if (k < 2) heavy.delete(unit);
  const rest = units.filter((unit) => !heavy.has(unit));
  const restShards = n - heavyShards();
  if (rest.length < restShards) {
    throw new Error(`cannot cut ${units.length} indivisible mutant group(s) into ${n} shards; use fewer shards`);
  }

  const shards: Shard[] = cutInOrder(rest, restShards).map((run) => ({
    mutate: toMutateEntries(run),
    mutants: run.reduce((sum, unit) => sum + unit.mutants, 0),
  }));
  for (const [unit, k] of heavy) shards.push(...splitByMutator(unit, k));
  return shards;
}

/**
 * Each shard aims at an equal part of what the shards before it left over,
 * and takes a group only while that brings it closer to the aim. Never fewer
 * groups left than shards still to open, so no shard comes out empty.
 */
function cutInOrder(units: readonly Unit[], n: number): Unit[][] {
  if (n === 0) return [];
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
  return runs;
}

/** Deals a group's mutators, biggest first, onto the least loaded of `k` shards. */
function splitByMutator(unit: Unit, k: number): Shard[] {
  const bins = Array.from({ length: k }, () => ({ mutators: [] as string[], mutants: 0 }));
  const byCount = [...unit.byMutator].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [mutator, count] of byCount) {
    const bin = bins.reduce((min, b) => (b.mutants < min.mutants ? b : min));
    bin.mutators.push(mutator);
    bin.mutants += count;
  }
  const all = [...unit.byMutator.keys()].sort();
  const mutate = toMutateEntries([unit]);
  return bins.map((bin) => ({
    mutate,
    mutants: bin.mutants,
    excludedMutations: all.filter((mutator) => !bin.mutators.includes(mutator)),
  }));
}

function toMutateEntries(run: readonly Unit[]): string[] {
  const entries: string[] = [];
  let i = 0;
  while (i < run.length) {
    const first = run[i]!;
    let j = i;
    // One entry per stretch of consecutive groups: a split group taken out of
    // the middle of a file leaves this run two stretches of it.
    while (j + 1 < run.length && run[j + 1]!.file === first.file && run[j + 1]!.index === run[j]!.index + 1) j += 1;
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
  mutatorName?: string;
  replacement?: string;
  location?: { start: { line: number; column: number }; end: { line: number; column: number } };
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

/** Identifies a mutant across runs: file, mutator, replacement and 1-based location. */
export function mutantKey(
  fileName: string,
  mutant: {
    mutatorName?: unknown;
    replacement?: unknown;
    location?: { start: { line: number; column: number }; end: { line: number; column: number } };
  },
): string {
  const loc = mutant.location;
  const where = loc ? `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}` : '?';
  return [fileName, String(mutant.mutatorName), String(mutant.replacement), where].join('\u0000');
}

/**
 * Merges shard reports into one report of the whole gate. Mutant ids are only
 * unique within a run, so each shard's are prefixed with its position. Test
 * ids are numbers Stryker hands out per run as well; a test is the same test
 * in every shard when its file and name match, so those get one merged id and
 * every killedBy/coveredBy is rewritten to it. When `keep[i]` is given, only
 * the mutants of shard i whose `mutantKey` it holds are taken.
 */
export function mergeReports(
  reports: readonly MutationReport[],
  keep: readonly (ReadonlySet<string> | undefined)[] = [],
): MutationReport {
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

    const own = keep[shard];
    for (const [fileName, file] of Object.entries(report.files)) {
      const ran = own === undefined ? file.mutants : file.mutants.filter((m) => own.has(mutantKey(fileName, m)));
      const mutants = ran.map((mutant) => {
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
  'scripts/jest-no-network.js',
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
 * manifest with scripts/option-keys.ts. plugin: its tests run the Hermes and
 * Xcode shell hooks and the Gradle hook next to the mutated scripts, read the
 * Gradle corpus and the compiled plugin under plugin/, and load the package
 * through its manifest and app.plugin.js.
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
  plugin: [
    'packages/react-native/plugin/',
    'packages/react-native/scripts/',
    'packages/react-native/package.json',
    'packages/react-native/app.plugin.js',
    'native-versions.json',
  ],
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
