/**
 * argv/exit shim for the embed assertion. Deliberately thin and separate:
 * everything decidable lives in assert-framework-embedded.ts, where it is
 * unit-tested and mutation-tested.
 */
import { existsSync } from 'node:fs';
import {
  explain,
  inspect,
  installNames,
  realEnv,
} from './assert-framework-embedded.ts';

const [appPath, name = 'Bugsee'] = process.argv.slice(2);

if (!appPath) {
  console.error('usage: assert-framework-embedded <App.app> [FrameworkName]');
  process.exit(2);
}
if (!existsSync(appPath)) {
  console.error(`no such app bundle: ${appPath}`);
  process.exit(2);
}

const problem = explain(inspect(appPath, name), name);
if (problem) {
  console.error(`FAIL ${problem}`);
  // Dump what each binary actually links. Without this the failure says only
  // that something is missing, and the next step is always to run otool by
  // hand on a machine that may not be to hand -- CI especially.
  for (const binary of realEnv.binariesIn(appPath)) {
    console.error(`  --- ${binary}`);
    for (const installName of installNames(realEnv.otool(binary))) {
      console.error(`      ${installName}`);
    }
  }
  process.exit(1);
}
console.log(`OK ${name}.framework is embedded in and linked by ${appPath}`);
