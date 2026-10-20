import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const repo = join(__dirname, '..', '..');
const srcRoot = join(repo, 'packages', 'react-native', 'src');

const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

function tsSources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...tsSources(path));
    } else if (/\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** Comments may name the call; only code must reference it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const REFERENCES_WRAPPER_LOG = /\bwrapperLog\b/;
const REFERENCES_FORWARD_LOG = /\bforwardLog\b/;
const CALLS_NATIVE_LOG = /\bNativeBugsee\.log\b/;

/**
 * `NativeBugsee.ts` declares the native method; `wrapper/channel.ts`
 * (Phase 3) is the one place that calls it. Nothing else may reach
 * `wrapperLog` directly; there is to be one native route for wrapper lines,
 * not two.
 */
const ALLOWED_RELATIVE = [join('wrapper', 'channel.ts'), 'NativeBugsee.ts'].sort();

/**
 * The channel carries only what this wrapper captured on its own: the
 * console patch. The app's own `log()` is not a wrapper line -- with
 * `capture.logs` off the SDKs record nothing from the channel -- and goes
 * through the native `Bugsee.log`, from `logs/log.ts` only.
 */
const FORWARD_LOG_RELATIVE = [join('console', 'capture.ts'), join('wrapper', 'channel.ts')].sort();
const NATIVE_LOG_RELATIVE = [join('logs', 'log.ts')];

function referrers(sources: string[], pattern: RegExp): string[] {
  return sources
    .filter((path) => pattern.test(stripComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(srcRoot, path))
    .sort();
}

describe('one native route for wrapper lines, another for the app\'s log()', () => {
  const sources = tsSources(srcRoot);

  it('found the sources to scan', () => {
    expect(sources.some((path) => basename(path) === 'index.ts')).toBe(true);
  });

  it('only src/wrapper/channel.ts references wrapperLog', () => {
    expect(referrers(sources, REFERENCES_WRAPPER_LOG)).toEqual(ALLOWED_RELATIVE);
  });

  it('only the console patch reaches the channel, through forwardLog', () => {
    expect(referrers(sources, REFERENCES_FORWARD_LOG)).toEqual(FORWARD_LOG_RELATIVE);
  });

  it("the app's log() reaches native only through src/logs/log.ts", () => {
    expect(referrers(sources, CALLS_NATIVE_LOG)).toEqual(NATIVE_LOG_RELATIVE);
    const indexSource = stripComments(readFileSync(join(srcRoot, 'index.ts'), 'utf8'));
    expect(indexSource).not.toMatch(REFERENCES_FORWARD_LOG);
    expect(indexSource).not.toMatch(REFERENCES_WRAPPER_LOG);
  });
});
