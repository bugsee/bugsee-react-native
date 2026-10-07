#!/usr/bin/env node
// DEVIATION R-2: the Bugsee Gradle plugin, which Bugsee Android 7.x needs and
// packages/react-native/README.md does not mention ("no Gradle changes are
// required"). Mirrors examples/bare: mavenCentral() in
// settings.gradle pluginManagement, the root `plugins {}` pin from
// native-versions.json, `apply plugin` in app/build.gradle, and an
// android/bugsee.properties with no token (the placeholder never uploads).
'use strict';
const fs = require('fs');
const path = require('path');

const androidDir = process.argv[2];
const versions = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const pin = versions.android.gradlePlugin;

function edit(file, fn) {
  const p = path.join(androidDir, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${file}: edit did not apply`);
  fs.writeFileSync(p, after);
}

const REPOS = '    repositories {\n        gradlePluginPortal()\n        google()\n        mavenCentral()\n    }\n';
edit('settings.gradle', (s) => {
  // Templates write it on one line: `pluginManagement { includeBuild("...") }`.
  const oneLine = /^pluginManagement \{ (.*) \}$/m;
  if (oneLine.test(s)) return s.replace(oneLine, (m, body) => `pluginManagement {\n    ${body}\n${REPOS}}`);
  if (/^pluginManagement \{\s*$/m.test(s)) return s.replace(/^pluginManagement \{\s*\n/m, (m) => m + REPOS);
  return `pluginManagement {\n${REPOS}}\n` + s;
});

edit('build.gradle', (s) =>
  s.replace(
    /\napply plugin: "com.facebook.react.rootproject"/,
    `\nplugins {\n    id 'com.bugsee.android.gradle' version '${pin}' apply false\n}\n\napply plugin: "com.facebook.react.rootproject"`,
  ),
);

edit('app/build.gradle', (s) =>
  s.replace(/(apply plugin: "com.facebook.react"\n)/, '$1apply plugin: "com.bugsee.android.gradle"\n'),
);

fs.writeFileSync(
  path.join(androidDir, 'bugsee.properties'),
  '# campaign app: placeholder token only. No app token configured.\n',
);
console.log(`deviation-gradle-plugin: com.bugsee.android.gradle ${pin}`);
