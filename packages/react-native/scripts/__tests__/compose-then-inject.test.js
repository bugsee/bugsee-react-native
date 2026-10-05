'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseComposeArgv, run } = require('../compose-then-inject');
const { readLog, startStub, stopStub } = require('./fixtures/stub');
const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0001';

const SCRIPT = path.join(__dirname, '..', 'compose-then-inject.js');

describe('compose-then-inject', () => {
  let dir;
  let written;
  let stderr;
  let env;
  let argsLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-compose-inject-'));
    written = [];
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const bundle = path.join(dir, 'main.jsbundle');
    fs.writeFileSync(bundle, 'console.log("bugsee-fixture")\n');
    const bytecode = path.join(dir, 'BareExample.app-main.jsbundle');
    fs.writeFileSync(bytecode, 'HBC');
    argsLog = path.join(dir, 'hermesc-args');
    const hermesc = path.join(dir, 'hermesc');
    fs.writeFileSync(
      hermesc,
      `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
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
`,
    );
    fs.chmodSync(hermesc, 0o755);
    const compose = path.join(dir, 'compose-source-maps.js');
    fs.writeFileSync(
      compose,
      `const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'fail') { process.stderr.write('compose broke'); process.exit(3); }
if (args[0] === 'out') { process.stdout.write('compose said'); process.exit(4); }
if (args[0] === 'silent') { process.exit(0 + 1); }
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
}
fs.writeFileSync(out, JSON.stringify({ version: 3, mappings: 'CCCC' }));
`,
    );
    fs.writeFileSync(path.join(dir, 'packager.map'), '{"version":3,"mappings":"AAAA"}');
    fs.writeFileSync(path.join(dir, 'compiler.map'), '{"version":3,"mappings":"AAAB"}');
    env = {
      BUGSEE_REAL_COMPOSE: compose,
      BUGSEE_JS_BUNDLE: bundle,
      BUGSEE_BYTECODE_BUNDLE: bytecode,
      BUGSEE_HERMESC: hermesc,
    };
  });

  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function argv(packager = path.join(dir, 'packager.map')) {
    return [packager, path.join(dir, 'compiler.map'), '-o', path.join(dir, 'composed.map')];
  }

  it('parses the compose argv in any order', () => {
    expect(parseComposeArgv(['-o', 'out.map', 'p.map', 'c.map'])).toEqual({
      packager: 'p.map',
      compiler: 'c.map',
      output: 'out.map',
    });
    expect(parseComposeArgv(['p.map'])).toEqual({ packager: 'p.map', compiler: undefined, output: undefined });
  });

  it('composes, injects, recompiles with the default Hermes args and stamps the composed map', () => {
    expect(run(argv(), env)).toBe(0);
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'composed.map'), 'utf8'));
    const shipped = fs.readFileSync(env.BUGSEE_BYTECODE_BUNDLE, 'utf8');
    expect(map.mappings).toBe('CCCC');
    expect(map.debug_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(shipped).toContain(map.debug_id);
    expect(fs.readFileSync(argsLog, 'utf8')).toMatch(/^-w -emit-binary -max-diagnostic-width=80 -O -output-source-map -out /);
    expect(written.join('')).toBe('bugsee: source map upload skipped: no app token is configured\n');
  });

  it('passes BUGSEE_HERMES_ARGS to hermesc', () => {
    expect(run(argv(), { ...env, BUGSEE_HERMES_ARGS: '  -Og   -output-source-map ' })).toBe(0);
    expect(fs.readFileSync(argsLog, 'utf8')).toMatch(/-max-diagnostic-width=80 -Og -output-source-map -out /);
  });

  it('refuses to run without its environment', () => {
    for (const name of ['BUGSEE_REAL_COMPOSE', 'BUGSEE_JS_BUNDLE', 'BUGSEE_BYTECODE_BUNDLE']) {
      written.length = 0;
      expect(run(argv(), { ...env, [name]: '' })).toBe(1);
      expect(written.join('')).toBe(
        'BUGSEE_REAL_COMPOSE, BUGSEE_JS_BUNDLE and BUGSEE_BYTECODE_BUNDLE must be set\n',
      );
    }
  });

  it('refuses an incomplete compose argv', () => {
    const usage = 'usage: compose-then-inject.js <packager map> <compiler map> -o <composed map>\n';
    for (const bad of [[], ['p.map'], ['p.map', 'c.map'], ['p.map', '-o', 'out.map']]) {
      written.length = 0;
      expect(run(bad, env)).toBe(1);
      expect(written.join('')).toBe(usage);
    }
  });

  it('passes a failed compose through with its exit code and output', () => {
    expect(run(argv('fail'), env)).toBe(3);
    expect(written.join('')).toBe('compose broke');
    expect(fs.existsSync(path.join(dir, 'composed.map'))).toBe(false);
  });

  it('passes stdout through when compose fails without stderr, and nothing when it is silent', () => {
    expect(run(argv('out'), env)).toBe(4);
    expect(written.join('')).toBe('compose said');
    written.length = 0;
    expect(run(argv('silent'), env)).toBe(1);
    expect(written.join('')).toBe('');
  });

  it('reports a failed inject as exit 1 with the reason', () => {
    expect(run(argv(), { ...env, BUGSEE_HERMESC: path.join(dir, 'missing-hermesc') })).toBe(1);
    expect(written.join('')).toMatch(/^hermesc failed to start: .*\n$/);
  });

  it('uploads the recomposed map with the id in the shipped bytecode', async () => {
    const logPath = path.join(dir, 'stub.jsonl');
    const stub = await startStub(logPath);
    try {
      const code = run(argv(), {
        ...env,
        BUGSEE_PLUGIN_APP_TOKEN: TOKEN,
        BUGSEE_ENDPOINT: `http://127.0.0.1:${stub.port}`,
        MARKETING_VERSION: '1.0',
        CURRENT_PROJECT_VERSION: '12',
      });
      expect(code).toBe(0);
    } finally {
      await stopStub(stub);
    }
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'composed.map'), 'utf8'));
    const shipped = fs.readFileSync(env.BUGSEE_BYTECODE_BUNDLE, 'utf8');
    expect(shipped).toContain(map.debug_id);
    const log = readLog(logPath);
    expect(log[0].token).toBe(TOKEN);
    expect(log[0].json).toMatchObject({ uuid: map.debug_id, version: '1.0', build: '12' });
    expect(log[1].entries).toEqual([expect.objectContaining({ name: 'composed.map', debugId: map.debug_id })]);
    expect(written.join('')).toContain(`bugsee: uploaded source map ${map.debug_id}\n`);
    expect(written.join('')).not.toContain(TOKEN);
  });

  it('reads the iOS token from credentials.json and honours the off switch', () => {
    const credentials = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentials, JSON.stringify({ ios: '00000000-0000-4000-8000-000000000000' }));
    const versions = { MARKETING_VERSION: '1', CURRENT_PROJECT_VERSION: '1' };
    expect(run(argv(), { ...env, ...versions, BUGSEE_CREDENTIALS_FILE: credentials })).toBe(0);
    expect(written.join('')).toBe('bugsee: source map upload skipped: the app token is the placeholder\n');

    written.length = 0;
    expect(
      run(argv(), { ...env, ...versions, BUGSEE_CREDENTIALS_FILE: credentials, BUGSEE_UPLOAD_SOURCEMAPS: 'false' }),
    ).toBe(0);
    expect(written.join('')).toBe('bugsee: source map upload skipped: uploadSourcemaps is off\n');
  });

  it('skips the upload for a Debug configuration unless opted in', () => {
    const versions = { MARKETING_VERSION: '1', CURRENT_PROJECT_VERSION: '1', BUGSEE_PLUGIN_APP_TOKEN: TOKEN };
    expect(run(argv(), { ...env, ...versions, CONFIGURATION: 'Debug' })).toBe(0);
    expect(written.join('')).toBe(
      'bugsee: source map upload skipped: Debug configuration (set BUGSEE_UPLOAD_DEBUG_SOURCEMAPS=true to upload)\n',
    );
    written.length = 0;
    const spawn = jest.spyOn(cp, 'spawnSync');
    try {
      run(argv(), { ...env, ...versions, CONFIGURATION: 'Debug', BUGSEE_UPLOAD_DEBUG_SOURCEMAPS: 'true' });
      expect(spawn.mock.calls.some((call) => (call[1] ?? []).includes('debug-files'))).toBe(true);
    } finally {
      spawn.mockRestore();
    }
    expect(written.join('')).not.toContain('Debug configuration');
  });

  it('does not upload when finish skipped', () => {
    expect(run(argv(), { ...env, BUGSEE_HERMES_ARGS: '-O', BUGSEE_PLUGIN_APP_TOKEN: TOKEN })).toBe(0);
    expect(written.join('')).toContain('no -output-source-map');
    expect(written.join('')).not.toContain('source map upload');
  });

  it('sets the process exit code when run as a script', () => {
    const result = cp.spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: {} });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be set');
    const ok = cp.spawnSync(process.execPath, [SCRIPT, ...argv()], {
      encoding: 'utf8',
      env: { ...env, PATH: process.env.PATH },
    });
    expect(ok.status).toBe(0);
  });
});
