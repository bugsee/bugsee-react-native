/**
 * Release-subset audit (plan N-28): prints, for every MX-CFG-RELEASE suite,
 * whether it runs under E2E_RELEASE=1 or which of its blocks skip and why;
 * exits 1 if a Debug-only assertion is not gated (or a suite is missing).
 *
 *   node scripts/cli-campaign-release-audit.ts [--e2e-dir <dir>]   (default examples/bare/e2e)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RELEASE_SUBSET, type SuiteAudit, auditSuite, renderAudit } from './campaign-release-audit.ts';

const args = process.argv.slice(2);
const dir = args[0] === '--e2e-dir' && args[1] !== undefined ? resolve(args[1]) : join(import.meta.dirname, '..', 'examples', 'bare', 'e2e');
const audits: SuiteAudit[] = [];
const missing: string[] = [];
for (const suite of RELEASE_SUBSET) {
  const path = join(dir, `${suite}.test.ts`);
  if (existsSync(path)) {
    audits.push(auditSuite(suite, readFileSync(path, 'utf8')));
  } else {
    missing.push(suite);
  }
}
const { text, ok } = renderAudit(audits, missing);
console.log(text);
process.exit(ok ? 0 : 1);
