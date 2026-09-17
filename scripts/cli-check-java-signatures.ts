/**
 * argv/exit shim: compares one generated spec against BugseeModule.java.
 * Usage: cli-check-java-signatures.ts <NativeBugseeSpec.java> <BugseeModule.java>
 */
import { readFileSync } from 'node:fs';
import { format, parseSignatures, unimplemented } from './java-signatures.ts';

const NAMES = ['launch', 'relaunch', 'stop', 'getStatus', 'testCrash'] as const;
const [specPath, modulePath] = process.argv.slice(2);

if (!specPath || !modulePath) {
  console.error('usage: cli-check-java-signatures <spec.java> <module.java>');
  process.exit(2);
}

const generated = parseSignatures(readFileSync(specPath, 'utf8'), NAMES);
const implemented = parseSignatures(readFileSync(modulePath, 'utf8'), NAMES);

if (generated.length === 0) {
  console.error(`FAIL: no generated signatures found in ${specPath}`);
  process.exit(1);
}

const missing = unimplemented(generated, implemented);
if (missing.length > 0) {
  console.error('FAIL: BugseeModule.java does not implement what codegen generated:');
  for (const s of missing) console.error(`    missing: ${s}`);
  console.error('  implemented:');
  for (const s of implemented) console.error(`    ${format(s)}`);
  process.exit(1);
}
console.log(`    BugseeModule.java implements all ${generated.length} generated signatures`);
