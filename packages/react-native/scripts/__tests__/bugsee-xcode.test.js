'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readLog, startStub, stopStub } = require('./fixtures/stub');
const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

const HOOK = path.join(__dirname, '..', 'bugsee-xcode.sh');
const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0001';

// The steps of react-native-xcode.sh that matter here: Metro writes the JS
// and the packager map, hermesc compiles into the app, and the composer named
// by COMPOSE_SOURCEMAP_PATH writes SOURCEMAP_FILE.
const FAKE_RN_XCODE = `#!/bin/sh
set -e
BUNDLE_FILE="$CONFIGURATION_BUILD_DIR/main.jsbundle"
DEST="$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$DEST"
printf 'console.log("bugsee-fixture")\\n' > "$BUNDLE_FILE"
if [ "$USE_HERMES" = false ]; then
  printf '{"version":3,"sources":["App.tsx"],"names":[],"mappings":"AAAA"}' > "$SOURCEMAP_FILE"
  cp "$BUNDLE_FILE" "$DEST/"
  exit 0
fi
PACKAGER="$CONFIGURATION_BUILD_DIR/$(basename "$SOURCEMAP_FILE")"
printf '{"version":3,"sources":["App.tsx"],"names":[],"mappings":"AAAA"}' > "$PACKAGER"
"$HERMES_CLI_PATH" -emit-binary -O -output-source-map -out "$DEST/main.jsbundle" "$BUNDLE_FILE"
"$NODE_BINARY" "$COMPOSE_SOURCEMAP_PATH" "$PACKAGER" "$DEST/main.jsbundle.map" -o "$SOURCEMAP_FILE"
rm "$DEST/main.jsbundle.map" "$PACKAGER"
`;

const FAKE_HERMESC = `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-out" ]; then out="$arg"; fi
  prev="$arg"
done
input=""
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
  esac
  if [ "$arg" != "$out" ] && [ -f "$arg" ]; then input="$arg"; fi
done
cp "$input" "$out"
printf '%s\\n' '{"version":3,"mappings":"BBBB"}' > "$out.map"
`;

const FAKE_COMPOSE = `const fs = require('fs');
const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
}
fs.writeFileSync(out, JSON.stringify({ version: 3, sources: ['App.tsx'], names: [], mappings: 'CCCC' }));
`;

describe('bugsee-xcode.sh', () => {
  let dir;
  let env;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-xcode-'));
    const rn = path.join(dir, 'node_modules', 'react-native');
    fs.mkdirSync(path.join(rn, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(rn, 'scripts', 'react-native-xcode.sh'), FAKE_RN_XCODE);
    fs.writeFileSync(path.join(rn, 'scripts', 'compose-source-maps.js'), FAKE_COMPOSE);
    const hermesc = path.join(dir, 'hermesc');
    fs.writeFileSync(hermesc, FAKE_HERMESC);
    fs.chmodSync(hermesc, 0o755);
    const ios = path.join(dir, 'ios');
    fs.mkdirSync(ios);
    env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // The hook's children get only this env: the dead loopback is the
      // default, and the upload test swaps in its stub.
      BUGSEE_ENDPOINT: process.env.BUGSEE_ENDPOINT,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      NODE_BINARY: process.execPath,
      REACT_NATIVE_PATH: rn,
      SRCROOT: ios,
      CONFIGURATION: 'Release',
      CONFIGURATION_TEMP_DIR: path.join(dir, 'temp'),
      CONFIGURATION_BUILD_DIR: path.join(dir, 'products'),
      UNLOCALIZED_RESOURCES_FOLDER_PATH: 'App.app',
      HERMES_CLI_PATH: hermesc,
      MARKETING_VERSION: '1.0',
      CURRENT_PROJECT_VERSION: '3',
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runHook(extra) {
    return cp.spawnSync('/bin/bash', [HOOK], { cwd: env.SRCROOT, encoding: 'utf8', env: { ...env, ...extra } });
  }

  function composedMap() {
    return JSON.parse(fs.readFileSync(path.join(dir, 'temp', 'main.jsbundle.composed.map'), 'utf8'));
  }

  it('uploads the composed map with the id in the shipped bytecode, using the baked token', async () => {
    const logPath = path.join(dir, 'stub.jsonl');
    const stub = await startStub(logPath);
    let result;
    try {
      result = runHook({ BUGSEE_PLUGIN_APP_TOKEN: TOKEN, BUGSEE_ENDPOINT: `http://127.0.0.1:${stub.port}` });
    } finally {
      await stopStub(stub);
    }
    expect(result.status).toBe(0);
    const map = composedMap();
    const shipped = fs.readFileSync(path.join(dir, 'products', 'App.app', 'main.jsbundle'), 'utf8');
    expect(shipped).toContain(map.debug_id);
    const log = readLog(logPath);
    expect(log.map((entry) => entry.method)).toEqual(['POST', 'PUT']);
    expect(log[0].token).toBe(TOKEN);
    expect(log[0].json).toMatchObject({ uuid: map.debug_id, version: '1.0', build: '3' });
    expect(log[1].entries).toEqual([
      expect.objectContaining({ name: 'main.jsbundle.composed.map', debugId: map.debug_id }),
    ]);
    expect(result.stderr).toContain(`bugsee: uploaded source map ${map.debug_id}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
  });

  it('skips with one line for the placeholder in ../credentials.json', () => {
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ ios: '00000000-0000-4000-8000-000000000000' }),
    );
    const result = runHook({});
    expect(result.status).toBe(0);
    expect(composedMap().debug_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stderr).toContain('bugsee: source map upload skipped: the app token is the placeholder\n');
    expect(result.stderr).not.toContain('bugsee: uploaded');
  });

  it('honours BUGSEE_UPLOAD_SOURCEMAPS=false', () => {
    const result = runHook({ BUGSEE_PLUGIN_APP_TOKEN: TOKEN, BUGSEE_UPLOAD_SOURCEMAPS: 'false' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('bugsee: source map upload skipped: uploadSourcemaps is off\n');
  });

  it('injects and runs the upload gate on the Metro map when Hermes is off', () => {
    const result = runHook({ USE_HERMES: 'false' });
    expect(result.status).toBe(0);
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'temp', 'main.jsbundle.composed.map'), 'utf8'));
    expect(map.debug_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stderr).toContain('bugsee: source map upload skipped: no app token is configured\n');
  });
});
