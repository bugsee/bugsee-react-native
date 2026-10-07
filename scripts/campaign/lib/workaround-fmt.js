#!/usr/bin/env node
// WORKAROUND W-3 (third party: React Native + Xcode 26.4+, not Bugsee):
// fmt 11.0.2, which React Native's Podfile pulls in, no longer compiles as
// C++20 (`call to consteval function ... is not a constant expression` in
// format-inl.h). Build that one pod as C++17 from the Podfile's post_install.
// Applied only when Podfile.lock pins fmt 11.x.
'use strict';
const fs = require('fs');
const path = require('path');

const iosDir = process.argv[2];
const lock = fs.readFileSync(path.join(iosDir, 'Podfile.lock'), 'utf8');
if (!/^  - fmt \(11\./m.test(lock)) {
  console.log('workaround-fmt: fmt is not 11.x, nothing to do');
  process.exit(0);
}
const podfile = path.join(iosDir, 'Podfile');
let s = fs.readFileSync(podfile, 'utf8');
if (s.includes('campaign W-3')) process.exit(0);
const anchor = /(\n\s*react_native_post_install\([\s\S]*?\n\s*\)\n)/;
if (!anchor.test(s)) throw new Error('Podfile: react_native_post_install(...) not found');
s = s.replace(
  anchor,
  `$1    # campaign W-3: fmt 11.x does not compile as C++20 with Xcode 26.4+.\n` +
    `    installer.pods_project.targets.each do |t|\n` +
    `      next unless t.name == 'fmt'\n` +
    `      t.build_configurations.each { |c| c.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17' }\n` +
    `    end\n`,
);
fs.writeFileSync(podfile, s);
console.log('workaround-fmt: patched Podfile');
console.log('NEEDS_POD_INSTALL');
