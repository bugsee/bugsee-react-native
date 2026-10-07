#!/usr/bin/env node
// Harness support (not integration): React Native writes console.log to
// os_log only, and os_log cannot be streamed off a physical iPhone, so a
// Release build on the XS shows no BUGSEE_E2E marker on the
// `devicectl ... --console` attachment run-ios.sh IOS_LAUNCH=1 reads. Like
// examples/bare's AppDelegate, mirror the BUGSEE_E2E lines (only those) to
// NSLog, which that attachment does show. Template AppDelegate.swift only;
// an AppDelegate of another shape (Expo's) is left alone and said so.
'use strict';
const fs = require('fs');
const path = require('path');

const iosDir = process.argv[2];
const candidates = fs
  .readdirSync(iosDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !/^(Pods|build.*|.*\.xcodeproj|.*\.xcworkspace)$/.test(e.name))
  .map((e) => path.join(iosDir, e.name, 'AppDelegate.swift'))
  .filter((p) => fs.existsSync(p));
if (candidates.length !== 1) {
  console.log(`ios-log-mirror: ${candidates.length} AppDelegate.swift found, left alone`);
  process.exit(0);
}
const file = candidates[0];
let s = fs.readFileSync(file, 'utf8');
if (s.includes('campaignMirrorMarkers')) process.exit(0);
const launch = /(didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\? = nil\n\s*\) -> Bool \{\n)/;
if (!launch.test(s) || !/^import React$/m.test(s)) {
  console.log('ios-log-mirror: AppDelegate is not the React Native template shape, left alone');
  process.exit(0);
}
s = s.replace(launch, '$1    campaignMirrorMarkers()\n');
s +=
  '\n/// Campaign harness: BUGSEE_E2E markers also go to NSLog, which a\n' +
  '/// `devicectl ... --console` attachment shows (os_log it does not).\n' +
  'private func campaignMirrorMarkers() {\n' +
  '  let osLog = RCTDefaultLogFunction\n' +
  '  RCTSetLogFunction { level, source, fileName, lineNumber, message in\n' +
  '    osLog?(level, source, fileName, lineNumber, message)\n' +
  '    if let message, message.contains("BUGSEE_E2E") {\n' +
  '      NSLog("%@", message)\n' +
  '    }\n' +
  '  }\n' +
  '}\n';
fs.writeFileSync(file, s);
console.log(`ios-log-mirror: ${path.relative(iosDir, file)}`);
