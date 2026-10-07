'use strict';

// The react.hermesCommand wrapper (Task 13.7): the work is in
// hermesc-preserve-js.js, run in-process here so mutation testing sees it;
// the .sh and .cmd launchers are run (or, off Windows, read) at the end.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  bundleOf,
  findHermesc,
  hermescBin,
  isExecutableFile,
  isFile,
  outputOf,
  preserveDirOf,
  resolveFrom,
  run,
  spawnInherit,
} = require('../hermesc-preserve-js');
const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

const SCRIPTS = path.join(__dirname, '..');
const WIN = process.platform === 'win32';

/** A stand-in hermesc (POSIX shell) that writes `content` to its -out (nothing when null). */
function fakeHermesc(dir, content = 'HBC', status = 0) {
  const file = path.join(dir, 'hermesc');
  fs.writeFileSync(
    file,
    `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-out" ] && out="$a"; prev="$a"; done
${content === null ? '' : `printf '%s' '${content}' > "$out"`}
exit ${status}
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe('argument parsing', () => {
  it('takes the value after the last -out', () => {
    expect(outputOf(['-w', '-out', 'a.hbc', 'x.js', '-out', 'b.hbc'])).toBe('b.hbc');
    expect(outputOf(['-w', '-out', 'a.hbc', 'x.js'])).toBe('a.hbc');
    expect(outputOf(['x.js', '-out'])).toBeUndefined();
    // A trailing -out with nothing after it leaves the earlier value.
    expect(outputOf(['-out', 'a.hbc', '-out'])).toBe('a.hbc');
    expect(outputOf(['-emit-binary', 'x.js'])).toBeUndefined();
    expect(outputOf([])).toBeUndefined();
  });

  it('takes the first existing file that is neither a flag nor the output', () => {
    const files = new Set(['out.hbc', 'a.js', 'b.js', '-weird']);
    const isFile = (arg) => files.has(arg);
    expect(bundleOf(['-w', '-weird', '-out', 'out.hbc', 'missing.js', 'a.js', 'b.js'], 'out.hbc', isFile)).toBe('a.js');
    expect(bundleOf(['out.hbc', 'b.js'], 'out.hbc', isFile)).toBe('b.js');
    expect(bundleOf(['out.hbc'], undefined, isFile)).toBe('out.hbc');
    expect(bundleOf(['-w', 'missing.js'], undefined, isFile)).toBeUndefined();
  });

  it('names hermesc the way React Native does on each host', () => {
    expect(hermescBin('win32')).toEqual({ osbin: 'win64-bin', bin: 'hermesc.exe' });
    expect(hermescBin('linux')).toEqual({ osbin: 'linux64-bin', bin: 'hermesc' });
    expect(hermescBin('darwin')).toEqual({ osbin: 'osx-bin', bin: 'hermesc' });
    expect(hermescBin('freebsd')).toEqual({ osbin: 'osx-bin', bin: 'hermesc' });
  });
});

describe('findHermesc', () => {
  const cwd = path.join(path.sep, 'app');
  const rnDir = path.join(cwd, 'node_modules', 'react-native');
  const compilerDir = path.join(rnDir, 'node_modules', 'hermes-compiler');
  const compiled = path.join(compilerDir, 'hermesc', 'osx-bin', 'hermesc');
  const shipped = path.join(rnDir, 'sdks', 'hermesc', 'osx-bin', 'hermesc');
  const sibling = path.join(cwd, 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc');
  const built = path.join(cwd, 'node_modules', 'react-native', 'sdks', 'hermes', 'build', 'bin', 'hermesc');

  /** resolve() that knows react-native from cwd and hermes-compiler from react-native only. */
  const resolver = ({ rn = true, compiler = true } = {}) => {
    const calls = [];
    const resolve = (request, from) => {
      calls.push([request, from]);
      if (request === 'react-native/package.json' && rn && from === cwd) return path.join(rnDir, 'package.json');
      if (request === 'hermes-compiler/package.json' && compiler && from === rnDir) {
        return path.join(compilerDir, 'package.json');
      }
      return null;
    };
    return { resolve, calls };
  };
  const find = (present, opts = {}, env = {}, platform = 'darwin') =>
    findHermesc({
      env,
      cwd,
      platform,
      isExecutable: (file) => present.includes(file),
      resolve: resolver(opts).resolve,
    });

  it('prefers an executable BUGSEE_REAL_HERMESC', () => {
    expect(find(['/x/hermesc', compiled], {}, { BUGSEE_REAL_HERMESC: '/x/hermesc' })).toBe('/x/hermesc');
  });

  it('ignores a BUGSEE_REAL_HERMESC that is not executable', () => {
    expect(find([compiled], {}, { BUGSEE_REAL_HERMESC: '/x/hermesc' })).toBe(compiled);
  });

  it('resolves hermes-compiler from the react-native package, then the shipped sdks/hermesc', () => {
    const { resolve, calls } = resolver();
    expect(
      findHermesc({ env: {}, cwd, platform: 'darwin', isExecutable: (f) => [compiled, shipped].includes(f), resolve }),
    ).toBe(compiled);
    expect(calls).toEqual([
      ['react-native/package.json', cwd],
      ['hermes-compiler/package.json', rnDir],
    ]);
    expect(find([shipped, sibling])).toBe(shipped);
    expect(find([shipped], { compiler: false })).toBe(shipped);
  });

  it('falls back to the app node_modules, hermes-compiler before a source build', () => {
    expect(find([sibling, built], { rn: false })).toBe(sibling);
    expect(find([built], { rn: false })).toBe(built);
    expect(find([sibling], { compiler: false })).toBe(sibling);
    expect(find([], { rn: false })).toBeNull();
    // Without react-native, the paths under it are never looked at.
    expect(find([compiled, shipped], { rn: false })).toBeNull();
  });

  it('takes the first candidate that exists, in order, and nothing else', () => {
    expect(find(['/anything'], { rn: false }, {}, 'darwin')).toBeNull();
    const all = findHermesc({ env: {}, cwd, platform: 'darwin', isExecutable: () => true, resolve: () => null });
    expect(all).toBe(sibling);
  });

  it('uses the Windows directory and file name on Windows', () => {
    const win = path.join(compilerDir, 'hermesc', 'win64-bin', 'hermesc.exe');
    expect(find([win, compiled], {}, {}, 'win32')).toBe(win);
  });

  it('resolves for real from the working directory', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-find-hermesc-'));
    try {
      const { osbin, bin } = hermescBin(process.platform);
      const rn = path.join(app, 'node_modules', 'react-native');
      const compiler = path.join(rn, 'node_modules', 'hermes-compiler');
      fs.mkdirSync(path.join(compiler, 'hermesc', osbin), { recursive: true });
      fs.writeFileSync(path.join(rn, 'package.json'), '{"name":"react-native"}\n');
      fs.writeFileSync(path.join(compiler, 'package.json'), '{"name":"hermes-compiler"}\n');
      const real = path.join(compiler, 'hermesc', osbin, bin);
      fs.writeFileSync(real, '');
      fs.chmodSync(real, 0o755);
      const found = findHermesc({ env: {}, cwd: app, platform: process.platform, isExecutable: fs.existsSync });
      // .native: Windows temp paths can come back in 8.3 short form.
      expect(fs.realpathSync.native(found)).toBe(fs.realpathSync.native(real));
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});

describe('file helpers', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-preserve-helpers-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolveFrom resolves from the given directory, or gives null', () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'package.json'), '{"name":"pkg"}');
    expect(fs.realpathSync.native(resolveFrom('pkg/package.json', dir))).toBe(
      fs.realpathSync.native(path.join(dir, 'node_modules', 'pkg', 'package.json')),
    );
    expect(resolveFrom('no-such-package-for-bugsee-tests/package.json', dir)).toBeNull();
  });

  it('isFile and isExecutableFile say false, not undefined, for what is not there', () => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    expect(isFile(file)).toBe(true);
    expect(isFile(dir)).toBe(false);
    expect(isFile(path.join(dir, 'missing'))).toBe(false);
    expect(isExecutableFile(path.join(dir, 'missing'))).toBe(false);
    expect(isExecutableFile(dir)).toBe(false);
    if (!WIN) {
      expect(isExecutableFile(file)).toBe(false);
      fs.chmodSync(file, 0o755);
      expect(isExecutableFile(file)).toBe(true);
    }
  });

  it('spawnInherit runs in the given directory and hands hermesc the build log', () => {
    const result = spawnInherit(process.execPath, ['-e', 'process.exit(process.cwd() === process.argv[1] ? 7 : 8)', fs.realpathSync(dir)], fs.realpathSync(dir));
    expect(result.status).toBe(7);
    // Inherited streams are not captured.
    expect(result.stdout).toBeNull();
    expect(result.stderr).toBeNull();
  });
});

describe('preserveDirOf', () => {
  // Absolute on every host (a drive letter on Windows), as run() passes it.
  const root = path.resolve(path.sep, 'app');
  const build = path.join(root, 'android', 'app', 'build');
  const js = path.join(build, 'generated', 'assets', 'react', 'release', 'index.android.bundle');
  const jsDir = path.dirname(js);

  it('maps generated/assets to intermediates/bugsee-sourcemaps', () => {
    expect(preserveDirOf(js, {}, root)).toEqual({
      dir: path.join(build, 'intermediates', 'bugsee-sourcemaps', 'react', 'release'),
    });
  });

  it('refuses a bundle outside generated/assets', () => {
    const elsewhere = path.join(root, 'out', 'index.android.bundle');
    expect(preserveDirOf(elsewhere, {}, root)).toEqual({
      error: `refusing to write preserve files beside the bundle (${path.dirname(elsewhere)})`,
    });
  });

  it('takes BUGSEE_PRESERVE_DIR, relative to the working directory', () => {
    expect(preserveDirOf(js, { BUGSEE_PRESERVE_DIR: 'keep' }, build)).toEqual({ dir: path.join(build, 'keep') });
    // Beside the asset directory, not in it: a shared name prefix is fine.
    expect(preserveDirOf(js, { BUGSEE_PRESERVE_DIR: `${jsDir}-keep` }, root)).toEqual({ dir: `${jsDir}-keep` });
  });

  it('refuses a BUGSEE_PRESERVE_DIR in the packaged asset directory', () => {
    const error = { error: 'refusing to write preserve files into the packaged asset directory' };
    expect(preserveDirOf(js, { BUGSEE_PRESERVE_DIR: jsDir }, root)).toEqual(error);
    expect(preserveDirOf(js, { BUGSEE_PRESERVE_DIR: path.join(jsDir, 'sub') }, root)).toEqual(error);
  });
});

describe('run', () => {
  let dir;
  let assets;
  let js;
  let intermediates;
  let lines;
  const stderr = (line) => lines.push(line);
  const argv = () => ['-w', '-emit-binary', '-out', `${js}.hbc`, js, '-O', '-output-source-map'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-preserve-run-'));
    assets = path.join(dir, 'build', 'generated', 'assets', 'react', 'release');
    intermediates = path.join(dir, 'build', 'intermediates', 'bugsee-sourcemaps', 'react', 'release');
    fs.mkdirSync(assets, { recursive: true });
    js = path.join(assets, 'index.android.bundle');
    fs.writeFileSync(js, 'console.log("bundle")\n');
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A spawn stand-in that records its call and writes `content` to -out. */
  const spawnWriting = (content, result = { status: 0 }) => {
    const calls = [];
    const spawn = (file, args, cwd) => {
      calls.push({ file, args, cwd, staleGone: !fs.existsSync(`${js}.hbc`) });
      if (content !== null) fs.writeFileSync(args[args.indexOf('-out') + 1], content);
      return result;
    };
    return { spawn, calls };
  };

  it('preserves the JS, notes hermesc, runs it with the same arguments and exits 0', () => {
    fs.writeFileSync(`${js}.hbc`, 'stale');
    const { spawn, calls } = spawnWriting('HBC');
    const code = run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h/hermesc' }, cwd: dir, isExecutable: () => true, spawn, stderr });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    expect(calls).toEqual([{ file: '/h/hermesc', args: argv(), cwd: dir, staleGone: true }]);
    expect(fs.readFileSync(path.join(intermediates, 'index.android.bundle.bugsee-js-source'), 'utf8')).toBe(
      'console.log("bundle")\n',
    );
    expect(fs.readFileSync(path.join(intermediates, 'index.android.bundle.bugsee-hermesc'), 'utf8')).toBe('/h/hermesc\n');
    expect(fs.readdirSync(assets).sort()).toEqual(['index.android.bundle', 'index.android.bundle.hbc']);
  });

  it('reads relative arguments against the working directory, as React Native passes them on Windows', () => {
    const rel = path.relative(dir, js);
    const calls = [];
    const relArgv = ['-w', '-out', `${rel}.hbc`, rel];
    const write = (file, args, cwd) => {
      calls.push({ file, args, cwd });
      fs.writeFileSync(path.join(cwd, `${rel}.hbc`), 'HBC');
      return { status: 0 };
    };
    expect(run(relArgv, { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn: write, stderr })).toBe(0);
    expect(calls).toEqual([{ file: '/h', args: relArgv, cwd: dir }]);
    expect(fs.existsSync(path.join(intermediates, 'index.android.bundle.bugsee-js-source'))).toBe(true);
  });

  it('takes the host platform unless one is given', () => {
    const win = path.join(dir, 'node_modules', 'hermes-compiler', 'hermesc', 'win64-bin', 'hermesc.exe');
    const { spawn, calls } = spawnWriting('HBC');
    const deps = { env: {}, cwd: dir, isExecutable: (f) => f === win, resolve: () => null, spawn, stderr };
    expect(run(argv(), { ...deps, platform: 'win32' })).toBe(0);
    expect(calls.map((call) => call.file)).toEqual([win]);
    expect(run(argv(), deps)).toBe(WIN ? 0 : 1);
  });

  it('writes its failures to stderr by default', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(run(['-w'], { env: {}, cwd: dir })).toBe(1);
      expect(write).toHaveBeenCalledWith('bugsee: hermesc wrapper could not find the JS bundle\n');
    } finally {
      write.mockRestore();
    }
  });

  it('fails when hermesc exits 0 but writes no bytecode', () => {
    const { spawn } = spawnWriting(null);
    const code = run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h/hermesc' }, cwd: dir, isExecutable: () => true, spawn, stderr });
    expect(code).toBe(1);
    expect(lines).toEqual([`bugsee: hermesc exited 0 but wrote no bytecode to ${js}.hbc (/h/hermesc)\n`]);
  });

  it('fails when the bytecode is empty, or a stale file was all there was', () => {
    const { spawn } = spawnWriting('');
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn, stderr })).toBe(1);
    fs.writeFileSync(`${js}.hbc`, 'stale from an earlier run');
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn: spawnWriting(null).spawn, stderr })).toBe(1);
    expect(lines).toEqual([
      `bugsee: hermesc exited 0 but wrote no bytecode to ${js}.hbc (/h)\n`,
      `bugsee: hermesc exited 0 but wrote no bytecode to ${js}.hbc (/h)\n`,
    ]);
  });

  it('passes on hermesc\'s own exit code', () => {
    const { spawn } = spawnWriting('HBC', { status: 3 });
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn, stderr })).toBe(3);
    expect(lines).toEqual([]);
  });

  it('fails when hermesc is killed or cannot start', () => {
    const killed = spawnWriting(null, { status: null, signal: 'SIGKILL' }).spawn;
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn: killed, stderr })).toBe(1);
    const missing = () => ({ error: new Error('spawn /h ENOENT'), status: null });
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn: missing, stderr })).toBe(1);
    expect(lines).toEqual(['bugsee: hermesc was killed by SIGKILL (/h)\n', 'bugsee: hermesc failed to start (/h): spawn /h ENOENT\n']);
  });

  it('fails without running anything when no hermesc is found, after preserving the JS', () => {
    const { spawn, calls } = spawnWriting('HBC');
    const code = run(argv(), { env: {}, cwd: dir, isExecutable: () => false, resolve: () => null, spawn, stderr });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toEqual(['bugsee: hermesc binary not found\n']);
    expect(fs.existsSync(path.join(intermediates, 'index.android.bundle.bugsee-js-source'))).toBe(true);
    expect(fs.existsSync(path.join(intermediates, 'index.android.bundle.bugsee-hermesc'))).toBe(false);
  });

  it('fails when there is no bundle or no -out, and writes nothing', () => {
    const { spawn, calls } = spawnWriting('HBC');
    const deps = { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn, stderr };
    expect(run(['-w', '-out', `${js}.hbc`, path.join(dir, 'missing.js')], deps)).toBe(1);
    expect(run(['-w', js], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      'bugsee: hermesc wrapper could not find the JS bundle\n',
      'bugsee: hermesc wrapper was given no -out, so it cannot check that bytecode was written\n',
    ]);
    expect(fs.existsSync(path.join(dir, 'build', 'intermediates'))).toBe(false);
  });

  it('refuses a bundle outside generated/assets and writes nothing', () => {
    const other = path.join(dir, 'out', 'index.android.bundle');
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, 'js');
    const { spawn, calls } = spawnWriting('HBC');
    expect(
      run(['-out', `${other}.hbc`, other], { env: { BUGSEE_REAL_HERMESC: '/h' }, cwd: dir, isExecutable: () => true, spawn, stderr }),
    ).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toEqual([`bugsee: refusing to write preserve files beside the bundle (${path.dirname(other)})\n`]);
    expect(fs.readdirSync(path.dirname(other))).toEqual(['index.android.bundle']);
  });

  it('runs a real hermesc with the default helpers', () => {
    if (WIN) return; // the stand-in is a shell script; the launcher test covers Windows.
    const hermesc = fakeHermesc(dir);
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: hermesc }, cwd: dir, stderr })).toBe(0);
    expect(fs.readFileSync(`${js}.hbc`, 'utf8')).toBe('HBC');
    expect(fs.readFileSync(path.join(intermediates, 'index.android.bundle.bugsee-hermesc'), 'utf8')).toBe(`${hermesc}\n`);
  });

  it('runs a real hermesc in the working directory, with relative arguments', () => {
    if (WIN) return;
    const hermesc = fakeHermesc(dir);
    const rel = path.relative(dir, js);
    expect(run(['-w', '-out', `${rel}.hbc`, rel], { env: { BUGSEE_REAL_HERMESC: hermesc }, cwd: dir, stderr })).toBe(0);
    expect(fs.readFileSync(`${js}.hbc`, 'utf8')).toBe('HBC');
  });

  it('fails with the default helpers when a real hermesc writes nothing, or cannot start', () => {
    if (WIN) return;
    const silent = fakeHermesc(dir, null);
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: silent }, cwd: dir, stderr })).toBe(1);
    expect(lines).toEqual([`bugsee: hermesc exited 0 but wrote no bytecode to ${js}.hbc (${silent})\n`]);
    // Not executable: not taken, and nothing else is there.
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, '');
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: plain }, cwd: dir, stderr })).toBe(1);
    // A directory is not a hermesc either.
    expect(run(argv(), { env: { BUGSEE_REAL_HERMESC: dir }, cwd: dir, stderr })).toBe(1);
    expect(lines.slice(1)).toEqual(['bugsee: hermesc binary not found\n', 'bugsee: hermesc binary not found\n']);
  });
});

describe('launchers', () => {
  let dir;
  let js;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-preserve-launch-'));
    const assets = path.join(dir, 'build', 'generated', 'assets', 'react', 'release');
    fs.mkdirSync(assets, { recursive: true });
    js = path.join(assets, 'index.android.bundle');
    fs.writeFileSync(js, 'console.log("bundle")\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * As React Native runs it: on Windows `cmd /c <command> <hermesc arguments>`
   * (windowsAwareCommandLine), elsewhere the command itself.
   */
  const launch = (hermesc) => {
    const args = ['-w', '-emit-binary', '-out', `${js}.hbc`, js];
    const options = { cwd: dir, encoding: 'utf8', env: { ...process.env, BUGSEE_REAL_HERMESC: hermesc } };
    return WIN
      ? cp.spawnSync('cmd', ['/c', path.join(SCRIPTS, 'hermesc-preserve-js.cmd'), ...args], options)
      : cp.spawnSync(path.join(SCRIPTS, 'hermesc-preserve-js.sh'), args, options);
  };

  /** The repository's own hermesc: a script stand-in cannot be spawned on Windows without a shell. */
  const realHermesc = () =>
    findHermesc({ env: {}, cwd: path.join(SCRIPTS, '..'), platform: process.platform, isExecutable: fs.existsSync });

  it('compiles through the launcher for this host', () => {
    const result = launch(WIN ? realHermesc() : fakeHermesc(dir));
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(fs.statSync(`${js}.hbc`).size).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(dir, 'build', 'intermediates', 'bugsee-sourcemaps', 'react', 'release', 'index.android.bundle.bugsee-js-source')),
    ).toBe(true);
  });

  it('passes a failing hermesc exit code through the launcher', () => {
    if (WIN) {
      fs.writeFileSync(js, 'function (\n');
      const result = launch(realHermesc());
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(`${js}.hbc`)).toBe(false);
      return;
    }
    expect(launch(fakeHermesc(dir, 'HBC', 5)).status).toBe(5);
  });

  it('exits non-zero through the launcher when hermesc writes nothing', () => {
    if (WIN) return; // needs a stand-in hermesc; run() covers it on every host.
    const result = launch(fakeHermesc(dir, null));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bugsee: hermesc exited 0 but wrote no bytecode');
  });

  it('exits non-zero through the launcher when node cannot find the script\'s hermesc', () => {
    const result = launch(path.join(dir, 'no-such-hermesc'));
    // Falls back to the search from the scratch directory, which has no node_modules.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bugsee: hermesc binary not found');
  });

  it('ships a .cmd that runs the same script with every argument and keeps its exit code', () => {
    const text = fs.readFileSync(path.join(SCRIPTS, 'hermesc-preserve-js.cmd'), 'utf8');
    const lines = text.split('\r\n');
    // CRLF throughout (see .gitattributes), ending in one.
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines[0]).toBe('@echo off');
    expect(lines.filter((line) => !/^rem /.test(line) && line !== '')).toEqual([
      '@echo off',
      'node "%~dp0hermesc-preserve-js.js" %*',
      'exit /b %ERRORLEVEL%',
    ]);
  });

  it('ships an executable .sh that runs the same script', () => {
    const sh = path.join(SCRIPTS, 'hermesc-preserve-js.sh');
    expect(fs.readFileSync(sh, 'utf8')).toContain('exec node "$dir/hermesc-preserve-js.js" "$@"');
    if (!WIN) {
      expect(fs.statSync(sh).mode & 0o111).toBe(0o111);
    }
  });

  it('lists both launchers and the script in the published files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'scripts/hermesc-preserve-js.js',
        'scripts/hermesc-preserve-js.sh',
        'scripts/hermesc-preserve-js.cmd',
        'scripts/hermes-sourcemaps.js',
      ]),
    );
  });
});
