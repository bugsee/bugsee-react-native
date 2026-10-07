/**
 * One campaign run of one e2e suite, filed where the evidence collector
 * finds it (plan section 4.2, N-26), guarded (N-30) and scanned (N-29):
 *
 *   CAMPAIGN_LOG_ROOT=<dir> E2E_PLATFORM=android \
 *     node scripts/cli-campaign-run.ts --lane sa --target A --suite smoke [--item MX-RN-83] [--run 2] [-- <jest args>]
 *
 * 1. Checks the target matches the environment (A: E2E_PLATFORM=android;
 *    S: ios + E2E_IOS_TARGET=simulator; X: ios + device) and the app's
 *    credential files pass the endpoint guard (cli-campaign-guard.ts rules).
 * 2. Runs `yarn e2e <suite>.test.ts` in examples/bare with Jest's JSON
 *    results and the campaign test environment (the `it.failing` sidecar),
 *    tee'ing everything to
 *    `<root>/<lane>/<target>/[<item>-]<suite>-r<k>-<UTC>.{log,json,failing.jsonl}`.
 * 3. Scans those files for tokens (cli-campaign-secret-scan.ts rules).
 * Exit: Jest's code when it failed; else 3 when the scan found a token or
 * 4 when the guard refused; else 0.
 *
 * Holds no device lock itself: take `.device-lock` / `.device-lock-xs`
 * around it (campaign-rules.md).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkCredentials, parseCampaignMode } from './campaign-endpoint-guard.ts';
import { TARGETS, type Target } from './campaign-evidence.ts';

const repo = join(import.meta.dirname, '..');
const bare = join(repo, 'examples', 'bare');

function usage(message: string): never {
  console.error(`${message}\nusage: node scripts/cli-campaign-run.ts --lane <lane> --target <A|S|X|B|STG> --suite <suite> [--item <ID>] [--run <k>] [-- <jest args>]`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split < 0 ? argv : argv.slice(0, split);
const jestArgs = split < 0 ? [] : argv.slice(split + 1);
const opts: Record<string, string> = {};
for (let i = 0; i < own.length; i += 2) {
  if (!own[i]!.startsWith('--') || own[i + 1] === undefined) {
    usage(`bad argument ${own[i]}`);
  }
  opts[own[i]!.slice(2)] = own[i + 1]!;
}
const { lane, target, suite } = opts;
if (!lane || !/^[\w-]+$/.test(lane)) usage('--lane is required ([\\w-]+)');
if (!target || !(TARGETS as readonly string[]).includes(target)) usage('--target must be A, S, X, B or STG');
if (!suite || !/^[\w-]+$/.test(suite)) usage('--suite is required (an e2e file name without .test.ts)');
const item = opts.item;
if (item !== undefined && !/^[A-Z][A-Z0-9]*(-[A-Za-z0-9]+)+$/.test(item)) usage('--item must be a plan ID');
const k = opts.run ?? '1';
if (!/^\d+$/.test(k)) usage('--run must be a number');
const root = process.env.CAMPAIGN_LOG_ROOT;
if (!root) usage('set CAMPAIGN_LOG_ROOT (your session scratchpad, e.g. <scratchpad>/campaign)');

const platform = process.env.E2E_PLATFORM;
const iosTarget = process.env.E2E_IOS_TARGET;
const expected: Record<Target, string> = {
  A: 'E2E_PLATFORM=android',
  S: 'E2E_PLATFORM=ios E2E_IOS_TARGET=simulator',
  X: 'E2E_PLATFORM=ios E2E_IOS_TARGET=device',
  B: '',
  STG: '',
};
const matches =
  (target === 'A' && platform === 'android') ||
  (target === 'S' && platform === 'ios' && iosTarget === 'simulator') ||
  (target === 'X' && platform === 'ios' && iosTarget === 'device') ||
  target === 'B' ||
  target === 'STG';
if (!matches) usage(`--target ${target} needs ${expected[target as Target]}`);

// The endpoint guard, before anything launches.
const mode = parseCampaignMode(process.env.E2E_STAGING);
const appDir = process.env.E2E_APP_DIR ? resolve(process.env.E2E_APP_DIR) : bare;
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const jsonText = read(join(appDir, 'credentials.json'));
const verdict = checkCredentials(mode, {
  json: jsonText === undefined ? undefined : (JSON.parse(jsonText) as Record<string, unknown>),
  properties: read(join(appDir, 'android', 'bugsee.properties')),
});
if (!verdict.ok) {
  console.error(`campaign guard: REFUSED (${mode}) ${appDir}: ${verdict.reason}`);
  process.exit(4);
}

const utc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dir = join(resolve(root!), lane!, target!);
mkdirSync(dir, { recursive: true });
const base = join(dir, `${item ? `${item}-` : ''}${suite}-r${k}-${utc}`);
const log = createWriteStream(`${base}.log`);
const header = `campaign run ${lane}/${target} ${suite} r${k} ${utc} mode=${mode} app=${appDir} sha=${spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}\n`;
process.stdout.write(header);
log.write(header);

const child = spawn(
  'yarn',
  [
    'e2e',
    `${suite}.test.ts`,
    '--json',
    '--outputFile',
    `${base}.json`,
    '--testEnvironment',
    join(bare, 'e2e', 'campaign-environment.js'),
    ...jestArgs,
  ],
  { cwd: bare, env: { ...process.env, E2E_FAILING_SIDECAR: `${base}.failing.jsonl` } },
);
child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
  log.write(chunk);
});
child.on('close', code => {
  log.end(() => {
    const scanArgs = [join(import.meta.dirname, 'cli-campaign-secret-scan.ts'), '--app-dir', appDir];
    for (const file of (process.env.E2E_SECRET_SCAN_CREDENTIALS ?? '').split(':').filter(Boolean)) {
      scanArgs.push('--credentials', file);
    }
    const scan = spawnSync(process.execPath, [...scanArgs, `${base}.log`, `${base}.json`], { encoding: 'utf8' });
    process.stdout.write(scan.stdout);
    process.stderr.write(scan.stderr.replace(/^.*MODULE_TYPELESS_PACKAGE_JSON[\s\S]*?trace-warnings[^\n]*\n/m, ''));
    console.log(`campaign run filed: ${base}.{log,json,failing.jsonl}`);
    if (code !== 0) {
      process.exit(code ?? 1);
    }
    process.exit(scan.status === 0 ? 0 : 3);
  });
});
