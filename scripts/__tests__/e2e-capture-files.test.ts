import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureEvents, parseBundle } from '../../examples/bare/e2e/bundles';

/**
 * The device e2e reads a retained bundle's capture files -- `log`,
 * `events.user`, `traces.user` -- by the `type` its manifest gives them, so
 * a test asserts on what the SDK wrote rather than on a file name it guessed.
 */
describe('bundle capture files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-files-'));
    writeFileSync(join(dir, 'request.json'), '{}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(files: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files, attrs: {} }));
  }

  it('reads every JSON capture the manifest names, keyed by type', () => {
    const log = '{"version":1,"events":[{"level":3,"source":98,"message":"m"}]}';
    const events = '{"version":1,"events":[{"name":"e","params":{"int":3}}]}';
    const traces = '{"version":1,"events":[{"name":"t","value":true}]}';
    writeManifest([
      { type: 'log', filename: 'log.json' },
      { type: 'events.user', filename: 'events.user.json' },
      { type: 'traces.user', filename: 'traces.user.json' },
      { type: 'video', filename: 'video.mp4' },
    ]);
    writeFileSync(join(dir, 'log.json'), log);
    writeFileSync(join(dir, 'events.user.json'), events);
    writeFileSync(join(dir, 'traces.user.json'), traces);
    writeFileSync(join(dir, 'video.mp4'), 'not json');

    const bundle = parseBundle('x.bundle.zip', dir);

    expect([...bundle.captures.entries()].sort()).toEqual(
      [
        ['events.user', events],
        ['log', log],
        ['traces.user', traces],
      ].sort(),
    );
    // `log` is unchanged: the log capture's raw text, as before.
    expect(bundle.log).toBe(log);
    expect(captureEvents(bundle, 'events.user')).toEqual([{ name: 'e', params: { int: 3 } }]);
    expect(captureEvents(bundle, 'traces.user')).toEqual([{ name: 't', value: true }]);
    // The one non-JSON entry (`video.mp4`) lands in `binaries`, not `captures`,
    // as an absolute path -- `captures` is untouched by its presence.
    expect([...bundle.binaries.keys()]).toEqual(['video']);
    expect(bundle.binaries.get('video')).toEqual([join(dir, 'video.mp4')]);
    expect(bundle.captures.has('video')).toBe(false);
  });

  it('captureEvents is empty for a type the manifest lacks', () => {
    writeManifest([{ type: 'log', filename: 'log.json' }]);
    writeFileSync(join(dir, 'log.json'), '{"version":1,"events":[{"message":"m"}]}');

    const bundle = parseBundle('x.bundle.zip', dir);

    expect(bundle.captures.has('events.user')).toBe(false);
    expect(captureEvents(bundle, 'events.user')).toEqual([]);
  });

  it('a manifest entry whose file is missing is skipped', () => {
    writeManifest([
      { type: 'log', filename: 'log.json' },
      { type: 'traces.user', filename: 'traces.user.json' },
    ]);
    writeFileSync(join(dir, 'traces.user.json'), '{"version":1,"events":[{"name":"t","value":1}]}');

    const bundle = parseBundle('x.bundle.zip', dir);

    expect([...bundle.captures.keys()]).toEqual(['traces.user']);
    expect(bundle.log).toBeUndefined();
    expect(captureEvents(bundle, 'log')).toEqual([]);
  });

  describe('binaries', () => {
    it('groups non-JSON files by manifest type, as absolute paths in manifest order', () => {
      // Two `screenshot` entries (a real bundle's `type` a caller groups by,
      // not the per-file name it happens to be stored under) and one
      // `video`, interleaved with a JSON entry that must not appear here.
      writeManifest([
        { type: 'screenshot', filename: 'a.bgsfile' },
        { type: 'log', filename: 'log.json' },
        { type: 'video', filename: 'v.bgsfile' },
        { type: 'screenshot', filename: 'b.bgsfile' },
      ]);
      writeFileSync(join(dir, 'a.bgsfile'), 'shot-a');
      writeFileSync(join(dir, 'log.json'), '{"version":1,"events":[]}');
      writeFileSync(join(dir, 'v.bgsfile'), 'video-bytes');
      writeFileSync(join(dir, 'b.bgsfile'), 'shot-b');

      const bundle = parseBundle('x.bundle.zip', dir);

      // Keyed by type, not by file name or extension.
      expect([...bundle.binaries.keys()].sort()).toEqual(['screenshot', 'video']);
      // Absolute paths, and manifest order preserved within a type.
      expect(bundle.binaries.get('screenshot')).toEqual([
        join(dir, 'a.bgsfile'),
        join(dir, 'b.bgsfile'),
      ]);
      expect(bundle.binaries.get('video')).toEqual([join(dir, 'v.bgsfile')]);
      for (const paths of bundle.binaries.values()) {
        for (const path of paths) {
          expect(path.startsWith('/')).toBe(true);
        }
      }
      // The JSON entry is a capture, never a binary.
      expect(bundle.binaries.has('log')).toBe(false);
      expect(bundle.captures.has('screenshot')).toBe(false);
      expect(bundle.captures.has('video')).toBe(false);
    });

    it('a missing non-JSON file is skipped, like a missing capture', () => {
      writeManifest([
        { type: 'video', filename: 'present.bgsfile' },
        { type: 'video', filename: 'missing.bgsfile' },
      ]);
      writeFileSync(join(dir, 'present.bgsfile'), 'video-bytes');

      const bundle = parseBundle('x.bundle.zip', dir);

      expect(bundle.binaries.get('video')).toEqual([join(dir, 'present.bgsfile')]);
    });

    it('is empty when the manifest names no non-JSON file', () => {
      writeManifest([{ type: 'log', filename: 'log.json' }]);
      writeFileSync(join(dir, 'log.json'), '{"version":1,"events":[]}');

      const bundle = parseBundle('x.bundle.zip', dir);

      expect(bundle.binaries.size).toBe(0);
    });
  });
});
