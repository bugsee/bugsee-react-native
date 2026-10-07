/**
 * native-versions.json is the one source of every native pin, and it lives at
 * the repo root. In the repo the podspecs read `../../native-versions.json` and
 * the Android builds walk up for it. Inside an app the package sits in
 * node_modules, where neither lookup finds the repo root, so `pod install` and
 * Gradle configuration failed in every app that installed from npm (BLK-17).
 *
 * prepack stages a copy at the package root, which `files` ships and which
 * both lookups find first; postpack removes it again so the repo copy stays
 * the only one on disk. The staged copy is gitignored.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'native-versions.json';

function requireBugseePackage(packageDir: string): void {
  const manifest = join(packageDir, 'package.json');
  const name = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
    : undefined;
  if (typeof name !== 'string' || !name.startsWith('@bugsee/')) {
    throw new Error(`${packageDir} is not a @bugsee package; run this from a package directory (npm/yarn pack do)`);
  }
}

/** Copies `<repoRoot>/native-versions.json` into `packageDir`, byte for byte. Returns the copy's path. */
export function stageNativeVersions(repoRoot: string, packageDir: string): string {
  requireBugseePackage(packageDir);
  const source = join(repoRoot, FILE);
  try {
    JSON.parse(readFileSync(source, 'utf8'));
  } catch (error) {
    throw new Error(`${source}: native-versions.json is not valid JSON`, { cause: error });
  }
  const target = join(packageDir, FILE);
  copyFileSync(source, target);
  return target;
}

/** Removes the staged copy from `packageDir`. Returns whether there was one. */
export function unstageNativeVersions(packageDir: string): boolean {
  requireBugseePackage(packageDir);
  const target = join(packageDir, FILE);
  const staged = existsSync(target);
  rmSync(target, { force: true });
  return staged;
}
