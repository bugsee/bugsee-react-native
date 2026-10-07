/**
 * Campaign secret scan (plan N-29): no token -- placeholder, the app's own,
 * the staging one -- in any file the evidence keeps.
 *
 *   node scripts/cli-campaign-secret-scan.ts [--app-dir <dir>]... [--credentials <credentials.json>]... <path>...
 *
 * Secrets: the placeholder token, plus what each `--app-dir`'s
 * credentials.json and android/bugsee.properties hold (default: examples/bare)
 * and each extra `--credentials` file (e.g. the staging worktree's). Paths
 * are files or directories (recursive); a `.zip` is also scanned entry by
 * entry, each finding named `<zip>!<entry>`. A `SECRET-SCAN FOUND` line already in a scanned log (the device
 * harness's in-run scan of pulled bundles) counts as a finding too.
 * `E2E_SECRET_SCAN_KNOWN=<base name>[,...]`: findings in those files are
 * printed as KNOWN and do not fail (a recorded decision only).
 * Exit 0 clean, 1 found, 2 usage. Prints where, never what.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FOUND_MARKER,
  describeFinding,
  describeKnown,
  isKnownFile,
  needlesOf,
  parseKnown,
  scanBytes,
  secretsOf,
} from './campaign-secrets.ts';

const args = process.argv.slice(2);
const appDirs: string[] = [];
const credentials: string[] = [];
const paths: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if ((arg === '--app-dir' || arg === '--credentials') && args[i + 1] !== undefined) {
    (arg === '--app-dir' ? appDirs : credentials).push(resolve(args[i + 1]!));
    i += 1;
  } else if (arg.startsWith('--')) {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  } else {
    paths.push(resolve(arg));
  }
}
if (paths.length === 0) {
  console.error('usage: node scripts/cli-campaign-secret-scan.ts [--app-dir <dir>]... [--credentials <file>]... <path>...');
  process.exit(2);
}
if (appDirs.length === 0) {
  appDirs.push(join(import.meta.dirname, '..', 'examples', 'bare'));
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const needles = needlesOf(
  secretsOf([
    ...appDirs.map(dir => ({
      origin: dir,
      json: readIf(join(dir, 'credentials.json')),
      properties: readIf(join(dir, 'android', 'bugsee.properties')),
    })),
    ...credentials.map(file => ({ origin: file, json: readIf(file) })),
  ]),
);

function filesUnder(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return statSync(path).isDirectory() ? readdirSync(path).flatMap(name => filesUnder(join(path, name))) : [path];
}

const known = parseKnown(process.env.E2E_SECRET_SCAN_KNOWN);
const found: string[] = [];
const accepted: string[] = [];
let scanned = 0;
for (const file of paths.flatMap(filesUnder)) {
  scanned += 1;
  const data = readFileSync(file);
  // A zip is read entry by entry below; its raw bytes would only repeat a
  // stored entry under the zip's own name, past E2E_SECRET_SCAN_KNOWN.
  const zip = file.endsWith('.zip');
  for (const finding of zip ? [] : scanBytes(data, needles)) {
    (isKnownFile(file, known) ? accepted : found).push(
      isKnownFile(file, known) ? describeKnown(file, finding) : describeFinding(file, finding),
    );
  }
  if (zip) {
    // Entry by entry, so a finding names the entry and E2E_SECRET_SCAN_KNOWN
    // applies to the entry's own name, as in the in-run scan.
    const entries = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(entry => entry !== '' && !entry.endsWith('/'));
    for (const entry of entries) {
      const bytes = execFileSync('unzip', ['-p', file, entry], { maxBuffer: 1024 * 1024 * 1024 });
      const where = `${file}!${entry}`;
      for (const finding of scanBytes(bytes, needles)) {
        (isKnownFile(entry, known) ? accepted : found).push(
          isKnownFile(entry, known) ? describeKnown(where, finding) : describeFinding(where, finding),
        );
      }
    }
  }
  if (/\.(log|txt|json)$/.test(file)) {
    const text = data.toString('utf8');
    for (const line of text.split('\n').filter(line => FOUND_MARKER.test(line))) {
      found.push(`SECRET-SCAN FOUND (reported in-run) in ${file}: ${line.replace(/^.*?SECRET-SCAN FOUND /, '').trim()}`);
    }
  }
}
for (const line of [...found, ...accepted]) {
  console.log(line);
}
console.log(`secret scan: ${scanned} file(s), ${needles.length} needle form(s), ${found.length} finding(s), ${accepted.length} known`);
process.exit(found.length > 0 ? 1 : 0);
