#!/usr/bin/env node
// README "Android source maps", applied literally to a template's
// android/app/build.gradle: the bugseeDir resolution, react.hermesCommand,
// and `apply from: bugsee-sourcemaps.gradle` at the end of the file.
// The snippet text is read from the packed README, so a README change
// changes what generated apps get.
'use strict';
const fs = require('fs');
const path = require('path');

const gradleFile = process.argv[2];
const appRoot = path.resolve(path.dirname(gradleFile), '..', '..');
const readme = fs.readFileSync(
  require.resolve('@bugsee/react-native/README.md', { paths: [appRoot] }),
  'utf8',
);

const section = readme.slice(readme.indexOf('## Android source maps'));
const fence = /```groovy\n([\s\S]*?)```/.exec(section);
if (!fence) throw new Error('README: no groovy block under "## Android source maps"');
const snippet = fence[1];

const defMatch = /^def bugseeDir[\s\S]*?getParentFile\(\)\n/m.exec(snippet);
const hermesMatch = /^\s*hermesCommand = .*$/m.exec(snippet);
const applyMatch = /^apply from: .*$/m.exec(snippet);
if (!defMatch || !hermesMatch || !applyMatch) {
  throw new Error('README snippet changed shape; update scripts/campaign/lib/readme-android.js');
}

let gradle = fs.readFileSync(gradleFile, 'utf8');
const reactBlock = gradle.indexOf('\nreact {');
if (reactBlock < 0) throw new Error(`${gradleFile}: no top-level react { block`);
gradle =
  gradle.slice(0, reactBlock + 1) +
  defMatch[0] +
  '\n' +
  gradle.slice(reactBlock + 1).replace(
    /^react \{\n/,
    'react {\n    // Copies the JS aside before hermesc compiles it, so the debug id can\n    // reach the bytecode.\n    ' +
      hermesMatch[0].trim() +
      '\n',
  );
gradle = gradle.replace(/\s*$/, '\n') + '\n// At the end of the file. Applying it twice is harmless.\n' + applyMatch[0] + '\n';
fs.writeFileSync(gradleFile, gradle);
console.log(`readme-android: edited ${gradleFile}`);
