/**
 * argv/exit shim for the embed assertion. Deliberately thin and separate:
 * everything decidable lives in assert-framework-embedded.ts, where it is
 * unit-tested and mutation-tested.
 */
import { existsSync } from 'node:fs';
import { explain, inspect } from './assert-framework-embedded';

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
  process.exit(1);
}
console.log(`OK ${name}.framework is embedded in and linked by ${appPath}`);
