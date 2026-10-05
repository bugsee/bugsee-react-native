'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cp = require('node:child_process');
const {
  cli,
  finishAfterCompose,
  injectComposedSourceMap,
  main,
  preserveDirFor,
  readDebugId,
  retargetSourceMappingUrl,
} = require('../hermes-sourcemaps');
const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function debugIdOf(source) {
  const marker = '//# debugId=';
  const at = source.lastIndexOf(marker);
  if (at < 0) return null;
  return source.slice(at + marker.length, at + marker.length + 36);
}

describe('Hermes source maps', () => {
  let dir;
  let spawn;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-hermes-maps-'));
    spawn = jest.spyOn(cp, 'spawnSync');
  });

  afterEach(() => {
    spawn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the composed map and the bundle with one debug id, and leaves the intermediate map alone', () => {
    const bundlePath = path.join(dir, 'main.jsbundle');
    const intermediatePath = path.join(dir, 'main.jsbundle.compiler.map');
    const composedPath = path.join(dir, 'main.jsbundle.map');
    // The packager bundle points at the compiler map. That is the map a
    // crash does not consult; inject must not follow it.
    fs.writeFileSync(
      bundlePath,
      'console.log("bugsee-fixture")\n//# sourceMappingURL=main.jsbundle.compiler.map\n',
    );
    const intermediate = {
      version: 3,
      file: 'intermediate.js',
      sources: ['src/app.js'],
      names: [],
      mappings: 'AAAA',
    };
    const composed = {
      version: 3,
      file: 'composed.js',
      sources: ['src/app.js'],
      names: [],
      mappings: 'AACA',
    };
    writeJson(intermediatePath, intermediate);
    writeJson(composedPath, composed);
    const intermediateBefore = fs.readFileSync(intermediatePath, 'utf8');

    const result = finishAfterCompose({
      bundlePath,
      composedMapPath: composedPath,
      intermediateMapPath: intermediatePath,
    });

    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const id = debugIdOf(bundle);
    const composedMap = JSON.parse(fs.readFileSync(composedPath, 'utf8'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(bundle).toContain('_bugseeDebugIds');
    expect(composedMap.debug_id).toBe(id);
    expect(composedMap.debugId).toBe(id);
    expect(fs.readFileSync(intermediatePath, 'utf8')).toBe(intermediateBefore);
    expect(result).toEqual({ debugId: id });

    const spawned = spawn.mock.calls.map((call) => (call[1] ?? []).join(' '));
    expect(spawned.some((line) => line.includes('sourcemaps') && line.includes('inject'))).toBe(
      true,
    );
    expect(spawned.some((line) => line.includes('debug-files') || line.includes('upload'))).toBe(
      false,
    );
  });

  it('keeps that debug id on the composed map after hermesc and a second compose', () => {
    const bundlePath = path.join(dir, 'index.android.bundle');
    const bytecodePath = path.join(dir, 'index.android.bundle.shipped');
    const intermediatePath = path.join(dir, 'index.android.bundle.compiler.map');
    const packagerPath = path.join(dir, 'index.android.bundle.packager.map');
    const composedPath = path.join(dir, 'index.android.bundle.map');
    fs.writeFileSync(bundlePath, 'console.log("bugsee-fixture")\n');
    writeJson(intermediatePath, { version: 3, file: 'compiler.js', mappings: 'AAAA' });
    writeJson(packagerPath, { version: 3, file: 'packager.js', mappings: 'AAAC' });
    writeJson(composedPath, { version: 3, file: 'composed.js', mappings: 'AACA' });

    const hermesc = path.join(dir, 'hermesc');
    fs.writeFileSync(
      hermesc,
      `#!/bin/sh
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
printf '%s\\n' '{"version":3,"file":"compiler.js","mappings":"BBBB"}' > "$out.map"
`,
    );
    fs.chmodSync(hermesc, 0o755);

    const composeScript = path.join(dir, 'compose-source-maps.js');
    fs.writeFileSync(
      composeScript,
      `const fs = require('fs');
const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
}
fs.writeFileSync(out, JSON.stringify({ version: 3, file: 'recomposed.js', mappings: 'CCCC' }));
`,
    );

    const result = finishAfterCompose({
      bundlePath,
      bytecodePath,
      composedMapPath: composedPath,
      intermediateMapPath: intermediatePath,
      packagerMapPath: packagerPath,
      composeScript,
      hermesc,
      hermesArgs: ['-O', '-output-source-map'],
    });

    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const id = debugIdOf(bundle);
    const shipped = fs.readFileSync(bytecodePath, 'utf8');
    const composedMap = JSON.parse(fs.readFileSync(composedPath, 'utf8'));
    const intermediate = JSON.parse(fs.readFileSync(intermediatePath, 'utf8'));
    expect(shipped).toContain('_bugseeDebugIds');
    expect(shipped).toContain(id);
    expect(composedMap.mappings).toBe('CCCC');
    expect(composedMap.debug_id).toBe(id);
    expect(composedMap.debugId).toBe(id);
    expect(intermediate.debug_id).toBeUndefined();
    expect(intermediate.debugId).toBeUndefined();
    // The recompile's own map replaces the stale intermediate before compose.
    expect(intermediate.mappings).toBe('BBBB');
    expect(result).toEqual({ debugId: id });
    expect(
      spawn.mock.calls.some((call) => (call[1] ?? []).join(' ').includes('debug-files')),
    ).toBe(false);
  });

  it('does not leave preserve files beside the packaged bundle', () => {
    const assets = path.join(dir, 'build/generated/assets/react/release');
    const intermediates = path.join(dir, 'build/intermediates/bugsee-sourcemaps/react/release');
    fs.mkdirSync(assets, { recursive: true });
    const packaged = path.join(assets, 'index.android.bundle');
    fs.writeFileSync(packaged, 'console.log("bugsee-fixture")\n');

    const hermesc = path.join(dir, 'hermesc');
    fs.writeFileSync(hermesc, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hermesc, 0o755);
    const preserve = path.join(__dirname, '..', 'hermesc-preserve-js.sh');
    const saved = cp.spawnSync(
      preserve,
      ['-w', '-emit-binary', '-out', `${packaged}.hbc`, packaged, '-O', '-output-source-map'],
      { env: { ...process.env, BUGSEE_REAL_HERMESC: hermesc } },
    );
    expect(saved.status).toBe(0);
    expect(fs.existsSync(`${packaged}.bugsee-js-source`)).toBe(false);
    expect(fs.existsSync(`${packaged}.bugsee-hermesc`)).toBe(false);
    expect(fs.existsSync(path.join(intermediates, 'index.android.bundle.bugsee-js-source'))).toBe(
      true,
    );

    // A copy left in the asset directory from an older build must not survive finish.
    fs.writeFileSync(`${packaged}.bugsee-js-source`, 'packaged source');
    fs.writeFileSync(`${packaged}.bugsee-hermesc`, hermesc);
    fs.writeFileSync(`${packaged}.bugsee-recompile`, 'packaged temp');
    const composedPath = path.join(dir, 'index.android.bundle.map');
    const intermediatePath = path.join(dir, 'index.android.bundle.compiler.map');
    const packagerPath = path.join(dir, 'index.android.bundle.packager.map');
    writeJson(composedPath, { version: 3, file: 'composed.js', mappings: 'AACA' });
    writeJson(intermediatePath, { version: 3, file: 'compiler.js', mappings: 'AAAA' });
    writeJson(packagerPath, { version: 3, file: 'packager.js', mappings: 'AAAC' });
    const compile = path.join(dir, 'hermesc-compile');
    fs.writeFileSync(
      compile,
      `#!/bin/sh
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
    fs.chmodSync(compile, 0o755);
    const composeScript = path.join(dir, 'compose-source-maps.js');
    fs.writeFileSync(
      composeScript,
      `const fs = require('fs');
const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
}
fs.writeFileSync(out, JSON.stringify({ version: 3, mappings: 'CCCC' }));
`,
    );

    finishAfterCompose({
      bundlePath: path.join(intermediates, 'index.android.bundle.bugsee-js-source'),
      bytecodePath: packaged,
      composedMapPath: composedPath,
      intermediateMapPath: intermediatePath,
      packagerMapPath: packagerPath,
      composeScript,
      hermesc: compile,
      hermesArgs: ['-O', '-output-source-map'],
    });

    const names = fs.readdirSync(assets);
    expect(names.filter((name) => name.includes('bugsee'))).toEqual([]);
    expect(fs.readFileSync(packaged, 'utf8')).toContain('_bugseeDebugIds');
    // The preserved JS and the hermesc note are this build's only. A later
    // build that skips hermesc-preserve-js.sh must not find them.
    expect(fs.readdirSync(intermediates)).toEqual([]);
  });
});

describe('Android finish guards', () => {
  let dir;
  let assets;
  let intermediates;
  let packaged;
  let preserved;
  let sidecar;
  let composedPath;
  let intermediatePath;
  let packagerPath;
  let hermesc;
  let composeScript;
  let stderr;
  let written;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-finish-'));
    assets = path.join(dir, 'build/generated/assets/react/release');
    intermediates = path.join(dir, 'build/intermediates/bugsee-sourcemaps/react/release');
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(intermediates, { recursive: true });
    packaged = path.join(assets, 'index.android.bundle');
    fs.writeFileSync(packaged, 'HBC-from-this-build');
    preserved = path.join(intermediates, 'index.android.bundle.bugsee-js-source');
    fs.writeFileSync(preserved, 'console.log("bugsee-fixture")\n');
    sidecar = path.join(intermediates, 'index.android.bundle.bugsee-hermesc');
    composedPath = path.join(dir, 'index.android.bundle.map');
    intermediatePath = path.join(dir, 'index.android.bundle.compiler.map');
    packagerPath = path.join(dir, 'index.android.bundle.packager.map');
    writeJson(composedPath, { version: 3, file: 'stale.js', mappings: 'AACA' });
    writeJson(intermediatePath, { version: 3, file: 'compiler.js', mappings: 'AAAA' });
    writeJson(packagerPath, { version: 3, file: 'packager.js', mappings: 'AAAC' });
    hermesc = path.join(dir, 'hermesc');
    fs.writeFileSync(
      hermesc,
      `#!/bin/sh
printf '%s\\n' "$*" > "${dir}/hermesc-args"
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
    fs.writeFileSync(sidecar, `${hermesc}\n`);
    composeScript = path.join(dir, 'compose-source-maps.js');
    fs.writeFileSync(
      composeScript,
      `const fs = require('fs');
const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
}
fs.writeFileSync(out, JSON.stringify({ version: 3, mappings: 'CCCC' }));
`,
    );
    written = [];
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function finishArgs(extra = []) {
    return [
      'finish',
      '--bundle',
      preserved,
      '--bytecode',
      packaged,
      '--composed',
      composedPath,
      '--intermediate',
      intermediatePath,
      '--packager',
      packagerPath,
      '--compose',
      composeScript,
      ...extra,
    ];
  }

  it('skips without touching a map when -output-source-map is not in hermesFlags', () => {
    const before = fs.readFileSync(composedPath, 'utf8');
    const spawn = jest.spyOn(cp, 'spawnSync');
    try {
      const result = finishAfterCompose({
        bundlePath: preserved,
        bytecodePath: packaged,
        composedMapPath: composedPath,
        intermediateMapPath: intermediatePath,
        packagerMapPath: packagerPath,
        composeScript,
        hermesc,
        hermesArgs: ['-O'],
      });
      expect(result).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
    expect(fs.readFileSync(composedPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(packaged, 'utf8')).toBe('HBC-from-this-build');
    expect(written.join('')).toBe(
      'bugsee: hermesFlags has no -output-source-map, so React Native composed no source map; ' +
        'no debug id is injected and no source map is uploaded\n',
    );
    expect(fs.readdirSync(intermediates)).toEqual([]);
  });

  it('still checks the flag when hermesArgs is empty', () => {
    expect(
      finishAfterCompose({
        bundlePath: preserved,
        bytecodePath: packaged,
        composedMapPath: composedPath,
        hermesc,
        hermesArgs: [],
      }),
    ).toBeNull();
    expect(written.join('')).toContain('no -output-source-map');
  });

  it('deletes the preserve files even when finish fails', () => {
    fs.writeFileSync(composedPath, '{ not json');
    expect(() =>
      finishAfterCompose({
        bundlePath: preserved,
        bytecodePath: packaged,
        composedMapPath: composedPath,
        intermediateMapPath: intermediatePath,
        hermesc,
        hermesArgs: ['-O', '-output-source-map'],
      }),
    ).toThrow();
    expect(fs.readdirSync(intermediates)).toEqual([]);
  });

  it('never deletes a bundle that is not a preserve file', () => {
    // iOS passes the real main.jsbundle as the bundle. It has to survive.
    const bundlePath = path.join(dir, 'main.jsbundle');
    fs.writeFileSync(bundlePath, 'console.log("bugsee-fixture")\n');
    finishAfterCompose({ bundlePath, composedMapPath: composedPath, intermediateMapPath: intermediatePath });
    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(fs.existsSync(preserved)).toBe(true);
    expect(fs.existsSync(sidecar)).toBe(true);
  });

  it('runs finish then the upload gate, which says why it skipped', () => {
    main(
      finishArgs([
        '--hermes-arg',
        '-O',
        '--hermes-arg',
        '-output-source-map',
        '--upload-sourcemaps',
        'false',
        '--app-version',
        '1',
        '--app-build',
        '1',
      ]),
    );
    const map = JSON.parse(fs.readFileSync(composedPath, 'utf8'));
    expect(map.mappings).toBe('CCCC');
    expect(map.debug_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.join('')).toBe('bugsee: source map upload skipped: uploadSourcemaps is off\n');
    expect(fs.readFileSync(path.join(dir, 'hermesc-args'), 'utf8')).toMatch(
      /^-w -emit-binary -max-diagnostic-width=80 -O -output-source-map -out \S+ \S+\n$/,
    );
    expect(fs.readdirSync(intermediates)).toEqual([]);
  });

  it('reads the token for that gate from the properties file', () => {
    const properties = path.join(dir, 'bugsee.properties');
    fs.writeFileSync(properties, 'app_token=00000000-0000-4000-8000-000000000000\n');
    const spawn = jest.spyOn(cp, 'spawnSync');
    try {
      main(
        finishArgs([
          '--hermes-arg',
          '-output-source-map',
          '--properties',
          properties,
          '--platform',
          'android',
          '--app-version',
          '1',
          '--app-build',
          '1',
        ]),
      );
      const commands = spawn.mock.calls.map((call) => (call[1] ?? []).join(' '));
      expect(commands.some((line) => line.includes('debug-files'))).toBe(false);
    } finally {
      spawn.mockRestore();
    }
    expect(written.join('')).toBe(
      'bugsee: source map upload skipped: the app token is the placeholder\n',
    );
  });

  it('does not reach the upload gate when finish skipped', () => {
    main(finishArgs(['--hermes-arg', '-O', '--upload-sourcemaps', 'false']));
    expect(written.join('')).not.toContain('source map upload');
  });

  it('prints usage and sets the exit code for an unknown command', () => {
    const saved = process.exitCode;
    try {
      main(['bogus']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
    expect(written.join('')).toBe('usage: hermes-sourcemaps.js inject|finish|upload [options]\n');
  });
});

describe('inject helpers', () => {
  const ID = '54410e32-2841-50e9-a70f-714cec4148b5';

  it('points the bundle at the staged map, appending a comment when there is none', () => {
    expect(retargetSourceMappingUrl('a()\n//# sourceMappingURL=x.map\n', 'c.map')).toBe(
      'a()\n//# sourceMappingURL=c.map\n',
    );
    expect(retargetSourceMappingUrl('a()\n', 'c.map')).toBe('a()\n//# sourceMappingURL=c.map\n');
    expect(retargetSourceMappingUrl('a()', 'c.map')).toBe('a()\n//# sourceMappingURL=c.map\n');
  });

  it('reads the last debug id and refuses a missing or malformed one', () => {
    expect(readDebugId(`//# debugId=${ID}`)).toBe(ID);
    expect(readDebugId(`x\n//# debugId=00000000-0000-5000-8000-000000000000\n//# debugId=${ID}\n`)).toBe(ID);
    expect(() => readDebugId('x\n')).toThrow('sourcemaps inject did not write a debug id into the bundle');
    expect(() => readDebugId('//# debugId=not-a-uuid\n')).toThrow(
      'sourcemaps inject wrote a debug id that is not a UUID',
    );
    expect(() => readDebugId(`//# debugId=x${ID}\n`)).toThrow('not a UUID');
    expect(() => readDebugId(`//# debugId=${ID}0\n`)).toThrow('not a UUID');
  });
});

describe('inject with a stand-in CLI', () => {
  let dir;
  let bundlePath;
  let mapPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-fake-cli-'));
    bundlePath = path.join(dir, 'main.jsbundle');
    mapPath = path.join(dir, 'main.map');
    fs.writeFileSync(bundlePath, 'console.log("bugsee-fixture")\n');
    writeJson(mapPath, { version: 3, mappings: 'AAAA' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Writes `mark` into the staged bundle and `map` over the staged map.
  function fakeCli(mark, map, exit = 0) {
    const cliPath = path.join(dir, 'cli.js');
    fs.writeFileSync(
      cliPath,
      `const fs = require('fs');
const path = require('path');
const bundle = process.argv[process.argv.length - 1];
fs.appendFileSync(bundle, ${JSON.stringify(mark)});
fs.writeFileSync(path.join(path.dirname(bundle), 'composed.js.map'), ${JSON.stringify(JSON.stringify(map))});
process.stdout.write('cli out');
process.exit(${exit});
`,
    );
    return cliPath;
  }

  const ID = '54410e32-2841-50e9-a70f-714cec4148b5';

  it('refuses a map whose ids do not both match the bundle', () => {
    for (const map of [{}, { debug_id: ID }, { debugId: ID }, { debug_id: ID, debugId: 'other' }]) {
      expect(() =>
        injectComposedSourceMap({ bundlePath, composedMapPath: mapPath, cliPath: fakeCli(`//# debugId=${ID}\n`, map) }),
      ).toThrow('composed map debug id does not match the bundle');
      expect(fs.readFileSync(bundlePath, 'utf8')).toBe('console.log("bugsee-fixture")\n');
      expect(JSON.parse(fs.readFileSync(mapPath, 'utf8'))).toEqual({ version: 3, mappings: 'AAAA' });
    }
    expect(
      injectComposedSourceMap({
        bundlePath,
        composedMapPath: mapPath,
        cliPath: fakeCli(`//# debugId=${ID}\n`, { debug_id: ID, debugId: ID }),
      }),
    ).toEqual({ debugId: ID });
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(
      `console.log("bugsee-fixture")\n//# sourceMappingURL=composed.js.map\n//# debugId=${ID}\n`,
    );
  });

  it('reports a failing CLI with its output and removes its staging directory', () => {
    const made = [];
    const real = fs.mkdtempSync;
    const spy = jest.spyOn(fs, 'mkdtempSync').mockImplementation((prefix) => {
      const out = real(prefix);
      made.push(out);
      return out;
    });
    try {
      expect(() =>
        injectComposedSourceMap({ bundlePath, composedMapPath: mapPath, cliPath: fakeCli('', {}, 4) }),
      ).toThrow('bugsee-cli sourcemaps inject exited 4: cli out');
    } finally {
      spy.mockRestore();
    }
    expect(made).toHaveLength(1);
    expect(path.basename(made[0])).toMatch(/^bugsee-sourcemaps-/);
    expect(fs.existsSync(made[0])).toBe(false);
  });
});

describe('recompile and compose failures', () => {
  let dir;
  let base;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-recompile-'));
    const bundlePath = path.join(dir, 'index.android.bundle.bugsee-js-source');
    fs.writeFileSync(bundlePath, 'console.log("bugsee-fixture")\n');
    const composedMapPath = path.join(dir, 'composed.map');
    writeJson(composedMapPath, { version: 3, mappings: 'AAAA' });
    base = {
      bundlePath,
      bytecodePath: path.join(dir, 'index.android.bundle'),
      composedMapPath,
      intermediateMapPath: path.join(dir, 'compiler.map'),
      packagerMapPath: path.join(dir, 'packager.map'),
      hermesArgs: ['-O', '-output-source-map'],
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function script(name, body) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
    return file;
  }

  it('names hermesc and its output when it fails, and only the output stream it has', () => {
    const reset = () => fs.writeFileSync(base.bundlePath, 'console.log("bugsee-fixture")\n');
    const both = script('hermesc-both', '#!/bin/sh\necho "  out text  "\necho "  err text  " >&2\nexit 2\n');
    expect(() => finishAfterCompose({ ...base, hermesc: both })).toThrow(/^hermesc exited 2: err text$/);
    reset();
    const outOnly = script('hermesc-out', '#!/bin/sh\necho "  out text  "\nexit 2\n');
    expect(() => finishAfterCompose({ ...base, hermesc: outOnly })).toThrow(/^hermesc exited 2: out text$/);
    reset();
    const blank = script('hermesc-blank', '#!/bin/sh\nexit 3\n');
    expect(() => finishAfterCompose({ ...base, hermesc: blank })).toThrow(/^hermesc exited 3$/);
  });

  it('passes exactly the Hermes args it was given, then removes its staging directory', () => {
    const log = path.join(dir, 'args');
    const hermesc = script(
      'hermesc',
      `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}"\nprev=""\nfor a in "$@"; do if [ "$prev" = "-out" ]; then out="$a"; fi; prev="$a"; done\ncp "${base.bundlePath}" "$out"\necho '{"version":3,"mappings":"BBBB"}' > "$out.map"\n`,
    );
    const made = [];
    const real = fs.mkdtempSync;
    const spy = jest.spyOn(fs, 'mkdtempSync').mockImplementation((prefix) => {
      const out = real(prefix);
      made.push(out);
      return out;
    });
    try {
      finishAfterCompose({ ...base, hermesc, composeScript: undefined });
    } finally {
      spy.mockRestore();
    }
    const args = fs.readFileSync(log, 'utf8').trim().split(' ');
    expect(args.slice(0, 5)).toEqual(['-w', '-emit-binary', '-max-diagnostic-width=80', '-O', '-output-source-map']);
    expect(args[5]).toBe('-out');
    expect(args[7]).toBe(base.bundlePath);
    expect(args).toHaveLength(8);
    expect(made.map((m) => path.basename(m).replace(/[^-]+$/, ''))).toEqual(['bugsee-sourcemaps-', 'bugsee-hermesc-']);
    for (const m of made) expect(fs.existsSync(m)).toBe(false);
  });

  it('names compose-source-maps.js when the second compose fails', () => {
    const hermesc = script(
      'hermesc',
      `#!/bin/sh\nprev=""\nfor a in "$@"; do if [ "$prev" = "-out" ]; then out="$a"; fi; prev="$a"; done\ncp "${base.bundlePath}" "$out"\necho '{}' > "$out.map"\n`,
    );
    const composeScript = path.join(dir, 'compose.js');
    fs.writeFileSync(composeScript, "process.stderr.write('bad maps'); process.exit(5);\n");
    expect(() => finishAfterCompose({ ...base, hermesc, composeScript })).toThrow(
      'compose-source-maps.js exited 5: bad maps',
    );
  });

  it('refuses to recompile without hermesc', () => {
    expect(() => finishAfterCompose(base)).toThrow(
      'hermesc not found; the debug-id stub would not be in the bytecode',
    );
    expect(fs.existsSync(base.bundlePath)).toBe(false);
  });

  it('reads the hermesc sidecar from the preserve directory first, then beside the bundle', () => {
    const assets = path.join(dir, 'build/generated/assets/r');
    const preserve = path.join(dir, 'build/intermediates/bugsee-sourcemaps/r');
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(preserve, { recursive: true });
    const bytecodePath = path.join(assets, 'index.android.bundle');
    const log = path.join(dir, 'which');
    const hermescFor = (name) =>
      script(
        name,
        `#!/bin/sh\necho ${name} > "${log}"\nprev=""\nfor a in "$@"; do if [ "$prev" = "-out" ]; then out="$a"; fi; prev="$a"; done\ncp "${base.bundlePath}" "$out"\necho '{}' > "$out.map"\n`,
      );
    const run = () => {
      fs.writeFileSync(base.bundlePath, 'console.log("bugsee-fixture")\n');
      writeJson(base.composedMapPath, { version: 3, mappings: 'AAAA' });
      finishAfterCompose({ ...base, bytecodePath });
      return fs.readFileSync(log, 'utf8').trim();
    };
    // Only beside the bundle (an older layout).
    fs.writeFileSync(path.join(assets, 'index.android.bundle.bugsee-hermesc'), hermescFor('beside'));
    expect(run()).toBe('beside');
    // An empty note in the preserve directory falls through to the next one.
    fs.writeFileSync(path.join(preserve, 'index.android.bundle.bugsee-hermesc'), '  \n');
    fs.writeFileSync(path.join(assets, 'index.android.bundle.bugsee-hermesc'), hermescFor('beside'));
    expect(run()).toBe('beside');
    fs.writeFileSync(path.join(preserve, 'index.android.bundle.bugsee-hermesc'), hermescFor('preserve'));
    fs.writeFileSync(path.join(assets, 'index.android.bundle.bugsee-hermesc'), hermescFor('beside'));
    expect(run()).toBe('preserve');
    expect(fs.readdirSync(preserve)).toEqual([]);
  });
});

describe('command line', () => {
  let dir;
  let written;
  let stderr;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-cli-entry-'));
    written = [];
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inject stamps the bundle and the map it is given', () => {
    const bundle = path.join(dir, 'main.jsbundle');
    const map = path.join(dir, 'main.map');
    fs.writeFileSync(bundle, 'console.log("bugsee-fixture")\n');
    writeJson(map, { version: 3, sources: ['a.js'], names: [], mappings: 'AAAA' });
    main(['inject', '--bundle', bundle, '--composed', map]);
    const id = debugIdOf(fs.readFileSync(bundle, 'utf8'));
    expect(JSON.parse(fs.readFileSync(map, 'utf8')).debug_id).toBe(id);
    expect(written).toEqual([]);
  });

  it('turns a failure into its message and exit code 1', () => {
    const saved = process.exitCode;
    try {
      cli(['inject', '--bundle', path.join(dir, 'missing.js'), '--composed', path.join(dir, 'missing.map')]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
    expect(written.join('')).toMatch(/^ENOENT: .*missing\.js.*\n$/);
  });

  it('exits 1 when run as a script with a failing command', () => {
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'hermes-sourcemaps.js'), 'bogus'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('usage: hermes-sourcemaps.js inject|finish|upload [options]\n');
  });
});

describe('preserve directory paths', () => {
  it('maps generated/assets to intermediates/bugsee-sourcemaps with the platform separator', () => {
    expect(
      preserveDirFor(
        'C:\\app\\android\\app\\build\\generated\\assets\\react\\release\\index.android.bundle',
        path.win32,
      ),
    ).toBe('C:\\app\\android\\app\\build\\intermediates\\bugsee-sourcemaps\\react\\release');
    expect(
      preserveDirFor('/app/android/app/build/generated/assets/react/release/index.android.bundle', path.posix),
    ).toBe('/app/android/app/build/intermediates/bugsee-sourcemaps/react/release');
    // Not under generated/assets: the bundle's own directory.
    expect(preserveDirFor('C:\\out\\main.jsbundle', path.win32)).toBe('C:\\out');
    // Defaults to this platform's path module.
    expect(preserveDirFor(path.join('b', 'generated', 'assets', 'x', 'f'))).toBe(
      path.join('b', 'intermediates', 'bugsee-sourcemaps', 'x'),
    );
  });

  it('takes the last generated/assets, as the Gradle hook does, when one sits above the build directory', () => {
    expect(
      preserveDirFor('/srv/generated/assets/app/android/app/build/generated/assets/react/release/index.android.bundle', path.posix),
    ).toBe('/srv/generated/assets/app/android/app/build/intermediates/bugsee-sourcemaps/react/release');
    // The bundle right in generated/assets has no <x> to map: its own directory, as in Gradle.
    expect(preserveDirFor('/b/generated/assets/index.android.bundle', path.posix)).toBe('/b/generated/assets');
  });

  it('the shell wrapper takes the last generated/assets too', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-preserve-dir-'));
    try {
      const assets = path.join(root, 'generated/assets/app/build/generated/assets/react/release');
      fs.mkdirSync(assets, { recursive: true });
      const packaged = path.join(assets, 'index.android.bundle');
      fs.writeFileSync(packaged, 'console.log("bugsee-fixture")\n');
      const hermesc = path.join(root, 'hermesc');
      fs.writeFileSync(hermesc, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hermesc, 0o755);
      const saved = cp.spawnSync(
        path.join(__dirname, '..', 'hermesc-preserve-js.sh'),
        ['-w', '-emit-binary', '-out', `${packaged}.hbc`, packaged],
        { env: { ...process.env, BUGSEE_REAL_HERMESC: hermesc }, encoding: 'utf8' },
      );
      expect(saved.status).toBe(0);
      const preserved = path.join(
        root,
        'generated/assets/app/build/intermediates/bugsee-sourcemaps/react/release/index.android.bundle.bugsee-js-source',
      );
      expect(fs.existsSync(preserved)).toBe(true);
      expect(fs.existsSync(path.join(root, 'intermediates'))).toBe(false);
      expect(preserveDirFor(packaged)).toBe(path.dirname(preserved));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
