import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Expo loads plugin/build (app.plugin.js); every other test imports src. A
// fix made only in src would pass them all and ship the old build.
const pluginDir = join(__dirname, '..', '..');
const repoRoot = join(pluginDir, '..', '..', '..');

function emitted(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))
    .sort();
}

describe('committed plugin/build', () => {
  it('is what tsc emits from plugin/src today', () => {
    const out = mkdtempSync(join(tmpdir(), 'bugsee-plugin-build-'));
    try {
      const tsc = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'node_modules/typescript/lib/tsc.js'),
          '-p',
          join(pluginDir, 'tsconfig.json'),
          '--outDir',
          out,
        ],
        { encoding: 'utf8' },
      );
      expect(tsc.stdout + tsc.stderr).toBe('');
      expect(tsc.status).toBe(0);
      const committed = join(pluginDir, 'build');
      expect(emitted(committed)).toEqual(emitted(out));
      for (const name of emitted(out)) {
        expect([name, readFileSync(join(committed, name), 'utf8')]).toEqual([
          name,
          readFileSync(join(out, name), 'utf8'),
        ]);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
