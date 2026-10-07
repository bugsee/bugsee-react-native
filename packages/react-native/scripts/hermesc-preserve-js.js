#!/usr/bin/env node
'use strict';

/**
 * The work behind `react.hermesCommand`. React Native runs the launcher with
 * hermesc's own arguments: hermesc-preserve-js.sh on macOS and Linux,
 * hermesc-preserve-js.cmd on Windows (React Native runs every command there
 * through `cmd /c`, which cannot run a shell script). Both start this file.
 *
 * Copy the JS bundle aside before hermesc replaces it with bytecode, note
 * which hermesc compiled it, then run that hermesc. Injection happens later,
 * on the composed map (bugsee-sourcemaps.gradle, hermes-sourcemaps.js).
 *
 * Exits non-zero, with a `bugsee:` line, whenever no bytecode came out:
 * React Native moves `<bundle>.hbc` over the bundle next, and a wrapper that
 * exits 0 without it only fails later, far from the cause.
 */

const fs = require('node:fs');
const path = require('node:path');
const { preserveDirFor } = require('./hermes-sourcemaps');

/** The value after the last `-out`, as hermesc reads it. */
function outputOf(argv) {
  let out;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i - 1] === '-out') {
      out = argv[i];
    }
  }
  return out;
}

/** The first argument that is not a flag, not the output, and is a file. */
function bundleOf(argv, out, isFile) {
  return argv.find((arg) => !arg.startsWith('-') && arg !== out && isFile(arg));
}

/** React Native's own names: getHermesOSBin, getHermesCBin. */
function hermescBin(platform) {
  if (platform === 'win32') {
    return { osbin: 'win64-bin', bin: 'hermesc.exe' };
  }
  return { osbin: platform === 'linux' ? 'linux64-bin' : 'osx-bin', bin: 'hermesc' };
}

function defaultResolve(request, from) {
  try {
    return require.resolve(request, { paths: [from] });
  } catch {
    return null;
  }
}

/**
 * The hermesc React Native would have run. BUGSEE_REAL_HERMESC first. Expo
 * SDK 57 resolves hermes-compiler from the react-native package, so a pnpm or
 * Yarn workspace install under node_modules/react-native/node_modules is
 * found. React Native 0.81 (Expo SDK 54) has no hermes-compiler package and
 * ships sdks/hermesc beside react-native/package.json. Then the app's own
 * node_modules. Null when none is there.
 */
function findHermesc({ env, cwd, platform, isExecutable, resolve = defaultResolve }) {
  if (env.BUGSEE_REAL_HERMESC && isExecutable(env.BUGSEE_REAL_HERMESC)) {
    return env.BUGSEE_REAL_HERMESC;
  }
  const { osbin, bin } = hermescBin(platform);
  const candidates = [];
  const rnPkg = resolve('react-native/package.json', cwd);
  if (rnPkg) {
    const rnDir = path.dirname(rnPkg);
    const compilerPkg = resolve('hermes-compiler/package.json', rnDir);
    if (compilerPkg) {
      candidates.push(path.join(path.dirname(compilerPkg), 'hermesc', osbin, bin));
    }
    candidates.push(path.join(rnDir, 'sdks', 'hermesc', osbin, bin));
  }
  candidates.push(
    path.join(cwd, 'node_modules', 'hermes-compiler', 'hermesc', osbin, bin),
    path.join(cwd, 'node_modules', 'react-native', 'sdks', 'hermes', 'build', 'bin', bin),
  );
  return candidates.find((candidate) => isExecutable(candidate)) ?? null;
}

/**
 * Where the preserved JS goes. The bundle directory is packaged as assets,
 * so files beside the bundle would ship in the APK; intermediates are not.
 */
function preserveDirOf(js, env, cwd) {
  const jsDir = path.dirname(js);
  let dir;
  if (env.BUGSEE_PRESERVE_DIR) {
    dir = path.resolve(cwd, env.BUGSEE_PRESERVE_DIR);
  } else {
    dir = preserveDirFor(js);
    if (dir === jsDir) {
      return { error: `refusing to write preserve files beside the bundle (${jsDir})` };
    }
  }
  if (dir === jsDir || dir.startsWith(jsDir + path.sep)) {
    return { error: 'refusing to write preserve files into the packaged asset directory' };
  }
  return { dir };
}

function defaultIsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultIsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultSpawn(file, args, cwd) {
  return require('node:child_process').spawnSync(file, args, { cwd, stdio: 'inherit' });
}

/** Returns the exit code. */
function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const platform = deps.platform ?? process.platform;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const spawn = deps.spawn ?? defaultSpawn;
  const stderr = deps.stderr ?? ((line) => process.stderr.write(line));
  const fail = (message) => {
    stderr(`bugsee: ${message}\n`);
    return 1;
  };

  const out = outputOf(argv);
  const bundle = bundleOf(argv, out, (arg) => defaultIsFile(path.resolve(cwd, arg)));
  if (bundle === undefined) {
    return fail('hermesc wrapper could not find the JS bundle');
  }
  if (out === undefined) {
    return fail('hermesc wrapper was given no -out, so it cannot check that bytecode was written');
  }
  const js = path.resolve(cwd, bundle);
  const preserve = preserveDirOf(js, env, cwd);
  if (preserve.error) {
    return fail(preserve.error);
  }
  fs.mkdirSync(preserve.dir, { recursive: true });
  const base = path.basename(js);
  fs.copyFileSync(js, path.join(preserve.dir, `${base}.bugsee-js-source`));

  const hermesc = findHermesc({ env, cwd, platform, isExecutable, resolve: deps.resolve });
  if (hermesc === null) {
    return fail('hermesc binary not found');
  }
  fs.writeFileSync(path.join(preserve.dir, `${base}.bugsee-hermesc`), `${hermesc}\n`);

  // A file left from an earlier run must not pass the check below.
  const bytecode = path.resolve(cwd, out);
  fs.rmSync(bytecode, { force: true });
  const result = spawn(hermesc, argv, cwd);
  if (result.error) {
    return fail(`hermesc failed to start (${hermesc}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    return result.status === null
      ? fail(`hermesc was killed by ${result.signal} (${hermesc})`)
      : result.status;
  }
  if (!defaultIsFile(bytecode) || fs.statSync(bytecode).size === 0) {
    return fail(`hermesc exited 0 but wrote no bytecode to ${bytecode} (${hermesc})`);
  }
  return 0;
}

module.exports = { bundleOf, findHermesc, hermescBin, outputOf, preserveDirOf, run };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
