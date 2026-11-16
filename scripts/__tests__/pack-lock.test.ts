import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The lock check-pack-install.sh takes around `npm pack`, run as real concurrent bash processes.
 *
 * It used to release with a bare `rmdir "$lock"` under `set -e`, which failed a run with "rmdir:
 * failed to remove '/tmp/bugsee-pack-install.lock.d': No such file or directory" whenever the lock
 * was already gone (the `pack install (0.82-0.86)` job failed that way on roughly one run in four),
 * and removed another run's lock if one had taken it. Release now checks ownership and is
 * idempotent.
 */
const lib = join(__dirname, '..', 'pack-lock.sh');
const script = join(__dirname, '..', 'check-pack-install.sh');

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `body` in a bash that has sourced the library, with `set -euo pipefail` as the real script has. */
function run(body: string, env: Record<string, string> = {}): Result {
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsource "${lib}"\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, PACK_LOCK_POLL: '0.02', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(body: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', `set -euo pipefail\nsource "${lib}"\n${body}`], {
      env: { ...process.env, PACK_LOCK_POLL: '0.01' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('pack-lock.sh', () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pack-lock-'));
    lock = join(dir, 'lock.d');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the lock, records its owner and removes it on release', () => {
    const result = run(`pack_lock_acquire "${lock}" 5
test -d "${lock}"
test -s "${lock}/owner"
pack_lock_release
test ! -e "${lock}"`);
    expect(result).toMatchObject({ status: 0, stderr: '' });
  });

  it('serializes real concurrent processes: no two are in the critical section together', async () => {
    const guard = join(dir, 'inside.d');
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const worker = (id: number) => `
      pack_lock_acquire "${lock}" 60
      if ! mkdir "${guard}" 2>/dev/null; then echo "OVERLAP ${id}" >> "${log}"; fi
      sleep 0.03
      rmdir "${guard}" 2>/dev/null || true
      echo "done ${id}" >> "${log}"
      pack_lock_release`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, id) => runAsync(worker(id))));
    expect(results.map((r) => r.status)).toEqual(results.map(() => 0));
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.filter((line) => line.startsWith('OVERLAP'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('done'))).toHaveLength(12);
    expect(existsSync(lock)).toBe(false);
  });

  it('does not fail the run when the lock has been removed while held', () => {
    // What the old `rmdir "$lock"` died on, under set -e.
    const result = run(`pack_lock_acquire "${lock}" 5
rm -rf "${lock}"
pack_lock_release
echo survived`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('survived');
    expect(result.stderr).toContain('was removed while it was held');
  });

  it('never removes a lock another run took after ours was lost', () => {
    const result = run(`pack_lock_acquire "${lock}" 5
rm -rf "${lock}"
mkdir "${lock}"
echo "someone-else" > "${lock}/owner"
pack_lock_release
test -d "${lock}"
test "$(cat "${lock}/owner")" = someone-else
echo intact`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('intact');
    expect(result.stderr).toContain('held by another run now');
  });

  it('is idempotent: a trap and an explicit release can both run', () => {
    const result = run(`trap 'pack_lock_release' EXIT
pack_lock_acquire "${lock}" 5
pack_lock_release
pack_lock_release
echo ok`);
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(existsSync(lock)).toBe(false);
  });

  it('does not release a lock it never took', () => {
    // Another run holds it; this one only released, never acquired.
    run(`mkdir "${lock}"; echo other > "${lock}/owner"`);
    const result = run('pack_lock_release; echo ok');
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(existsSync(lock)).toBe(true);
  });

  it('releases from the EXIT trap when the run dies while holding it', () => {
    const result = run(`trap 'pack_lock_release' EXIT
pack_lock_acquire "${lock}" 5
exit 3`);
    expect(result.status).toBe(3);
    expect(existsSync(lock)).toBe(false);
  });

  it('gives up after the wait, with the stale-lock message, and leaves the holder alone', () => {
    run(`mkdir "${lock}"; echo holder > "${lock}/owner"`);
    const result = run(`pack_lock_acquire "${lock}" 0.1 || echo "returned $?"`);
    expect(result.stdout).toContain('returned 1');
    expect(result.stderr).toContain(`FAIL: could not take ${lock} (stale lock? remove it)`);
    expect(readFileSync(join(lock, 'owner'), 'utf8').trim()).toBe('holder');
  });

  it('still tries once when the wait is shorter than one poll', () => {
    expect(run(`pack_lock_acquire "${lock}" 0 && echo got`).stdout).toContain('got');
  });

  it('does not write its token anywhere but the lock', () => {
    const result = run(`pack_lock_acquire "${lock}" 5
echo "$PACK_LOCK_TOKEN"
pack_lock_release`);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+$/);
  });
});

describe('check-pack-install.sh takes the lock through the library', () => {
  const source = readFileSync(script, 'utf8');

  it('releases only through pack_lock_release', () => {
    // The bare rmdir is what failed the run when the lock was already gone.
    expect(source).not.toMatch(/rmdir\s+"\$PACK_LOCK"/);
    expect(source).toContain('pack_lock_release');
  });

  it('releases from the EXIT trap as well as explicitly', () => {
    expect(source).toMatch(/trap 'pack_lock_release;[^']*' EXIT/);
    expect(source.match(/^pack_lock_release$/gm)).toHaveLength(1);
  });

  it('sources the library from the repo, not the working directory', () => {
    expect(source).toContain('source "$REPO/scripts/pack-lock.sh"');
  });
});
