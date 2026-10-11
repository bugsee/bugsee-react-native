import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TOKEN_GUARD } from '../../packages/react-native/plugin/src/dsym-script';

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
  function runScheme(env: Record<string, string>, credentials?: object) {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-scheme-guard-'));
    try {
      const seen = join(dir, 'cli-invoked');
      const fake = `#!/bin/sh\nprintf 'argv=%s\\ntoken=%s\\nendpoint=%s\\n' "$*" "$BUGSEE_APP_TOKEN" "$BUGSEE_ENDPOINT" > '${seen}'\nexit 0\n`;
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

  it('a token one digit off the placeholder is not taken for it', () => {
    const result = runScheme({ BUGSEE_APP_TOKEN: '00000000-0000-4000-8000-000000000001', BUGSEE_ENDPOINT: 'https://127.0.0.1:9' });
    expect(result.invoked).toMatch(/^argv=xcode post-action\n/);
  });
});
