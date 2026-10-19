import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The publish job runs `publish-all.mjs --tarballs` with no `yarn install`, because it holds the npm
 * OIDC token and no dependency's install script may run beside it. A static import of anything that
 * is not a Node built-in or a sibling file would then fail the first real publish with
 * ERR_MODULE_NOT_FOUND while the dry run, which installs, stayed green.
 */
const scripts = join(__dirname, '..');
const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^import\s+(?:[^;]*?from\s+)?'([^']+)'|\bimport\(\s*'([^']+)'\s*\)|\brequire\(\s*'([^']+)'\s*\)/gms)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);

function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of importsOf(entry)) {
    if (spec.startsWith('.')) closure(join(dirname(entry), spec), seen);
  }
  return seen;
}

describe('the publish entry point loads without installed dependencies', () => {
  it.each(['publish-all.mjs', 'npm-trust-all.mjs'])('%s imports only Node built-ins and sibling files', (name) => {
    const files = closure(join(scripts, name));
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      for (const spec of importsOf(file)) {
        expect(spec.startsWith('node:') || spec.startsWith('.')).toBe(true);
      }
    }
  });
});
