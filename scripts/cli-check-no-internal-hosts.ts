/**
 * Fails when a tracked file names an internal `*.bugsee.com` host
 * (scripts/check-no-internal-hosts.ts). Run by `yarn lint`.
 *
 *   node scripts/cli-check-no-internal-hosts.ts
 *
 * Exit 0 clean, 1 findings.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_HOSTS, findInternalHosts } from './check-no-internal-hosts.ts';

const root = join(import.meta.dirname, '..');
const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(file => file !== '');
let bad = 0;
for (const file of files) {
  let data: Buffer;
  try {
    data = readFileSync(join(root, file));
  } catch {
    continue; // listed but deleted in the working tree
  }
  if (data.includes(0)) {
    continue; // binary
  }
  for (const { line, host } of findInternalHosts(data.toString('utf8'))) {
    console.error(`${file}:${line}: internal host ${host} (allowed: ${ALLOWED_HOSTS.join(', ')})`);
    bad += 1;
  }
}
if (bad > 0) {
  console.error(`check-no-internal-hosts: ${bad} finding(s). Take the host from the environment instead.`);
  process.exit(1);
}
console.log('check-no-internal-hosts: ok');
