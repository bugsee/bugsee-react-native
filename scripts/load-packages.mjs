// The publishable packages of this workspace. Node built-ins only, on purpose: the publish job runs
// this through publish-all.mjs on a runner with no `yarn install`, so nothing here may import a
// dependency (scripts/__tests__/release-scripts-imports.test.ts holds the line).
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPackages() {
  return readdirSync(join(root, 'packages'))
    .map((dir) => ({
      dir,
      json: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')),
    }))
    .filter(({ json }) => !json.private);
}

/** A prerelease has a hyphen before any `+build` metadata: `1.0.0+build-1` is stable, `1.0.0-beta.1+x` is not. */
export const isPrerelease = (version) => (version.split('+', 1)[0] ?? '').includes('-');

/**
 * True when `metaUrl` (a script's `import.meta.url`) is the file node was started on. Compares real
 * paths: through a symlinked directory (macOS /var -> /private/var, a linked checkout) the plain
 * comparison is false and a guarded script would exit 0 having done nothing, which for a publish
 * script looks exactly like success.
 */
export function isEntryPoint(metaUrl) {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
