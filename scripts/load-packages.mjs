// The publishable packages of this workspace. Node built-ins only, on purpose: the publish job runs
// this through publish-all.mjs on a runner with no `yarn install`, so nothing here may import a
// dependency (scripts/__tests__/release-scripts-imports.test.ts holds the line).
import { readdirSync, readFileSync } from 'node:fs';
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
