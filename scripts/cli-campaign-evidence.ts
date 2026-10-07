/**
 * The campaign evidence collector (plan N-26): the section 4.2 table, as
 * Markdown and CSV, from every run cli-campaign-run.ts filed.
 *
 *   node scripts/cli-campaign-evidence.ts --plan <beta-campaign-plan.md> --root <log root> [--root ...]
 *     [--manual <cells.csv>] [--sha <campaign SHA>] [--header "<line>"]...
 *     [--app-dir <dir>]... [--credentials <credentials.json>]...
 *     --out-md <campaign-evidence.md> --out-csv <campaign-evidence.csv>
 *
 * `--manual`: `id,target,cell,evidence` rows for what no Jest run shows
 * (manual steps, staging, builds); a manual cell replaces the computed one.
 * Every token the scan knows (placeholder, `--app-dir`s', `--credentials`)
 * is redacted from both outputs.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  type ManualCell,
  type RunRecord,
  buildRows,
  parseJestJson,
  parseManualCsv,
  parsePlan,
  renderCsv,
  renderMarkdown,
  runPathParts,
} from './campaign-evidence.ts';
import { secretsOf } from './campaign-secrets.ts';

const args = process.argv.slice(2);
const many = { root: [] as string[], header: [] as string[], 'app-dir': [] as string[], credentials: [] as string[] };
const one: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, '');
  const value = args[i + 1];
  if (key === undefined || value === undefined || !args[i]!.startsWith('--')) {
    console.error(`bad argument ${args[i]}`);
    process.exit(2);
  }
  if (key in many) many[key as keyof typeof many].push(value);
  else one[key] = value;
}
for (const required of ['plan', 'out-md', 'out-csv']) {
  if (one[required] === undefined) {
    console.error(`--${required} is required`);
    process.exit(2);
  }
}
if (many.root.length === 0) {
  console.error('--root is required');
  process.exit(2);
}

const items = parsePlan(readFileSync(one.plan!, 'utf8'));
const runs: RunRecord[] = [];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
for (const rootArg of many.root) {
  const root = resolve(rootArg);
  for (const file of walk(root).filter(path => path.endsWith('.json'))) {
    const parts = runPathParts(relative(root, file));
    if (parts === undefined) continue;
    const sidecar = file.replace(/\.json$/, '.failing.jsonl');
    const tests = parseJestJson(readFileSync(file, 'utf8'), existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : '');
    runs.push({ ...parts, path: relative(root, file).replace(/\.json$/, '.log'), tests });
  }
}
const manual: ManualCell[] = one.manual === undefined ? [] : parseManualCsv(readFileSync(one.manual, 'utf8'));
const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const secrets = secretsOf([
  ...many['app-dir'].map(dir => ({ origin: dir, json: readIf(join(dir, 'credentials.json')), properties: readIf(join(dir, 'android', 'bugsee.properties')) })),
  ...many.credentials.map(file => ({ origin: file, json: readIf(file) })),
]).map(secret => secret.value);

const versions = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'native-versions.json'), 'utf8')) as unknown;
const header = [
  `Campaign SHA: ${one.sha ?? '(not given)'}`,
  `Pins (native-versions.json): ${JSON.stringify(versions)}`,
  `Generated ${new Date().toISOString()} from ${runs.length} run(s) and ${manual.length} manual cell(s)`,
  ...many.header,
];
const rows = buildRows(items, runs, manual);
writeFileSync(one['out-md']!, renderMarkdown(rows, header, secrets));
writeFileSync(one['out-csv']!, renderCsv(rows, secrets));
const counted = rows.filter(row => row.verdict !== 'NOT RUN').length;
console.log(`evidence: ${rows.length} item(s), ${counted} with results; wrote ${one['out-md']} and ${one['out-csv']}`);
