#!/usr/bin/env node
// DEVIATION R-3: the iOS "Bundle React Native code and images" phase runs
// @bugsee/react-native/scripts/bugsee-xcode.sh (compose, inject the debug id,
// upload) instead of react-native-xcode.sh, as examples/bare does. The
// package README documents only the Android half of the debug-id hooks.
'use strict';
const fs = require('fs');

const pbx = process.argv[2];
const before = fs.readFileSync(pbx, 'utf8');
const from = 'REACT_NATIVE_XCODE=\\"$REACT_NATIVE_PATH/scripts/react-native-xcode.sh\\"';
const to = 'REACT_NATIVE_XCODE=\\"${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh\\"';
if (!before.includes(from)) throw new Error(`${pbx}: template bundle phase not found`);
fs.writeFileSync(pbx, before.replace(from, to));
console.log('deviation-ios-bundle-phase: bundle phase runs bugsee-xcode.sh');
