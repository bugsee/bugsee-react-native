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
});
