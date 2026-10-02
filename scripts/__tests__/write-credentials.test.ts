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

  function generate(overrides: NodeJS.ProcessEnv): { output: string; props: string } {
    const root = mkdtempSync(join(tmpdir(), 'write-credentials-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(SCRIPT, join(root, 'scripts', 'write-credentials.mjs'));
      // Drop a shell endpoint unless this case sets one, so a real
      // BUGSEE_ENDPOINT cannot leak into the generated file or the output.
      const env: NodeJS.ProcessEnv = { ...process.env, BUGSEE_TOKEN_IOS: '', ...overrides };
      if (!Object.hasOwn(overrides, 'BUGSEE_ENDPOINT')) {
        delete env.BUGSEE_ENDPOINT;
      }
      const output = execFileSync(process.execPath, [join(root, 'scripts', 'write-credentials.mjs')], {
        env,
        encoding: 'utf8',
      });
      const props = readFileSync(join(root, 'android', 'bugsee.properties'), 'utf8');
      return { output, props };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('writes app_token and enables NDK symbol upload for React Native', () => {
    const androidToken = 'fake-android-token';
    const { output, props } = generate({ BUGSEE_TOKEN_ANDROID: androidToken });
    const lines = props.split('\n');
    const tokenLine = lines.find((line) => line.startsWith('app_token='));
    expect(tokenLine !== undefined).toBe(true);
    expect(tokenLine === `app_token=${androidToken}`).toBe(true);
    expect(lines.includes('plugin.ndk.enabled=true')).toBe(true);
    expect(props.includes('plugin.appToken')).toBe(false);
    expect(lines.some((line) => line.startsWith('plugin.endpoint='))).toBe(false);
    expect(output.includes(androidToken)).toBe(false);
  });

  it('writes plugin.endpoint when an endpoint is set, and does not append /v2', () => {
    const androidToken = 'fake-android-token';
    const endpoint = 'https://endpoint.example';
    const { output, props } = generate({
      BUGSEE_TOKEN_IOS: '',
      BUGSEE_TOKEN_ANDROID: androidToken,
      BUGSEE_ENDPOINT: endpoint,
    });
    const lines = props.split('\n');
    expect(lines.includes(`plugin.endpoint=${endpoint}`)).toBe(true);
    expect(lines.some((line) => line.startsWith('plugin.endpoint=') && line.endsWith('/v2'))).toBe(false);
    expect(output.includes(androidToken)).toBe(false);
    expect(output.includes(endpoint)).toBe(false);
  });
});
