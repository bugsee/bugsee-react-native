#!/usr/bin/env node
'use strict';

/**
 * Drop-in for React Native's compose-source-maps.js. The Xcode bundle script
 * calls this with `<packager map> <compiler map> -o <composed map>` after
 * hermesc. Compose first, then inject the composed map. The compiler map is
 * the intermediate one and is not the inject target. Then upload that map:
 * this runs only when React Native composed in this build, so the map is never
 * a stale one. Version and build come from Xcode's MARKETING_VERSION and
 * CURRENT_PROJECT_VERSION. A Debug CONFIGURATION is skipped unless
 * BUGSEE_UPLOAD_DEBUG_SOURCEMAPS=true.
 */

const { spawnSync } = require('node:child_process');
const {
  debugUploadAllowed,
  finishAfterCompose,
  resolveUploadSettings,
  uploadComposedSourceMap,
  uploadDisabled,
} = require('./hermes-sourcemaps');

function parseComposeArgv(argv) {
  const positional = [];
  let output;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-o') {
      output = argv[(i += 1)];
      continue;
    }
    positional.push(argv[i]);
  }
  return { packager: positional[0], compiler: positional[1], output };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

/** Returns the process exit code. */
function run(argv, env) {
  const realCompose = env.BUGSEE_REAL_COMPOSE;
  const bundlePath = env.BUGSEE_JS_BUNDLE;
  const bytecodePath = env.BUGSEE_BYTECODE_BUNDLE;
  if (!realCompose || !bundlePath || !bytecodePath) {
    return fail('BUGSEE_REAL_COMPOSE, BUGSEE_JS_BUNDLE and BUGSEE_BYTECODE_BUNDLE must be set');
  }

  const { packager, compiler, output } = parseComposeArgv(argv);
  if (!packager || !compiler || !output) {
    return fail('usage: compose-then-inject.js <packager map> <compiler map> -o <composed map>');
  }

  const composed = spawnSync(process.execPath, [realCompose, packager, compiler, '-o', output], {
    encoding: 'utf8',
  });
  if (composed.status !== 0) {
    process.stderr.write(composed.stderr || composed.stdout || '');
    return composed.status || 1;
  }

  const hermesArgs = (env.BUGSEE_HERMES_ARGS || '-O -output-source-map').split(/\s+/).filter(Boolean);

  let finished;
  try {
    finished = finishAfterCompose({
      bundlePath,
      bytecodePath,
      composedMapPath: output,
      intermediateMapPath: compiler,
      packagerMapPath: packager,
      composeScript: realCompose,
      hermesc: env.BUGSEE_HERMESC || undefined,
      hermesArgs,
    });
  } catch (err) {
    return fail(err.message);
  }
  if (finished) {
    const settings = resolveUploadSettings({
      platform: 'ios',
      credentialsPath: env.BUGSEE_CREDENTIALS_FILE,
      env,
    });
    uploadComposedSourceMap({
      composedMapPath: output,
      enabled: !uploadDisabled(undefined, env),
      configuration: env.CONFIGURATION,
      allowDebug: debugUploadAllowed(env),
      token: settings.token,
      endpoint: settings.endpoint,
      appVersion: env.MARKETING_VERSION,
      appBuild: env.CURRENT_PROJECT_VERSION,
    });
  }
  return 0;
}

module.exports = { parseComposeArgv, run };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), process.env);
}
