#!/usr/bin/env node
// N-22: switch a generated app from Hermes to JavaScriptCore the way
// @react-native-community/javascriptcore's README says:
//   android/gradle.properties  hermesEnabled=false, useThirdPartyJSC=true
//   MainApplication.kt         the JSC runtime factory on the ReactHost
//   AppDelegate.swift          createJSRuntimeFactory() -> jsrt_create_jsc_factory()
//   pod install                USE_THIRD_PARTY_JSC=1 USE_HERMES=0 (gen-rn-app.sh)
// Handles both MainApplication shapes: the ReactNativeHost one (<= 0.8x) and
// the packageList one (0.87).
'use strict';
const fs = require('fs');
const path = require('path');

const app = process.argv[2];

function edit(file, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`use-jsc: ${file} did not change`);
  fs.writeFileSync(file, after);
  console.log(`use-jsc: edited ${path.relative(app, file)}`);
}

edit(path.join(app, 'android/gradle.properties'), (s) =>
  s.replace(/^hermesEnabled=true$/m, 'hermesEnabled=false') +
  (/useThirdPartyJSC=/.test(s) ? '' : '\n# Enable third-party JSC\nuseThirdPartyJSC=true\n'),
);

function find(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

const mainApp = find(path.join(app, 'android/app/src/main'), 'MainApplication.kt');
edit(mainApp, (s) => {
  s = s.replace(
    /(import com\.facebook\.react\.ReactHost\n)/,
    '$1import io.github.reactnativecommunity.javascriptcore.JSCRuntimeFactory\n',
  );
  if (/getDefaultReactHost\(applicationContext, reactNativeHost\)/.test(s)) {
    return s.replace(
      'getDefaultReactHost(applicationContext, reactNativeHost)',
      'getDefaultReactHost(applicationContext, reactNativeHost, JSCRuntimeFactory())',
    );
  }
  return s.replace(
    /(getDefaultReactHost\(\s*\n\s*context = applicationContext,\n)/,
    '$1      jsRuntimeFactory = JSCRuntimeFactory(),\n',
  );
});

// The package README's `-> JSRuntimeFactory` predates RN 0.87, which
// declares `- (JSRuntimeFactoryRef)createJSRuntimeFactory` (Swift:
// JSRuntimeFactoryRef). Use whichever this React Native declares.
const protocolHeader = path.join(
  app,
  'node_modules/react-native/Libraries/AppDelegate/RCTJSRuntimeConfiguratorProtocol.h',
);
const factoryType =
  fs.existsSync(protocolHeader) &&
  /\(JSRuntimeFactoryRef\)createJSRuntimeFactory/.test(fs.readFileSync(protocolHeader, 'utf8'))
    ? 'JSRuntimeFactoryRef'
    : 'JSRuntimeFactory';
console.log(`use-jsc: createJSRuntimeFactory returns ${factoryType}`);

const appDelegate = find(path.join(app, 'ios'), 'AppDelegate.swift');
edit(appDelegate, (s) =>
  s
    .replace(/(import ReactAppDependencyProvider\n)/, '$1import ReactJSC\n')
    .replace(
      /(class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate \{\n)/,
      `$1  override func createJSRuntimeFactory() -> ${factoryType} {\n    jsrt_create_jsc_factory() // JavaScriptCore, not Hermes (campaign N-22)\n  }\n\n`,
    ),
);
