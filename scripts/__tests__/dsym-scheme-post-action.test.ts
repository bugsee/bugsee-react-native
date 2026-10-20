import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CLI_OUTPUT_FILTER, ENV_FILE_TOKEN, TOKEN_GUARD } from '../../packages/react-native/plugin/src/dsym-script';

// The shared scheme is what `xcodebuild -scheme BareExample` archives.
// A user-specific scheme under xcuserdata would not.
const schemePath = join(
  __dirname,
  '..',
  '..',
  'examples',
  'bare',
  'ios',
  'BareExample.xcodeproj',
  'xcshareddata',
  'xcschemes',
  'BareExample.xcscheme',
);

function decodeXml(value: string): string {
  return value
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function element(source: string, tag: string): string {
  const match = source.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`));
  if (!match) {
    throw new Error(`${tag} missing`);
  }
  return match[0];
}

function executionActions(archive: string): string[] {
  return archive.match(/<ExecutionAction\b[\s\S]*?<\/ExecutionAction>/g) ?? [];
}

function scriptOf(action: string): string {
  const match = action.match(/\bscriptText\s*=\s*"([^"]*)"/);
  const encoded = match?.[1];
  if (encoded === undefined) {
    throw new Error('ExecutionAction has no scriptText');
  }
  return decodeXml(encoded);
}

describe('BareExample archive scheme uploads dSYMs', () => {
  const scheme = readFileSync(schemePath, 'utf8');
  const archive = element(scheme, 'ArchiveAction');
  const action = executionActions(archive).find((block) =>
    /xcode post-action/.test(scriptOf(block)),
  );
  const script = action ? scriptOf(action) : '';

  // Archive's PATH has no node, and the npm shim is `#!/usr/bin/env node`.
  // The break is executing `.bin/bugsee-cli` directly, or wrapping the
  // command in with-environment.sh, which runs `"$1"` and drops the
  // subcommand. The native optional-dependency binary needs no node.
  it('runs the native bugsee-cli binary for xcode post-action', () => {
    expect(action).toBeDefined();
    expect(script).toMatch(/node_modules/);
    expect(script).toMatch(/@bugsee\/cli-darwin-arm64\/bin\/bugsee-cli/);
    expect(script).toMatch(/@bugsee\/cli-darwin-x64\/bin\/bugsee-cli/);
    expect(script).toMatch(/xcode post-action/);
    expect(script).not.toMatch(/\.bin\/bugsee-cli["']?\s+xcode post-action/);
    expect(script).not.toMatch(/with-environment\.sh/);
    expect(script).not.toMatch(/BugseeAgent/);
    expect(script).not.toMatch(/upload-dsyms/);
    // Shim fallback must be `node bugsee-cli.js xcode post-action`, not a shebang.
    expect(script).toMatch(
      /\$NODE_BINARY["']?\s+["']?[^"'\n]*bugsee-cli\.js["']?\s+xcode post-action/,
    );
    expect(script).toMatch(/find-node-for-xcode\.sh/);
  });

  // Setting either gate variable, or --force-foreground, changes when the
  // upload runs and whether a later failure can fail the signed archive.
  it('does not widen the archive gate', () => {
    expect(action).toBeDefined();
    expect(script).not.toMatch(/BUGSEE_BUILD_INFO_ALL_ACTIONS/);
    expect(script).not.toMatch(/BUGSEE_BUILD_INFO_ALL_CONFIGURATIONS/);
    expect(script).not.toMatch(/--force-foreground/);
  });

  // The CLI requires a token after the Archive+Release gate. The value comes
  // from the environment or the gitignored credentials file. A literal in
  // the scheme would ship the secret.
  it('supplies BUGSEE_APP_TOKEN from the environment or credentials.json', () => {
    expect(action).toBeDefined();
    // An empty export is Some("") to clap, which POSTs /apps//… instead of
    // reporting a missing token. Export only a non-empty value, same as endpoint.
    expect(script).not.toContain('${BUGSEE_APP_TOKEN:-$BUGSEE_TOKEN_IOS}');
    expect(script).toMatch(/BUGSEE_TOKEN_IOS/);
    expect(script).toMatch(
      /if \[ -n "\$TOKEN" \]; then\n\s+export BUGSEE_APP_TOKEN="\$TOKEN"\nfi/,
    );
    expect(script).toMatch(/credentials\.json/);
    expect(script).toMatch(/-extract ios\b/);
    expect(script).not.toMatch(/--app-token/);
    expect(script).not.toMatch(/BUGSEE_APP_TOKEN="[^$]/);
    expect(script).not.toMatch(/BUGSEE_APP_TOKEN='[^$]/);
    // A GUI Archive does not inherit the shell. An empty endpoint must stay
    // unset so the CLI keeps its own default, and the file's value must be
    // passed through unchanged.
    expect(script).toMatch(/-extract endpoint raw\b/);
    expect(script).toMatch(/\[\s*-z\s+"\$BUGSEE_ENDPOINT"\s*\]/);
    expect(script).toMatch(
      /if \[ -n "\$ENDPOINT" \]; then\n\s+export BUGSEE_ENDPOINT="\$ENDPOINT"\n\s+fi/,
    );
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toMatch(/\/v2/);
  });

  // Without "Provide build settings from" the app target, ARCHIVE_PATH is
  // empty and the CLI skips. The post-action is then present and does nothing.
  it('provides build settings from the BareExample target', () => {
    expect(action).toEqual(expect.any(String));
    expect(action).toMatch(
      /<EnvironmentBuildable>[\s\S]*BlueprintName\s*=\s*"BareExample"[\s\S]*<\/EnvironmentBuildable>/,
    );
  });
});

// F1 (campaign STAGING lane): the post-action ran `xcode post-action` with the
// placeholder token, which registers a build and uploads dSYMs to the
// configured endpoint -- or to production when none is set. The bundle phase
// and the Gradle hook already skipped it.
describe('BareExample archive post-action refuses a missing or placeholder token', () => {
  const scheme = readFileSync(schemePath, 'utf8');
  const archive = element(scheme, 'ArchiveAction');
  const action = executionActions(archive).find((block) => /xcode post-action/.test(scriptOf(block)));
  const script = action ? scriptOf(action) : '';

  it("carries the plugin's guard, after the token is resolved and before any bugsee-cli call", () => {
    const guard = TOKEN_GUARD.join('\n');
    const at = script.indexOf(guard);
    expect(at).toBeGreaterThan(script.indexOf('-extract ios raw'));
    expect(at).toBeLessThan(script.indexOf('export BUGSEE_APP_TOKEN'));
    expect(at).toBeLessThan(script.indexOf('xcode post-action'));
    expect(script.indexOf(guard, at + 1)).toBe(-1);
  });

  const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
  const SKIP_PLACEHOLDER = 'warning: bugsee: dSYM upload skipped: the app token is the placeholder\n';
  const SKIP_NONE = 'warning: bugsee: dSYM upload skipped: no app token is configured\n';
  const itDarwin = process.platform === 'darwin' ? it : it.skip;

  /**
   * Runs the scheme's script under /bin/sh in a scratch app whose every CLI
   * path (both native binaries, both install layouts, and the JS entry) is a
   * fake that records its argv and environment, and fails the test if it is
   * reached unexpectedly.
   */
  function runScheme(env: Record<string, string>, credentials?: object, failWith?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-scheme-guard-'));
    try {
      const seen = join(dir, 'cli-invoked');
      const okFake = `#!/bin/sh\nprintf 'argv=%s\\ntoken=%s\\nendpoint=%s\\n' "$*" "$BUGSEE_APP_TOKEN" "$BUGSEE_ENDPOINT" > '${seen}'\nexit 0\n`;
      const fake = failWith ? `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(failWith)} >&2\nexit 7\n` : okFake;
      const write = (file: string, text: string, mode = 0o644): void => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        chmodSync(file, mode);
      };
      for (const arch of ['arm64', 'x64']) {
        write(join(dir, `node_modules/@bugsee/cli-darwin-${arch}/bin/bugsee-cli`), fake, 0o755);
        write(join(dir, `node_modules/@bugsee/cli/node_modules/@bugsee/cli-darwin-${arch}/bin/bugsee-cli`), fake, 0o755);
      }
      write(
        join(dir, 'node_modules/@bugsee/cli/bin/bugsee-cli.js'),
        `require('fs').writeFileSync(${JSON.stringify(seen)}, 'argv=' + process.argv.slice(2).join(' ') + '\\ntoken=' + (process.env.BUGSEE_APP_TOKEN || '') + '\\nendpoint=' + (process.env.BUGSEE_ENDPOINT || '') + '\\n');\n`,
      );
      mkdirSync(join(dir, 'ios'));
      if (credentials) {
        writeFileSync(join(dir, 'credentials.json'), JSON.stringify(credentials));
      }
      const result = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', PROJECT_DIR: join(dir, 'ios'), NODE_BINARY: process.execPath, ...env },
      });
      return { ...result, invoked: existsSync(seen) ? readFileSync(seen, 'utf8') : null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ['the placeholder in BUGSEE_APP_TOKEN', { BUGSEE_APP_TOKEN: PLACEHOLDER }, SKIP_PLACEHOLDER],
    ['the placeholder in BUGSEE_TOKEN_IOS', { BUGSEE_TOKEN_IOS: PLACEHOLDER }, SKIP_PLACEHOLDER],
    ['the CI placeholder variant, upper case, without dashes', { BUGSEE_APP_TOKEN: '000000000000A000B000000000000000' }, SKIP_PLACEHOLDER],
    ['the placeholder padded with whitespace (the CLI trims it)', { BUGSEE_APP_TOKEN: ` ${PLACEHOLDER}\t` }, SKIP_PLACEHOLDER],
    ['whitespace only', { BUGSEE_APP_TOKEN: ' \t ' }, SKIP_NONE],
    ['no token anywhere', {}, SKIP_NONE],
  ])('%s: exit 0, one warning, bugsee-cli never runs', (_name, env, message) => {
    const result = runScheme({ BUGSEE_ENDPOINT: 'https://127.0.0.1:9', ...env });
    expect(result.invoked).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(message);
    expect(result.stderr).toBe('');
  });

  // The checked-in default: the placeholder and no endpoint, which would be
  // production. The test keeps a loopback BUGSEE_ENDPOINT only because
  // jest-no-network.js refuses any bugsee-cli spawn without one.
  itDarwin('the placeholder from credentials.json: bugsee-cli never runs', () => {
    const result = runScheme({ BUGSEE_ENDPOINT: 'https://127.0.0.1:9' }, { ios: PLACEHOLDER, android: PLACEHOLDER, endpoint: '' });
    expect(result.invoked).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(SKIP_PLACEHOLDER);
  });

  it('a real token still reaches bugsee-cli, in the environment and not in argv', () => {
    const token = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const result = runScheme({ BUGSEE_APP_TOKEN: token, BUGSEE_ENDPOINT: 'https://127.0.0.1:9' });
    expect(result.status).toBe(0);
    expect(result.invoked).toBe(`argv=xcode post-action\ntoken=${token}\nendpoint=https://127.0.0.1:9\n`);
  });

  // The README sends a bare app's token to ios/.xcode.env.local; a GUI Archive
  // has no shell environment, so the post-action reads the files itself.
  it("carries the plugin's .xcode.env token lookup, once, ahead of the guard", () => {
    const lookup = ENV_FILE_TOKEN.join('\n');
    const at = script.indexOf(lookup);
    expect(at).toBeGreaterThan(-1);
    expect(script.indexOf(lookup, at + 1)).toBe(-1);
    expect(at).toBeLessThan(script.indexOf(TOKEN_GUARD.join('\n')));
  });

  describe('a token in .xcode.env.local', () => {
    const token = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    function withEnvFile(text: string, env: Record<string, string> = {}) {
      // PROJECT_DIR is <dir>/ios; the files sit in it. runScheme makes the dir
      // itself, so the file is written through a shell prefix instead.
      const dir = mkdtempSync(join(tmpdir(), 'bugsee-envfile-'));
      try {
        const ios = join(dir, 'ios');
        mkdirSync(ios);
        writeFileSync(join(ios, '.xcode.env.local'), text);
        const seen = join(dir, 'seen');
        const cli = join(dir, 'node_modules/@bugsee/cli-darwin-arm64/bin/bugsee-cli');
        mkdirSync(dirname(cli), { recursive: true });
        writeFileSync(cli, `#!/bin/sh\nprintf 'token=%s\\n' "$BUGSEE_APP_TOKEN" > '${seen}'\n`);
        chmodSync(cli, 0o755);
        const x64 = join(dir, 'node_modules/@bugsee/cli-darwin-x64/bin/bugsee-cli');
        mkdirSync(dirname(x64), { recursive: true });
        writeFileSync(x64, readFileSync(cli));
        chmodSync(x64, 0o755);
        const result = spawnSync('/bin/sh', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', PROJECT_DIR: ios, NODE_BINARY: process.execPath, BUGSEE_ENDPOINT: 'https://127.0.0.1:9', ...env },
        });
        return { ...result, invoked: existsSync(seen) ? readFileSync(seen, 'utf8') : null };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('is used when the environment has none', () => {
      const result = withEnvFile(`export BUGSEE_APP_TOKEN=${token}\n`);
      expect(result.stdout).toBe('');
      expect(result.invoked).toBe(`token=${token}\n`);
    });

    it('accepts BUGSEE_TOKEN_IOS too', () => {
      expect(withEnvFile(`export BUGSEE_TOKEN_IOS=${token}\n`).invoked).toBe(`token=${token}\n`);
    });

    it('does not override a token the environment already has', () => {
      const real = '11111111-2222-4333-8444-555555555555';
      expect(withEnvFile(`export BUGSEE_APP_TOKEN=${token}\n`, { BUGSEE_APP_TOKEN: real }).invoked).toBe(`token=${real}\n`);
    });

    it('still skips for the placeholder', () => {
      const result = withEnvFile(`export BUGSEE_APP_TOKEN=${PLACEHOLDER}\n`);
      expect(result.invoked).toBeNull();
      expect(result.stdout).toBe(SKIP_PLACEHOLDER);
    });

    it('survives a file with a syntax error or an exit, and one that sets a bad NODE_BINARY or endpoint', () => {
      for (const bad of ['if [[ -n x ]]; then\n', 'exit 5\n', 'export BUGSEE_ENDPOINT=https://elsewhere.invalid\n']) {
        const result = withEnvFile(`${bad}export BUGSEE_APP_TOKEN=${token}\n`);
        // Statements after a bad one may not run; the script must still finish.
        expect([0]).toContain(result.status);
      }
      const result = withEnvFile('export BUGSEE_ENDPOINT=https://elsewhere.invalid\nexport BUGSEE_APP_TOKEN=' + token + '\n');
      expect(result.invoked).toBe(`token=${token}\n`);
    });

    it("keeps Xcode's executable NODE_BINARY over the file's", () => {
      const result = withEnvFile(`export BUGSEE_APP_TOKEN=${token}\nexport NODE_BINARY=/nonexistent/node\n`);
      expect(result.invoked).toBe(`token=${token}\n`);
    });
  });

  it('a token one digit off the placeholder is not taken for it', () => {
    const result = runScheme({ BUGSEE_APP_TOKEN: '00000000-0000-4000-8000-000000000001', BUGSEE_ENDPOINT: 'https://127.0.0.1:9' });
    expect(result.invoked).toMatch(/^argv=xcode post-action\n/);
  });

  // F12: Xcode reads any `error:` line as a build error. The post-action's
  // output is not parsed for diagnostics, but it relays the CLI the same way
  // the bundle phase does, so a failed upload reads as a warning here too.
  it("carries the plugin's CLI output filter, ahead of every bugsee-cli call", () => {
    const filter = CLI_OUTPUT_FILTER.join('\n');
    const at = script.indexOf(filter);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(script.indexOf('xcode post-action'));
    expect(script).not.toMatch(/^\s*"\$1" xcode post-action/m);
  });

  it('a failed upload reads as a warning and keeps the CLI exit status', () => {
    const result = runScheme(
      { BUGSEE_APP_TOKEN: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', BUGSEE_ENDPOINT: 'https://127.0.0.1:9' },
      undefined,
      'error: upload failed: symbol metadata POST: connection refused',
    );
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('warning: bugsee: upload failed: symbol metadata POST: connection refused');
    expect(out).not.toMatch(/^\s*(.*: )?(fatal )?error:/im);
    expect(result.status).toBe(7);
  });
});

describe('CLI output filter', () => {
  function filter(lines: string[]): string {
    const script = [...CLI_OUTPUT_FILTER, 'run_cli sh -c "$CLI_SCRIPT"', 'exit $?'].join('\n');
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', CLI_SCRIPT: `printf '%s\\n' ${lines.map((l) => JSON.stringify(l)).join(' ')}; exit 3` },
    });
    expect(result.status).toBe(3);
    return result.stdout;
  }

  it.each([
    ['error: upload failed: x', 'warning: bugsee: upload failed: x'],
    ['fatal error: boom', 'warning: bugsee: boom'],
    ['/a/b.js:1:2: error: bad', 'warning: bugsee: bad'],
    ['bugsee: error: bad', 'warning: bugsee: bad'],
    ['Error: capitalised', 'warning: bugsee: capitalised'],
  ])('rewrites %j', (line, expected) => {
    expect(filter([line])).toBe(`${expected}\n`);
  });

  it('leaves other lines alone and prints nothing for no output', () => {
    expect(filter(['uploaded 3 files', 'warning: slow', 'an error occurred'])).toBe(
      'uploaded 3 files\nwarning: slow\nan error occurred\n',
    );
    const script = [...CLI_OUTPUT_FILTER, 'run_cli true', 'echo rc=$?'].join('\n');
    const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(r.stdout).toBe('rc=0\n');
  });
});
