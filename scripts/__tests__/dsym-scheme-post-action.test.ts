import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    expect(script).toContain(
      'export BUGSEE_APP_TOKEN="${BUGSEE_APP_TOKEN:-$BUGSEE_TOKEN_IOS}"',
    );
    expect(script).toMatch(/credentials\.json/);
    expect(script).toMatch(/-extract ios\b/);
    expect(script).not.toMatch(/--app-token/);
    expect(script).not.toMatch(/BUGSEE_APP_TOKEN="[^$]/);
    expect(script).not.toMatch(/BUGSEE_APP_TOKEN='[^$]/);
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
