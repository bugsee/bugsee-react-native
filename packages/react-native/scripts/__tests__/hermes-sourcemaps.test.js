'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cp = require('node:child_process');
const { finishAfterCompose, uploadArgv } = require('../hermes-sourcemaps');

const UPLOAD = ['debug-files', 'upload', '--type', 'sourcemaps'];

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
    expect(result.uploadArgv.slice(0, UPLOAD.length)).toEqual(UPLOAD);
    expect(result.uploadArgv).toEqual(uploadArgv(composedPath));

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
    expect(result.uploadArgv.slice(0, UPLOAD.length)).toEqual(UPLOAD);
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
  });
});
