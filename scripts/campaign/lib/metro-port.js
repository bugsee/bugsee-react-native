#!/usr/bin/env node
// Harness support (not integration): each campaign app gets its own Metro
// port, so its Debug build never loads another app's bundle from a Metro some
// other lane started on 8081. Writes <app>/campaign.port and bakes the port
// into the iOS build (RCT_METRO_PORT on React-Core, from the Podfile's
// post_install) where React-Core compiles from source (0.81-0.83); a
// prebuilt core (0.84+) ignores it, so launch-check.sh also passes
// -RCT_jsLocation localhost:<port> at launch. Android takes it at build
// time: -PreactNativeDevServerPort=<port> (build-app.sh).
'use strict';
const fs = require('fs');
const path = require('path');

const [appDir, port] = process.argv.slice(2);
if (!/^\d{4,5}$/.test(port || '')) throw new Error('usage: metro-port.js <app dir> <port>');
fs.writeFileSync(path.join(appDir, 'campaign.port'), `${port}\n`);

const podfile = path.join(appDir, 'ios', 'Podfile');
let s = fs.readFileSync(podfile, 'utf8');
if (!s.includes('campaign metro port')) {
  const anchor = /(\n\s*react_native_post_install\([\s\S]*?\n\s*\)\n)/;
  if (!anchor.test(s)) throw new Error('Podfile: react_native_post_install(...) not found');
  s = s.replace(
    anchor,
    `$1    # campaign metro port: this app's Debug build asks Metro on ${port}, not 8081.\n` +
      `    installer.pods_project.targets.each do |t|\n` +
      `      next unless t.name == 'React-Core'\n` +
      `      t.build_configurations.each do |c|\n` +
      `        defs = c.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']\n` +
      `        defs = [defs] if defs.is_a?(String)\n` +
      `        c.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs + ['RCT_METRO_PORT=${port}']\n` +
      `      end\n` +
      `    end\n`,
  );
  fs.writeFileSync(podfile, s);
}
console.log(`metro-port: ${port}`);
