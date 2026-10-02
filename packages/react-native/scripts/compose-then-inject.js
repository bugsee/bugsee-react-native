#!/usr/bin/env node
'use strict';

/**
 * Drop-in for React Native's compose-source-maps.js. The Xcode bundle script
 * calls this with `<packager map> <compiler map> -o <composed map>` after
 * hermesc. Compose first, then inject the composed map. The compiler map is
 * the intermediate one and is not the inject target.
 */

const { spawnSync } = require('node:child_process');
const { finishAfterCompose } = require('./hermes-sourcemaps');

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
  process.exit(1);
}

const realCompose = process.env.BUGSEE_REAL_COMPOSE;
const bundlePath = process.env.BUGSEE_JS_BUNDLE;
const bytecodePath = process.env.BUGSEE_BYTECODE_BUNDLE;
if (!realCompose || !bundlePath || !bytecodePath) {
  fail('BUGSEE_REAL_COMPOSE, BUGSEE_JS_BUNDLE and BUGSEE_BYTECODE_BUNDLE must be set');
}

const { packager, compiler, output } = parseComposeArgv(process.argv.slice(2));
if (!packager || !compiler || !output) {
  fail('usage: compose-then-inject.js <packager map> <compiler map> -o <composed map>');
}

const composed = spawnSync(
  process.execPath,
  [realCompose, packager, compiler, '-o', output],
  { encoding: 'utf8' },
);
if (composed.status !== 0) {
  process.stderr.write(composed.stderr || composed.stdout || '');
  process.exit(composed.status || 1);
}

const hermesArgs = (process.env.BUGSEE_HERMES_ARGS || '-O -output-source-map')
  .split(/\s+/)
  .filter(Boolean);

try {
  finishAfterCompose({
    bundlePath,
    bytecodePath,
    composedMapPath: output,
    intermediateMapPath: compiler,
    packagerMapPath: packager,
    composeScript: realCompose,
    hermesc: process.env.BUGSEE_HERMESC || undefined,
    hermesArgs,
  });
} catch (err) {
  fail(err.message);
}
