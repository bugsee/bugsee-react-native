/**
 * argv/exit shim for the release gate. Run as `prepack`, the one lifecycle
 * hook that `npm pack`, `npm publish`, `yarn pack` and `yarn npm publish`
 * (yarn 4, which this repo pins) all run, so none of them can produce a
 * tarball carrying a SNAPSHOT pin or an unresolved SPM placeholder.
 * (`prepublishOnly` would not do: yarn 4 never runs it, and neither pack
 * command does.)
 *
 * Deliberately thin: everything decidable lives in releasable-pins.ts, where
 * it is unit-tested. Reads native-versions.json itself (a type-only import of
 * `NativeVersions`, not `readNativeVersions`): that function's module does a
 * static `import … from '../native-versions.json'`, which Jest's CommonJS
 * transform accepts but which Node's real ESM loader -- what actually runs
 * this CLI -- refuses without an import attribute. Reading the file directly
 * sidesteps that entirely.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeVersions } from './native-versions.ts';
import { releaseBlockers } from './releasable-pins.ts';

const repoRoot = join(import.meta.dirname, '..');
const versions = JSON.parse(
  readFileSync(join(repoRoot, 'native-versions.json'), 'utf8'),
) as NativeVersions;
const supportPackageResolved = readFileSync(
  join(repoRoot, 'packages/react-native/ios/Support/Package.resolved'),
  'utf8',
);

const blockers = releaseBlockers(versions, supportPackageResolved);

if (blockers.length > 0) {
  console.error('FAIL: native-versions.json is not releasable:');
  for (const blocker of blockers) console.error(`    ${blocker}`);
  process.exit(1);
}
console.log('    native-versions.json is releasable');
