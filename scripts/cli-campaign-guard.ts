/**
 * Campaign endpoint guard, pre-build (plan N-30): refuses an app whose
 * credential files would send anything anywhere but the dead endpoint
 * (offline) or exactly https://apidev.bugsee.com (`E2E_STAGING=1`).
 *
 *   node scripts/cli-campaign-guard.ts [--app-dir <dir>]   (default examples/bare)
 *
 * Reads `<dir>/credentials.json` and `<dir>/android/bugsee.properties`.
 * Exit 0 allowed, 1 refused, 2 usage. Never prints a token.
 * The device harness applies the same rules to every launch (harness.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkCredentials, parseCampaignMode } from './campaign-endpoint-guard.ts';

const args = process.argv.slice(2);
let appDir = join(import.meta.dirname, '..', 'examples', 'bare');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--app-dir' && args[i + 1] !== undefined) {
    appDir = resolve(args[i + 1]!);
    i += 1;
  } else {
    console.error('usage: node scripts/cli-campaign-guard.ts [--app-dir <dir>]');
    process.exit(2);
  }
}

const mode = parseCampaignMode(process.env.E2E_STAGING);
const jsonPath = join(appDir, 'credentials.json');
const propertiesPath = join(appDir, 'android', 'bugsee.properties');
let json: Record<string, unknown> | undefined;
if (existsSync(jsonPath)) {
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    console.error(`campaign guard: REFUSED (${mode}): ${jsonPath} is not JSON`);
    process.exit(1);
  }
}
const properties = existsSync(propertiesPath) ? readFileSync(propertiesPath, 'utf8') : undefined;
if (json === undefined && properties === undefined) {
  console.error(`campaign guard: REFUSED (${mode}): no credentials.json or android/bugsee.properties in ${appDir}`);
  process.exit(1);
}
const verdict = checkCredentials(mode, { json, properties });
if (!verdict.ok) {
  console.error(`campaign guard: REFUSED (${mode}) ${appDir}: ${verdict.reason}`);
  process.exit(1);
}
console.log(`campaign guard: ok (${mode}) ${appDir}`);
