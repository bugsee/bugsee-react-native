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

/**
 * `NativeBugsee.ts` declares the native method; `wrapper/channel.ts`
 * (Phase 3) is the one place that calls it. Nothing else -- including
 * `index.ts`'s Phase 4 `log()` -- may reach `wrapperLog` directly; there is
 * to be one native route for wrapper lines, not two.
 */
const ALLOWED_RELATIVE = [join('wrapper', 'channel.ts'), 'NativeBugsee.ts'].sort();

describe('there is one native route for wrapper lines', () => {
  const sources = tsSources(srcRoot);

  it('found the sources to scan', () => {
    expect(sources.some((path) => basename(path) === 'index.ts')).toBe(true);
  });

  it('only src/wrapper/channel.ts references wrapperLog', () => {
    const referrers = sources
      .filter((path) => REFERENCES_WRAPPER_LOG.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(srcRoot, path))
      .sort();

    expect(referrers).toEqual(ALLOWED_RELATIVE);
  });

  it('src/index.ts reaches the channel only through forwardLog', () => {
    const indexSource = stripComments(readFileSync(join(srcRoot, 'index.ts'), 'utf8'));
    expect(indexSource).toMatch(/\bforwardLog\(/);
    expect(indexSource).not.toMatch(REFERENCES_WRAPPER_LOG);
  });
});
