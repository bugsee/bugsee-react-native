import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractZip } from '../../examples/bare/e2e/bundles';

/**
 * The device e2e's own zip reader (the iOS SDK stores bundle entries with
 * zstd, which neither `unzip` nor `bsdtar` reads). A bundle with a nested
 * entry -- `dir/file` -- must land in `dir/`, and the directory entry `dir/`
 * itself is not a file to write.
 */
describe('extractZip', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'extract-zip-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function zipOf(files: Record<string, string>): Buffer {
    const src = join(work, 'src');
    for (const [name, text] of Object.entries(files)) {
      const path = join(src, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    const zip = join(work, 'in.zip');
    // -r records directory entries (`logs/`, `logs/deep/`) as well as files.
    execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: src });
    return readFileSync(zip);
  }

  it('extracts nested entries into their directories, skipping directory entries', () => {
    const zip = zipOf({
      'request.json': '{"type":"bug"}',
      'logs/log.json': 'top',
      'logs/deep/log.internal.json': 'deep',
    });
    const out = join(work, 'out');
    mkdirSync(out);

    extractZip(zip, out);

    expect(readFileSync(join(out, 'request.json'), 'utf8')).toBe('{"type":"bug"}');
    expect(readFileSync(join(out, 'logs', 'log.json'), 'utf8')).toBe('top');
    expect(readFileSync(join(out, 'logs', 'deep', 'log.internal.json'), 'utf8')).toBe('deep');
  });

  it('still refuses an entry that escapes the target directory', () => {
    const zip = zipOf({ 'a.txt': 'x' });
    // Rewrite the one name, in the local header and the central directory,
    // to `../a.tx` (same length).
    const patched = Buffer.from(zip.toString('latin1').split('a.txt').join('../a.'), 'latin1');
    const out = join(work, 'out');
    mkdirSync(out);

    expect(() => extractZip(patched, out)).toThrow(/refusing entry path/);
  });
});
