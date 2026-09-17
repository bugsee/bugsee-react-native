/**
 * argv/exit shim for the embed assertion. Deliberately thin and separate:
 * everything decidable lives in assert-framework-embedded.ts, where it is
 * unit-tested and mutation-tested.
 */
import { existsSync, statSync } from 'node:fs';
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
// A file rather than a bundle would otherwise surface as an unhandled ENOTDIR
// and exit 1 -- the code that means "the framework is missing", which is a
// very different thing from "you pointed me at the wrong path".
if (!statSync(appPath).isDirectory()) {
  console.error(`not an app bundle (a .app is a directory): ${appPath}`);
  process.exit(2);
}
// The optional second argument is a framework NAME. Taking a path here would
// quietly check for a framework called "/some/path", and report it missing.
if (/[/\\.]/.test(name)) {
  console.error(`not a framework name: ${name}`);
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
