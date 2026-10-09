/**
 * argv/exit shim for pack-native-versions.ts, run by each package's prepack
 * (`stage`) and postpack (`unstage`) with the package directory as cwd.
 */
import { join } from 'node:path';
import { stageNativeVersions, unstageNativeVersions } from './pack-native-versions.ts';

const repoRoot = join(import.meta.dirname, '..');
const command = process.argv[2];

if (command === 'stage') {
  console.log(`    staged ${stageNativeVersions(repoRoot, process.cwd())}`);
} else if (command === 'unstage') {
  unstageNativeVersions(process.cwd());
} else {
  console.error('usage: cli-pack-native-versions.ts stage|unstage');
  process.exit(2);
}
