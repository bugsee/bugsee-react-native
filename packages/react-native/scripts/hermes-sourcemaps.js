'use strict';

/**
 * Hermes emits an intermediate compiler map, then `compose-source-maps.js`
 * writes the map a crash actually consults. `composeSourceMaps` builds a new
 * object and drops `debug_id`, so `bugsee-cli sourcemaps inject` has to run
 * on the composed map, after that script. The runtime stub has to be in the
 * JavaScript `hermesc` compiles; when a bytecode output is given, this
 * recompiles that JS and copies the same id back onto the recomposed map.
 *
 * `upload`, and `finish` after it has stamped the map, run
 * `bugsee-cli debug-files upload --type sourcemaps` on that composed map. The
 * upload runs only when it is switched on and a real app token is configured;
 * otherwise one line says why it skipped. A failed upload warns and the build
 * continues. The token reaches the CLI through its environment, never argv.
 *
 * Before upload, `sources` that are absolute paths under the project root are
 * rewritten to root-relative ones with a leading slash (`/scenarios/a.ts`),
 * the shape Expo's maps already have, so the dashboard never shows the build
 * machine's directory layout. Absolute paths outside the root (workspace
 * packages in a monorepo) become `../`-relative to it; entries that are
 * already relative, and paths on another Windows drive, are left as they are.
 * The rewrite goes to a
 * temporary copy; the map on disk is untouched. Symbolication reads the map's
 * `mappings` and the debug id, never the `sources` strings.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPLOAD_ARGV = ['debug-files', 'upload', '--type', 'sourcemaps'];
const DEBUG_ID_MARK = '//# debugId=';
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SOURCE_MAP_FLAG = '-output-source-map';

function uploadArgv(composedMapPath, appVersion, appBuild) {
  return [...UPLOAD_ARGV, '--version', appVersion, '--build', appBuild, composedMapPath];
}

function say(line) {
  process.stderr.write(`bugsee: ${line}\n`);
}

// Xcode reads a build-phase line shaped `error: ...` (optionally after a
// `file:line: ` prefix) as a build error and fails the Archive, whatever the
// script's exit status. bugsee-cli prints `error: upload failed: ...`, so its
// output is relayed as `warning: bugsee: ...`: the failure stays visible and
// the customer's build goes on. Mirrors CLI_OUTPUT_FILTER in
// plugin/src/dsym-script.ts, which does the same in sh.
const XCODE_ERROR_LINE = /^(?:.*: )?(?:[Ff]atal [Ee]rror|[Ee]rror): (.*)$/;

function diagnosticSafe(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const match = XCODE_ERROR_LINE.exec(line);
      return match ? `warning: bugsee: ${match[1]}` : line;
    })
    .join('\n');
}

function spawn(file, args, options) {
  return require('node:child_process').spawnSync(file, args, { encoding: 'utf8', ...options });
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

function resolveCli() {
  const pkgPath = require.resolve('@bugsee/cli/package.json');
  return path.join(path.dirname(pkgPath), readJson(pkgPath).bin['bugsee-cli']);
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
  const id = source.slice(at + DEBUG_ID_MARK.length).split(/\s/)[0];
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
    const debugId = readDebugId(injected);
    const map = readJson(stagedMap);
    if (map.debug_id !== debugId || map.debugId !== debugId) {
      throw new Error('composed map debug id does not match the bundle');
    }
    // Checked first, so a refused inject leaves both inputs as they were.
    fs.writeFileSync(bundlePath, injected);
    fs.copyFileSync(stagedMap, composedMapPath);
    return { debugId };
  } finally {
    remove(stage);
  }
}

/**
 * Where hermesc-preserve-js.sh writes, for a bundle under
 * `generated/assets`: the last such segment is the one under the build
 * directory, which is what the Gradle hook relativizes against. Any other
 * directory maps to itself.
 */
function preserveDirFor(filePath, paths = path) {
  const marker = `${paths.sep}generated${paths.sep}assets${paths.sep}`;
  const dir = paths.dirname(filePath);
  const at = dir.lastIndexOf(marker);
  if (at < 0) {
    return dir;
  }
  const replacement = `${paths.sep}intermediates${paths.sep}bugsee-sourcemaps${paths.sep}`;
  return `${dir.slice(0, at)}${replacement}${dir.slice(at + marker.length)}`;
}

function sidecarName(bytecodePath) {
  return `${path.basename(bytecodePath)}.bugsee-hermesc`;
}

function readHermescSidecar(bytecodePath) {
  const name = sidecarName(bytecodePath);
  const candidates = [path.join(preserveDirFor(bytecodePath), name), path.join(path.dirname(bytecodePath), name)];
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

/**
 * Copies beside the packaged bundle would ship in the APK. The preserved JS
 * and the hermesc note belong to this build: left behind, a later build whose
 * hermesc did not run through hermesc-preserve-js.sh would recompile the old
 * JS over its new bundle. Only a `.bugsee-js-source` bundle is deleted: iOS
 * passes the real `main.jsbundle`.
 */
function removePreserveFiles(bundlePath, bytecodePath) {
  if (bundlePath.endsWith('.bugsee-js-source')) {
    remove(bundlePath);
  }
  if (!bytecodePath) return;
  for (const suffix of PACKAGED_PRESERVE_SUFFIXES) {
    remove(bytecodePath + suffix);
  }
  remove(path.join(preserveDirFor(bytecodePath), sidecarName(bytecodePath)));
}

function recompile({ hermesc, bundlePath, bytecodePath, intermediateMapPath, hermesArgs }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-hermesc-'));
  try {
    const tempOut = path.join(stage, 'bundle.hbc');
    // hermesArgs carries -output-source-map; finishAfterCompose checked.
    const args = ['-w', '-emit-binary', '-max-diagnostic-width=80', ...hermesArgs, '-out', tempOut, bundlePath];
    run(hermesc, args, 'hermesc');
    fs.copyFileSync(tempOut, bytecodePath);
    fs.copyFileSync(`${tempOut}.map`, intermediateMapPath);
  } finally {
    remove(stage);
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
  const map = readJson(mapPath);
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
    if (opts.bytecodePath && !opts.hermesArgs?.includes(SOURCE_MAP_FLAG)) {
      say(
        `hermesFlags has no ${SOURCE_MAP_FLAG}, so React Native composed no source map; ` +
          'no debug id is injected and no source map is uploaded',
      );
      return null;
    }
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
    return injected;
  } finally {
    removePreserveFiles(opts.bundlePath, opts.bytecodePath);
  }
}

const OFF_VALUES = new Set(['false', '0', 'no', 'off']);

function isOff(value) {
  return value === false || OFF_VALUES.has(String(value).trim().toLowerCase());
}

const ON_VALUES = new Set(['true', '1', 'yes', 'on']);

/**
 * iOS Debug builds for a device bundle and compose too. Their -Og maps are
 * not uploaded unless BUGSEE_UPLOAD_DEBUG_SOURCEMAPS opts in, as Android
 * never bundles debug variants.
 */
function debugUploadAllowed(env) {
  return ON_VALUES.has(String(env.BUGSEE_UPLOAD_DEBUG_SOURCEMAPS).trim().toLowerCase());
}

/** Off when the build passes `false` or BUGSEE_UPLOAD_SOURCEMAPS says so. */
function uploadDisabled(option, env) {
  return isOff(option) || isOff(env.BUGSEE_UPLOAD_SOURCEMAPS);
}

function readProperties(file) {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  // A `#` comment yields a key starting with `#`, which nothing reads.
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

function readCredentials(file) {
  try {
    return readJson(file);
  } catch {
    return {};
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? '';
}

/**
 * Token: the one the Expo plugin baked into the build (BUGSEE_PLUGIN_APP_TOKEN
 * on iOS, `app_token` in android/bugsee.properties), then BUGSEE_APP_TOKEN,
 * then BUGSEE_TOKEN_IOS / BUGSEE_TOKEN_ANDROID, then the example app's
 * credentials.json. Endpoint: `plugin.endpoint`, BUGSEE_ENDPOINT, then
 * credentials.json. EAS keeps a credentials.json of its own whose values are
 * objects, so only strings count.
 */
function resolveUploadSettings({ platform, propertiesPath, credentialsPath, env }) {
  const props = propertiesPath ? readProperties(propertiesPath) : {};
  const creds = credentialsPath ? readCredentials(credentialsPath) : {};
  const platformToken = platform === 'ios' ? env.BUGSEE_TOKEN_IOS : env.BUGSEE_TOKEN_ANDROID;
  return {
    token: firstString(
      env.BUGSEE_PLUGIN_APP_TOKEN,
      props.app_token,
      env.BUGSEE_APP_TOKEN,
      platformToken,
      creds[platform],
    ),
    endpoint: firstString(props['plugin.endpoint'], env.BUGSEE_ENDPOINT, creds.endpoint),
  };
}

function isAbsoluteSource(source) {
  return path.posix.isAbsolute(source) || path.win32.isAbsolute(source);
}

/**
 * `dir` with symlinks resolved, through its nearest existing parent when it
 * does not exist. `cache` (a Map) keeps one answer per directory, so a map with
 * thousands of sources pays one filesystem lookup per directory, not per source.
 */
function realDirectory(dir, flavor, cache) {
  const known = cache.get(dir);
  if (known !== undefined) return known;
  const parent = flavor.dirname(dir);
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = parent === dir ? dir : flavor.join(realDirectory(parent, flavor, cache), flavor.basename(dir));
  }
  cache.set(dir, real);
  return real;
}

/** The parts of `to` relative to `from`, or undefined when there is no relative form (another drive). */
function relativeParts(flavor, from, to) {
  const relative = flavor.relative(from, to);
  if (!relative || flavor.isAbsolute(relative)) return undefined;
  return relative.split(/[\\/]/);
}

/**
 * Root-relative form of one `sources` entry, or the entry itself when it is
 * not an absolute path (or has no relative form).
 *
 * `memo` ({ dirs }) is shared across one map's entries.
 */
function relativizeSource(source, projectRoot, memo = { dirs: new Map() }) {
  if (typeof source !== 'string' || !isAbsoluteSource(source)) return source;
  const flavor = /^(?:[A-Za-z]:|\\\\)/.test(source) ? path.win32 : path.posix;
  const direct = relativeParts(flavor, flavor.resolve(projectRoot), flavor.resolve(source));
  // Another drive on Windows: there is no relative form.
  if (direct === undefined) return source;
  // Inside the root: `/scenarios/a.ts`, as Expo writes it. A source that reaches
  // the root through an in-tree symlink (a linked workspace package under
  // node_modules) stays under the root too, so it is not resolved here.
  if (direct[0] !== '..') return `/${direct.join('/')}`;
  // Outside the root by plain paths. That is also what a root and a source that
  // name the same place through a symlink look like (macOS: Xcode reports
  // /tmp/... while Metro writes /private/tmp/...), so compare real paths,
  // which gives `/scenarios/a.ts` for that case and `../packages/x/a.js` for a
  // genuinely outside source (a linked workspace package), still free of the
  // machine's absolute layout. Only this machine's own paths can be resolved:
  // `path` is the host's flavor (posix or win32).
  if (flavor === path) {
    const root = realDirectory(flavor.resolve(projectRoot), flavor, memo.dirs);
    const resolved = flavor.resolve(source);
    let real;
    try {
      // The file itself first: it may be a symlink to a file inside the root.
      real = fs.realpathSync(resolved);
    } catch {
      real = flavor.join(realDirectory(flavor.dirname(resolved), flavor, memo.dirs), flavor.basename(resolved));
    }
    const viaReal = relativeParts(flavor, root, real);
    // No relative form: the source is the root itself (through a link).
    if (viaReal !== undefined) return viaReal[0] === '..' ? viaReal.join('/') : `/${viaReal.join('/')}`;
  }
  return direct.join('/');
}

/** Returns the map text with `sources` made project-relative, or the text itself if nothing changed. */
function relativizeSourceMap(mapText, projectRoot) {
  const map = JSON.parse(mapText);
  if (!Array.isArray(map.sources) || !projectRoot) return mapText;
  let changed = false;
  const memo = { dirs: new Map() };
  map.sources = map.sources.map((source) => {
    const next = relativizeSource(source, projectRoot, memo);
    if (next !== source) changed = true;
    return next;
  });
  return changed ? JSON.stringify(map) : mapText;
}

const PLACEHOLDER_TOKEN = /^0{12}[0-9a-f]0{3}[0-9a-f]0{15}$/i;

function readMapDebugId(mapPath) {
  try {
    return readJson(mapPath).debug_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Upload one composed map. Never throws: a build is not failed over symbols.
 * Returns what happened, for the caller's tests.
 */
function uploadComposedSourceMap({
  composedMapPath,
  enabled = true,
  configuration,
  allowDebug = false,
  token,
  endpoint,
  appVersion,
  appBuild,
  cliPath,
  nodePath,
  projectRoot,
}) {
  if (!enabled) {
    say('source map upload skipped: uploadSourcemaps is off');
    return { status: 'skipped', reason: 'disabled' };
  }
  if (String(configuration).includes('Debug') && !allowDebug) {
    say('source map upload skipped: Debug configuration (set BUGSEE_UPLOAD_DEBUG_SOURCEMAPS=true to upload)');
    return { status: 'skipped', reason: 'debug' };
  }
  // Checked trimmed: bugsee-cli trims the token before it builds the URL, so
  // a padded placeholder would otherwise reach the endpoint.
  const tokenCheck = typeof token === 'string' ? token.trim() : '';
  if (!tokenCheck) {
    say('source map upload skipped: no app token is configured');
    return { status: 'skipped', reason: 'no-token' };
  }
  if (PLACEHOLDER_TOKEN.test(tokenCheck.replace(/-/g, ''))) {
    say('source map upload skipped: the app token is the placeholder');
    return { status: 'skipped', reason: 'placeholder' };
  }
  if (!appVersion || !appBuild) {
    say('source map upload skipped: the app version or build number is unknown');
    return { status: 'skipped', reason: 'no-version' };
  }
  if (!fs.existsSync(composedMapPath)) {
    say(`source map upload skipped: no source map at ${composedMapPath}`);
    return { status: 'skipped', reason: 'no-map' };
  }
  let cli;
  try {
    cli = cliPath || resolveCli();
  } catch {
    say('source map upload failed (@bugsee/cli is not installed); the app build continues');
    return { status: 'failed', exitCode: null };
  }
  const env = { ...process.env, BUGSEE_APP_TOKEN: token };
  if (endpoint) env.BUGSEE_ENDPOINT = endpoint;
  let stage = null;
  let uploadPath = composedMapPath;
  try {
    const original = fs.readFileSync(composedMapPath, 'utf8');
    const rewritten = relativizeSourceMap(original, projectRoot);
    if (rewritten !== original) {
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-upload-'));
      uploadPath = path.join(stage, path.basename(composedMapPath));
      fs.writeFileSync(uploadPath, rewritten);
    }
  } catch (err) {
    say(`could not make source map paths project-relative (${err.message}); uploading the map as it is`);
    if (stage) remove(stage);
    stage = null;
    uploadPath = composedMapPath;
  }
  let result;
  try {
    result = spawn(nodePath || process.execPath, [cli, ...uploadArgv(uploadPath, appVersion, appBuild)], {
      env,
      timeout: UPLOAD_TIMEOUT_MS,
    });
  } finally {
    if (stage) remove(stage);
  }
  if (result.stdout) process.stdout.write(diagnosticSafe(result.stdout));
  if (result.stderr) process.stderr.write(diagnosticSafe(result.stderr));
  if (result.error && !result.signal) {
    say(`source map upload failed (bugsee-cli did not start: ${result.error.code}); the app build continues`);
    return { status: 'failed', exitCode: null };
  }
  if (result.status !== 0) {
    say(`source map upload failed (bugsee-cli exit ${result.status ?? result.signal}); the app build continues`);
    return { status: 'failed', exitCode: result.status };
  }
  const debugId = readMapDebugId(composedMapPath);
  say(`uploaded source map ${debugId}`);
  return { status: 'uploaded', debugId };
}

function uploadFromArgs(args) {
  const settings = resolveUploadSettings({
    platform: args.platform,
    propertiesPath: args.properties,
    credentialsPath: args.credentials,
    env: process.env,
  });
  return uploadComposedSourceMap({
    composedMapPath: args.composed,
    enabled: !uploadDisabled(args['upload-sourcemaps'], process.env),
    configuration: args.configuration,
    allowDebug: debugUploadAllowed(process.env),
    token: settings.token,
    endpoint: settings.endpoint,
    appVersion: args['app-version'],
    appBuild: args['app-build'],
    projectRoot: args['project-root'],
  });
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
    const finished = finishAfterCompose({
      bundlePath: args.bundle,
      bytecodePath: args.bytecode,
      composedMapPath: args.composed,
      intermediateMapPath: args.intermediate,
      packagerMapPath: args.packager,
      composeScript: args.compose,
      hermesc: args.hermesc,
      hermesArgs: args.hermesArgs,
    });
    if (finished) {
      uploadFromArgs(args);
    }
    return;
  }
  if (command === 'upload') {
    uploadFromArgs(args);
    return;
  }
  process.stderr.write('usage: hermes-sourcemaps.js inject|finish|upload [options]\n');
  process.exitCode = 1;
}

module.exports = {
  UPLOAD_ARGV,
  cli,
  debugUploadAllowed,
  finishAfterCompose,
  injectComposedSourceMap,
  main,
  preserveDirFor,
  readDebugId,
  relativizeSource,
  relativizeSourceMap,
  resolveUploadSettings,
  retargetSourceMappingUrl,
  diagnosticSafe,
  uploadArgv,
  uploadComposedSourceMap,
  uploadDisabled,
};

/** Command-line entry: a failure prints its reason and sets exit code 1. */
function cli(argv) {
  try {
    main(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  cli(process.argv.slice(2));
}
