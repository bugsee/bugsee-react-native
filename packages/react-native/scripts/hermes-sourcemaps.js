'use strict';

/**
 * Hermes emits an intermediate compiler map, then `compose-source-maps.js`
 * writes the map a crash actually consults. `composeSourceMaps` builds a new
 * object and drops `debug_id`, so `bugsee-cli sourcemaps inject` has to run
 * on the composed map, after that script. The runtime stub has to be in the
 * JavaScript `hermesc` compiles; when a bytecode output is given, this
 * recompiles that JS and copies the same id back onto the recomposed map.
 *
 * `debug-files upload --type sourcemaps` is wired and never executed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPLOAD_ARGV = ['debug-files', 'upload', '--type', 'sourcemaps'];
const DEBUG_ID_MARK = '//# debugId=';

function uploadArgv(composedMapPath) {
  return [...UPLOAD_ARGV, composedMapPath];
}

function spawn(file, args) {
  return require('node:child_process').spawnSync(file, args, { encoding: 'utf8' });
}

function run(file, args, what) {
  const result = spawn(file, args);
  if (result.error) {
    throw new Error(`${what} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${what} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function resolveCli() {
  const pkgPath = require.resolve('@bugsee/cli/package.json', { paths: [__dirname] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['bugsee-cli'];
  return path.join(path.dirname(pkgPath), binRel);
}

function retargetSourceMappingUrl(source, url) {
  const comment = `//# sourceMappingURL=${url}`;
  if (source.includes('//# sourceMappingURL=')) {
    return source.replace(/\/\/# sourceMappingURL=\S+/g, comment);
  }
  return source.endsWith('\n') ? `${source}${comment}\n` : `${source}\n${comment}\n`;
}

function readDebugId(source) {
  const at = source.lastIndexOf(DEBUG_ID_MARK);
  if (at < 0) {
    throw new Error('sourcemaps inject did not write a debug id into the bundle');
  }
  const id = source.slice(at + DEBUG_ID_MARK.length, at + DEBUG_ID_MARK.length + 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('sourcemaps inject wrote a debug id that is not a UUID');
  }
  return id;
}

/**
 * Inject into `bundlePath`, pairing it with the composed map. The intermediate
 * compiler map is not staged and is not an argument to the CLI.
 */
function injectComposedSourceMap({ bundlePath, composedMapPath, cliPath }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-sourcemaps-'));
  try {
    const stagedBundle = path.join(stage, 'bundle.js');
    const stagedMap = path.join(stage, 'composed.js.map');
    fs.writeFileSync(
      stagedBundle,
      retargetSourceMappingUrl(fs.readFileSync(bundlePath, 'utf8'), 'composed.js.map'),
    );
    fs.copyFileSync(composedMapPath, stagedMap);
    const cli = cliPath || resolveCli();
    run(process.execPath, [cli, 'sourcemaps', 'inject', stagedBundle], 'bugsee-cli sourcemaps inject');
    const injected = fs.readFileSync(stagedBundle, 'utf8');
    fs.writeFileSync(bundlePath, injected);
    fs.copyFileSync(stagedMap, composedMapPath);
    const debugId = readDebugId(injected);
    const map = JSON.parse(fs.readFileSync(composedMapPath, 'utf8'));
    if (map.debug_id !== debugId || map.debugId !== debugId) {
      throw new Error('composed map debug id does not match the bundle');
    }
    return { debugId, uploadArgv: uploadArgv(composedMapPath) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function preserveDirFor(filePath) {
  const dir = path.dirname(filePath);
  const marker = `${path.sep}generated${path.sep}assets${path.sep}`;
  const replacement = `${path.sep}intermediates${path.sep}bugsee-sourcemaps${path.sep}`;
  if (!dir.includes(marker)) return null;
  const preserveDir = dir.replace(marker, replacement);
  return preserveDir === dir ? null : preserveDir;
}

function readHermescSidecar(bytecodePath) {
  const name = `${path.basename(bytecodePath)}.bugsee-hermesc`;
  const outside = preserveDirFor(bytecodePath);
  const candidates = [
    outside ? path.join(outside, name) : null,
    path.join(path.dirname(bytecodePath), name),
  ].filter(Boolean);
  for (const sidecar of candidates) {
    if (!fs.existsSync(sidecar)) continue;
    const hermesc = fs.readFileSync(sidecar, 'utf8').trim();
    if (hermesc) return hermesc;
  }
  return null;
}

const PACKAGED_PRESERVE_SUFFIXES = [
  '.bugsee-js-source',
  '.bugsee-hermesc',
  '.bugsee-recompile',
  '.bugsee-recompile.map',
];

function removePackagedPreserveFiles(bytecodePath) {
  if (!bytecodePath) return;
  for (const suffix of PACKAGED_PRESERVE_SUFFIXES) {
    fs.rmSync(bytecodePath + suffix, { force: true });
  }
}

function recompile({ hermesc, bundlePath, bytecodePath, intermediateMapPath, hermesArgs }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-hermesc-'));
  try {
    const tempOut = path.join(stage, 'bundle.hbc');
    const args = ['-w', '-emit-binary', '-max-diagnostic-width=80', ...(hermesArgs ?? [])];
    if (!args.includes('-output-source-map')) args.push('-output-source-map');
    args.push('-out', tempOut, bundlePath);
    run(hermesc, args, 'hermesc');
    fs.copyFileSync(tempOut, bytecodePath);
    const emittedMap = `${tempOut}.map`;
    if (intermediateMapPath && fs.existsSync(emittedMap)) {
      fs.copyFileSync(emittedMap, intermediateMapPath);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function runCompose({ composeScript, packagerMapPath, intermediateMapPath, composedMapPath }) {
  run(
    process.execPath,
    [composeScript, packagerMapPath, intermediateMapPath, '-o', composedMapPath],
    'compose-source-maps.js',
  );
}

function stampDebugId(mapPath, debugId) {
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  map.debug_id = debugId;
  map.debugId = debugId;
  fs.writeFileSync(mapPath, JSON.stringify(map));
}

/**
 * Compose has already produced `composedMapPath`. Inject that map and the JS
 * bundle. When bytecode output is set, compile the injected JS and, if a
 * compose script is set, compose again — that second compose drops the id —
 * then write the bundle's id back onto the composed map only.
 */
function finishAfterCompose(opts) {
  try {
    const injected = injectComposedSourceMap(opts);
    if (!opts.bytecodePath) {
      return injected;
    }
    const hermesc = opts.hermesc || readHermescSidecar(opts.bytecodePath);
    if (!hermesc) {
      throw new Error('hermesc not found; the debug-id stub would not be in the bytecode');
    }
    recompile({
      hermesc,
      bundlePath: opts.bundlePath,
      bytecodePath: opts.bytecodePath,
      intermediateMapPath: opts.intermediateMapPath,
      hermesArgs: opts.hermesArgs,
    });
    if (opts.composeScript) {
      runCompose(opts);
      stampDebugId(opts.composedMapPath, injected.debugId);
    }
    return { debugId: injected.debugId, uploadArgv: uploadArgv(opts.composedMapPath) };
  } finally {
    removePackagedPreserveFiles(opts.bytecodePath);
  }
}

function parseArgs(argv) {
  const out = { _: [], hermesArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--hermes-arg') {
      out.hermesArgs.push(argv[(i += 1)]);
      continue;
    }
    if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[(i += 1)];
      continue;
    }
    out._.push(arg);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === 'inject') {
    finishAfterCompose({
      bundlePath: args.bundle,
      composedMapPath: args.composed,
      intermediateMapPath: args.intermediate,
    });
    return;
  }
  if (command === 'finish') {
    finishAfterCompose({
      bundlePath: args.bundle,
      bytecodePath: args.bytecode,
      composedMapPath: args.composed,
      intermediateMapPath: args.intermediate,
      packagerMapPath: args.packager,
      composeScript: args.compose,
      hermesc: args.hermesc,
      hermesArgs: args.hermesArgs,
    });
    return;
  }
  process.stderr.write('usage: hermes-sourcemaps.js inject|finish [options]\n');
  process.exitCode = 1;
}

module.exports = {
  UPLOAD_ARGV,
  finishAfterCompose,
  injectComposedSourceMap,
  uploadArgv,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
