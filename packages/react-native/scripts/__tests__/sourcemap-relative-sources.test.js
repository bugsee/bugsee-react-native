'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { relativizeSource, relativizeSourceMap, uploadComposedSourceMap } = require('../hermes-sourcemaps');

// Synthetic, UUID-shaped, never a real app.
const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0002';
const ROOT = '/build/machine/app';

// Symlinks need a POSIX filesystem; Windows resolves paths lexically here and a runner may refuse to create one.
(process.platform === 'win32' ? describe.skip : describe)('relativizeSource through a symlinked project root', () => {
  // macOS: Xcode reports the project under /tmp while Metro writes the real
  // /private/tmp path into the map, so a plain relative() gave
  // `../../../private/tmp/<build dir>/scenarios/a.ts`, the build machine's layout.
  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');
  let base;
  let realRoot;
  let linkRoot;
  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bugsee-symroot-')));
    realRoot = nodePath.join(base, 'real', 'app');
    fs.mkdirSync(nodePath.join(realRoot, 'scenarios'), { recursive: true });
    fs.mkdirSync(nodePath.join(base, 'real', 'packages', 'x'), { recursive: true });
    fs.writeFileSync(nodePath.join(realRoot, 'scenarios', 'a.ts'), '');
    fs.symlinkSync(nodePath.join(base, 'real'), nodePath.join(base, 'link'));
    linkRoot = nodePath.join(base, 'link', 'app');
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('a source under the real path is in the root when the root is given through the link', () => {
    expect(relativizeSource(`${realRoot}/scenarios/a.ts`, linkRoot)).toBe('/scenarios/a.ts');
  });

  it('a source given through the link is in the root when the root is the real path', () => {
    expect(relativizeSource(`${linkRoot}/scenarios/a.ts`, realRoot)).toBe('/scenarios/a.ts');
  });

  it('a file that does not exist is still resolved through its existing parent', () => {
    expect(relativizeSource(`${realRoot}/scenarios/missing.ts`, linkRoot)).toBe('/scenarios/missing.ts');
  });

  it('a source that reaches the root through an in-tree symlink keeps its in-tree form', () => {
    // A linked workspace package under node_modules: Metro may write either spelling.
    fs.symlinkSync(nodePath.join(base, 'real', 'packages', 'x'), nodePath.join(realRoot, 'linked-pkg'));
    expect(relativizeSource(`${realRoot}/linked-pkg/a.js`, realRoot)).toBe('/linked-pkg/a.js');
    // Root given through a symlink as well: the plain paths escape the root, so real paths
    // are compared and the package's real location comes out, still without the build layout.
    expect(relativizeSource(`${realRoot}/linked-pkg/a.js`, linkRoot)).toBe('../packages/x/a.js');
  });

  it('one map resolves the root once, however many sources it has', () => {
    const spy = jest.spyOn(fs, 'realpathSync');
    try {
      const sources = Array.from({ length: 50 }, (_, i) => `${realRoot}/scenarios/file${i}.ts`);
      const text = JSON.stringify({ version: 3, sources, mappings: '' });
      const out = JSON.parse(relativizeSourceMap(text, linkRoot));
      expect(out.sources.every((source, i) => source === `/scenarios/file${i}.ts`)).toBe(true);
      // One lookup per file (it may itself be a symlink) plus the root and its
      // directories once each, not the root again for every entry (2 x 50 or more).
      expect(spy.mock.calls.length).toBeLessThanOrEqual(50 + 3);
    } finally {
      spy.mockRestore();
    }
  });

  it('an outside-root file that is itself a symlink to a file inside the root maps to the in-root path', () => {
    fs.mkdirSync(nodePath.join(base, 'real', 'elsewhere'), { recursive: true });
    fs.symlinkSync(nodePath.join(realRoot, 'scenarios', 'a.ts'), nodePath.join(base, 'real', 'elsewhere', 'alias.ts'));
    expect(relativizeSource(`${base}/real/elsewhere/alias.ts`, linkRoot)).toBe('/scenarios/a.ts');
  });

  it('a missing file under several missing directories is resolved through its nearest existing parent', () => {
    expect(relativizeSource(`${realRoot}/newdir/sub/x.ts`, linkRoot)).toBe('/newdir/sub/x.ts');
  });

  it('missing directories below a symlink in the source are resolved through the existing parent of that link', () => {
    // The source goes through the link and the root is the real path: only walking up to
    // `link/app` (which exists) and resolving it gives the in-root form.
    expect(relativizeSource(`${linkRoot}/newdir/sub/x.ts`, realRoot)).toBe('/newdir/sub/x.ts');
  });

  it('terminates at the filesystem root when nothing can be resolved at all', () => {
    const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    try {
      expect(relativizeSource(`${realRoot}/newdir/sub/x.ts`, linkRoot)).toBe('../../real/app/newdir/sub/x.ts');
    } finally {
      spy.mockRestore();
    }
  });

  it('a source that is a link to the project root itself keeps its plain relative form', () => {
    fs.symlinkSync(realRoot, nodePath.join(base, 'real', 'rootlink'));
    expect(relativizeSource(`${base}/real/rootlink`, linkRoot)).toBe('../../real/rootlink');
  });

  it('a sibling package outside the root keeps its ../ form', () => {
    expect(relativizeSource(`${realRoot}/../packages/x/a.js`, linkRoot)).toBe('../packages/x/a.js');
  });
});

describe('relativizeSource', () => {
  it('makes an absolute path under the root project-relative with a leading slash', () => {
    expect(relativizeSource(`${ROOT}/scenarios/staging.ts`, ROOT)).toBe('/scenarios/staging.ts');
    expect(relativizeSource(`${ROOT}/node_modules/react-native/index.js`, `${ROOT}/`)).toBe(
      '/node_modules/react-native/index.js',
    );
  });

  it('keeps entries that are already relative', () => {
    expect(relativizeSource('src/app.js', ROOT)).toBe('src/app.js');
    expect(relativizeSource('./app.js', ROOT)).toBe('./app.js');
    expect(relativizeSource('webpack://x/app.js', ROOT)).toBe('webpack://x/app.js');
  });

  it('makes absolute paths outside the root ../-relative, including siblings that share a prefix', () => {
    expect(relativizeSource('/build/machine/packages/x/a.js', ROOT)).toBe('../packages/x/a.js');
    expect(relativizeSource(`${ROOT}-other/lib.js`, ROOT)).toBe('../app-other/lib.js');
    expect(relativizeSource('/elsewhere/lib.js', ROOT)).toBe('../../../elsewhere/lib.js');
  });

  it('does not mistake a colon inside a POSIX path for a drive', () => {
    expect(relativizeSource(`${ROOT}/a:b/c.ts`, ROOT)).toBe('/a:b/c.ts');
  });

  it('handles UNC paths', () => {
    expect(relativizeSource('\\\\host\\share\\app\\a.ts', '\\\\host\\share\\app')).toBe('/a.ts');
  });

  it('a Windows source outside the root stays ../-relative without touching this machine\'s filesystem', () => {
    expect(relativizeSource('C:\\build\\packages\\x\\a.js', 'C:\\build\\app')).toBe('../packages/x/a.js');
  });

  it('handles Windows paths', () => {
    expect(relativizeSource('C:\\proj\\app\\src\\a.ts', 'C:\\proj\\app')).toBe('/src/a.ts');
    expect(relativizeSource('D:\\other\\a.ts', 'C:\\proj\\app')).toBe('D:\\other\\a.ts');
  });

  it('returns a map whose sources need no change byte for byte, not re-serialized', () => {
    const pretty = '{\n  "version": 3,\n  "sources": ["src/app.js", "./b.js"],\n  "mappings": ""\n}\n';
    expect(relativizeSourceMap(pretty, ROOT)).toBe(pretty);
  });

  it('passes non-strings through', () => {
    expect(relativizeSource(null, ROOT)).toBeNull();
  });
});

describe('relativizeSourceMap', () => {
  it('returns the text itself when nothing changes, there is no root or no sources', () => {
    const text = JSON.stringify({ version: 3, sources: ['a.js', 'rel/b.js'], mappings: '' });
    expect(relativizeSourceMap(text, ROOT)).toBe(text);
    const absolute = JSON.stringify({ version: 3, sources: [`${ROOT}/a.js`] });
    expect(relativizeSourceMap(absolute, '')).toBe(absolute);
    expect(relativizeSourceMap(absolute, undefined)).toBe(absolute);
    const none = JSON.stringify({ version: 3 });
    expect(relativizeSourceMap(none, ROOT)).toBe(none);
  });

  it('rewrites sources and keeps every other field', () => {
    const map = {
      version: 3,
      sources: [`${ROOT}/a.ts`, 'b.ts', '/build/machine/c.ts'],
      names: ['n'],
      mappings: 'AAAA;CCCC',
      debug_id: 'id',
      debugId: 'id',
    };
    expect(JSON.parse(relativizeSourceMap(JSON.stringify(map), ROOT))).toEqual({
      ...map,
      sources: ['/a.ts', 'b.ts', '../c.ts'],
    });
  });
});

describe('uploadComposedSourceMap with a project root', () => {
  let dir;
  let captured;
  let cli;
  let stderr;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-relsrc-'));
    captured = path.join(dir, 'captured.json');
    cli = path.join(dir, 'fake-cli.js');
    // Copies the map argument (the last one) so the test can read what was uploaded.
    fs.writeFileSync(
      cli,
      `const fs = require('fs'); const p = process.argv[process.argv.length - 1];
fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ p, text: fs.readFileSync(p, 'utf8') }));`,
    );
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function upload(sources, projectRoot) {
    const mapPath = path.join(dir, 'main.jsbundle.composed.map');
    const original = JSON.stringify({ version: 3, sources, names: [], mappings: 'AAAA', debug_id: 'd', debugId: 'd' });
    fs.writeFileSync(mapPath, original);
    const result = uploadComposedSourceMap({
      composedMapPath: mapPath,
      token: TOKEN,
      appVersion: '1',
      appBuild: '1',
      cliPath: cli,
      projectRoot,
    });
    return { result, original, mapPath, seen: JSON.parse(fs.readFileSync(captured, 'utf8')) };
  }

  it('uploads project-relative sources under the same file name and leaves the map on disk alone', () => {
    const { result, original, mapPath, seen } = upload([`${ROOT}/scenarios/staging.ts`, 'rel.ts'], ROOT);
    expect(result.status).toBe('uploaded');
    expect(JSON.parse(seen.text).sources).toEqual(['/scenarios/staging.ts', 'rel.ts']);
    expect(JSON.parse(seen.text).mappings).toBe('AAAA');
    expect(JSON.parse(seen.text).debug_id).toBe('d');
    expect(path.basename(seen.p)).toBe('main.jsbundle.composed.map');
    expect(seen.p).not.toBe(mapPath);
    expect(fs.readFileSync(mapPath, 'utf8')).toBe(original);
    expect(fs.existsSync(seen.p)).toBe(false);
  });

  it('uploads the original file when nothing needs rewriting', () => {
    const { seen, mapPath } = upload(['rel.ts'], ROOT);
    expect(seen.p).toBe(mapPath);
  });

  it('uploads the original file when no root is given', () => {
    const { seen, mapPath } = upload([`${ROOT}/a.ts`], undefined);
    expect(seen.p).toBe(mapPath);
  });
});
