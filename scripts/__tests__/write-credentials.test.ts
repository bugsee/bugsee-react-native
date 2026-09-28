import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * examples/bare/scripts/write-credentials.mjs, run against a scratch copy of
 * the app root (it resolves everything relative to its own location).
 *
 * The scenario half: an interrupted iOS e2e run can leave e2e-scenario.json
 * carrying `endpoint: DEAD_ENDPOINT`, and every later launch of the app --
 * by hand, not just by the e2e -- would then point the SDK at a closed port.
 */
const SCRIPT = join(__dirname, '..', '..', 'examples', 'bare', 'scripts', 'write-credentials.mjs');
const DEFAULT = { scenario: 'launch' };

function run(scenario?: unknown): unknown {
  const root = mkdtempSync(join(tmpdir(), 'write-credentials-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'write-credentials.mjs'));
    const file = join(root, 'e2e-scenario.json');
    if (scenario !== undefined) {
      writeFileSync(file, `${JSON.stringify(scenario)}\n`);
    }
    execFileSync(process.execPath, [join(root, 'scripts', 'write-credentials.mjs')], {
      env: { ...process.env, BUGSEE_TOKEN_IOS: 'ios-token', BUGSEE_TOKEN_ANDROID: '' },
      stdio: 'pipe',
    });
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('write-credentials and the e2e scenario file', () => {
  it('writes the default when the file is absent', () => {
    expect(run()).toEqual(DEFAULT);
  });

  it('resets a file an interrupted run left carrying an endpoint', () => {
    expect(run({ scenario: 'rh-live', nonce: 'abc123', endpoint: 'https://127.0.0.1:9' })).toEqual(DEFAULT);
  });

  it('leaves a scenario without an endpoint alone', () => {
    const scenario = { scenario: 'rh-live', nonce: 'abc123' };
    expect(run(scenario)).toEqual(scenario);
  });

  it('resets a file that is not valid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'write-credentials-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(SCRIPT, join(root, 'scripts', 'write-credentials.mjs'));
      writeFileSync(join(root, 'e2e-scenario.json'), '{"scenario":');
      execFileSync(process.execPath, [join(root, 'scripts', 'write-credentials.mjs')], {
        env: { ...process.env, BUGSEE_TOKEN_IOS: 'ios-token' },
        stdio: 'pipe',
      });
      expect(JSON.parse(readFileSync(join(root, 'e2e-scenario.json'), 'utf8'))).toEqual(DEFAULT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
