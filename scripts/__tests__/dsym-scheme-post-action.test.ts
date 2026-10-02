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

  // Removing the post-action, or pointing it at `xcode upload-dsyms` /
  // BugseeAgent, is the break: Archive would no longer run the documented
  // flow, which daemonizes and gates on Archive + Release by itself.
  it('runs bugsee-cli xcode post-action from node_modules', () => {
    expect(action).toBeDefined();
    expect(script).toMatch(/node_modules/);
    expect(script).toMatch(/bugsee-cli["']?\s+xcode post-action(?:\s|$)/m);
    expect(script).not.toMatch(/BugseeAgent/);
    expect(script).not.toMatch(/upload-dsyms/);
  });

  // Setting either gate variable, or --force-foreground, changes when the
  // upload runs and whether a later failure can fail the signed archive.
  it('does not widen the archive gate', () => {
    expect(action).toBeDefined();
    expect(script).not.toMatch(/BUGSEE_BUILD_INFO_ALL_ACTIONS/);
    expect(script).not.toMatch(/BUGSEE_BUILD_INFO_ALL_CONFIGURATIONS/);
    expect(script).not.toMatch(/--force-foreground/);
    expect(script).not.toMatch(/--app-token/);
    expect(script).not.toMatch(/BUGSEE_APP_TOKEN/);
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
