/**
 * The CI side of the mutation gates (.github/workflows/mutation-gate.yml).
 * Deliberately thin: every decision lives in mutation-shards.ts, where it is
 * unit-tested; this file only reads and writes.
 *
 *   node scripts/cli-mutation.ts scope [--all]           stdin: changed paths
 *   node scripts/cli-mutation.ts plan  <gate> <shards>
 *   node scripts/cli-mutation.ts shard <gate> <shard> <shards>
 *   node scripts/cli-mutation.ts merge <gate> <shards>
 *
 * `scope` prints `gates=[...]` for $GITHUB_OUTPUT. `shard` writes the
 * shard's Stryker config to reports/mutation/<gate>/shard-<i>.stryker.json:
 * the gate's config with `mutate` cut down to the shard's slice, `break`
 * lifted (a slice's score means nothing on its own) and a JSON report. `merge`
 * puts those reports together, checks that it got every mutant the plan has,
 * and fails under the gate's `break` exactly as Stryker would have, through
 * the same mutation-testing-metrics calculation Stryker itself reports with.
 *
 * Stryker's instrumenter, minimatch and mutation-testing-metrics are loaded
 * from @stryker-mutator/core's own dependency tree, so the plan finds the
 * mutants the running Stryker will place, matches `mutate` the way it does,
 * and scores the way it does.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  countMutants,
  gatesForChanges,
  mergeReports,
  planShards,
  type FileMutants,
  type GateScope,
  type MutationReport,
  type Shard,
} from './mutation-shards.ts';

interface StrykerConfig {
  mutate: string[];
  reporters?: string[];
  thresholds?: { break?: number | null };
  mutator?: { plugins?: unknown[] | null; excludedMutations?: string[] };
  jest?: { config?: { testMatch?: string[] } };
  [key: string]: unknown;
}

interface Located {
  location: { start: { line: number }; end: { line: number } };
}
interface InstrumenterModule {
  Instrumenter: new (log: unknown) => {
    instrument(
      files: { name: string; mutate: true; content: string }[],
      options: { plugins: unknown[] | null; excludedMutations: string[]; ignorers: unknown[] },
    ): Promise<{ mutants: (Located & { fileName: string })[] }>;
  };
}
interface MetricsModule {
  calculateMutationTestMetrics(report: MutationReport): {
    systemUnderTestMetrics: { metrics: Record<string, number> };
  };
}

const repoRoot = join(import.meta.dirname, '..');
// Resolved on first use: `scope` runs before any install, on Node alone.
const core = () => createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
const fromCore = async <T>(name: string): Promise<T> =>
  (await import(pathToFileURL(core().resolve(name)).href)) as T;

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const configFile = (gate: string) => `stryker.${gate}.json`;
const readConfig = (gate: string) => readJson<StrykerConfig>(join(repoRoot, configFile(gate)));
const shardDir = (gate: string) => join(repoRoot, 'reports', 'mutation', gate);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function positiveInt(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${what} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** The files the gate's `mutate` selects, matched the way Stryker's ProjectReader does. */
function mutateFiles(config: StrykerConfig): string[] {
  const { minimatch } = core()('minimatch') as {
    minimatch: (path: string, pattern: string, options: { dot: boolean }) => boolean;
  };
  const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const matches = (file: string, pattern: string) =>
    minimatch(resolve(repoRoot, file), resolve(repoRoot, pattern), { dot: false });
  const selected = new Set<string>();
  for (const pattern of config.mutate) {
    if (/:\d+(?::\d+)?-\d+(?::\d+)?$/.test(pattern)) fail(`mutate ranges cannot be sharded: ${pattern}`);
    if (pattern.startsWith('!')) {
      for (const file of [...selected]) if (matches(file, pattern.slice(1))) selected.delete(file);
    } else {
      for (const file of tracked) if (matches(file, pattern)) selected.add(file);
    }
  }
  return [...selected].sort();
}

/** Every mutant the gate has, by file, as Stryker's own instrumenter places them. */
async function gateMutants(config: StrykerConfig): Promise<FileMutants[]> {
  const { Instrumenter } = await fromCore<InstrumenterModule>('@stryker-mutator/instrumenter');
  const quiet = (): undefined => undefined;
  const log = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].flatMap((level) => [
      [level, quiet],
      [`is${level[0]!.toUpperCase()}${level.slice(1)}Enabled`, (): boolean => false],
    ]),
  );
  const files = mutateFiles(config).map((name) => ({
    name,
    mutate: true as const,
    content: readFileSync(join(repoRoot, name), 'utf8'),
  }));
  const { mutants } = await new Instrumenter(log).instrument(files, {
    plugins: config.mutator?.plugins ?? null,
    excludedMutations: config.mutator?.excludedMutations ?? [],
    ignorers: [],
  });
  return files.map((file) => ({
    name: file.name,
    lineCount: file.content.split('\n').length,
    // The instrumenter's lines are 0-based; `mutate` ranges are 1-based.
    spans: mutants
      .filter((m) => m.fileName === file.name)
      .map((m) => ({ startLine: m.location.start.line + 1, endLine: m.location.end.line + 1 })),
  }));
}

async function plan(gate: string, shards: number): Promise<Shard[]> {
  return planShards(await gateMutants(readConfig(gate)), shards);
}

function scope(all: boolean): void {
  const gates: GateScope[] = readdirSync(repoRoot)
    .map((file) => /^stryker\.(.+)\.json$/.exec(file)?.[1])
    .filter((gate): gate is string => gate !== undefined)
    .sort()
    .map((name) => {
      const config = readConfig(name);
      return { name, configFile: configFile(name), mutate: config.mutate, testMatch: config.jest?.config?.testMatch };
    });
  const changed = all ? [] : readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const selected = all ? gates.map((gate) => gate.name) : gatesForChanges(gates, changed);
  console.log(`gates=${JSON.stringify(selected)}`);
}

async function shard(gate: string, index: number, shards: number): Promise<void> {
  if (index > shards) fail(`shard ${index} of ${shards} does not exist`);
  const config = readConfig(gate);
  const slice = (await plan(gate, shards))[index - 1]!;
  const dir = shardDir(gate);
  mkdirSync(dir, { recursive: true });
  const shardConfig = {
    ...config,
    mutate: slice.mutate,
    thresholds: { ...config.thresholds, break: null },
    reporters: [...new Set([...(config.reporters ?? []), 'json'])],
    jsonReporter: { fileName: `reports/mutation/${gate}/shard-${index}.json` },
  };
  const out = join(dir, `shard-${index}.stryker.json`);
  writeFileSync(out, `${JSON.stringify(shardConfig, null, 2)}\n`);
  console.log(`shard ${index} of ${shards}: ${slice.mutants} mutant(s) in`);
  for (const entry of slice.mutate) console.log(`    ${entry}`);
}

async function merge(gate: string, shards: number): Promise<void> {
  const config = readConfig(gate);
  const reports = Array.from({ length: shards }, (_, i) => {
    const file = join(shardDir(gate), `shard-${i + 1}.json`);
    try {
      return readJson<MutationReport>(file);
    } catch {
      return fail(`missing the report of shard ${i + 1} of ${shards} (${file})`);
    }
  });
  const merged = mergeReports(reports);
  const expected = (await plan(gate, shards)).reduce((sum, s) => sum + s.mutants, 0);
  const actual = countMutants(merged);
  reports.forEach((report, i) => console.log(`    shard ${i + 1}: ${countMutants(report)} mutant(s)`));
  if (actual !== expected) fail(`the shards reported ${actual} mutant(s), the plan has ${expected}`);
  writeFileSync(join(shardDir(gate), 'merged.json'), JSON.stringify(merged));

  const { calculateMutationTestMetrics } = await fromCore<MetricsModule>('mutation-testing-metrics');
  const metrics = calculateMutationTestMetrics(merged).systemUnderTestMetrics.metrics;
  const counts = ['killed', 'timeout', 'survived', 'noCoverage', 'runtimeErrors', 'compileErrors', 'ignored']
    .map((key) => `${key} ${metrics[key]}`)
    .join(', ');
  console.log(`    ${actual} mutant(s): ${counts}`);
  const score = metrics.mutationScore!;
  const breaking = config.thresholds?.break;
  if (typeof breaking === 'number' && score < breaking) {
    fail(`final mutation score ${score.toFixed(2)} under breaking threshold ${breaking}`);
  }
  console.log(`    final mutation score ${score.toFixed(2)} (break ${breaking ?? 'none'})`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'scope':
    scope(args.includes('--all'));
    break;
  case 'plan':
    for (const [i, s] of (await plan(args[0]!, positiveInt(args[1], 'shards'))).entries()) {
      console.log(`shard ${i + 1}: ${s.mutants} mutant(s): ${s.mutate.join(' ')}`);
    }
    break;
  case 'shard':
    await shard(args[0]!, positiveInt(args[1], 'shard'), positiveInt(args[2], 'shards'));
    break;
  case 'merge':
    await merge(args[0]!, positiveInt(args[1], 'shards'));
    break;
  default:
    fail('usage: cli-mutation.ts scope [--all] | plan <gate> <n> | shard <gate> <i> <n> | merge <gate> <n>');
}
