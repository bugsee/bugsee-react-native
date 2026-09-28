import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const repo = join(__dirname, '..', '..');

/**
 * Where JVM code that could register a wrapper lives: the library's own
 * sources, and the example apps' (which stand in for a customer's).
 */
const ROOTS = [
  join(repo, 'packages', 'react-native', 'android', 'src', 'main'),
  join(repo, 'examples'),
];

const SKIP = new Set(['node_modules', 'build', '.gradle', 'Pods', '.cxx']);

function jvmSources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...jvmSources(path));
    } else if (/\.(java|kt)$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** Comments may name the call; only code must not make it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** `setWrapper(` or a `::setWrapper` reference -- never `setWrapperInfo`. */
const CALLS_SET_WRAPPER = /\bsetWrapper\s*\(|::\s*setWrapper\b/;

/**
 * The wrapper-channel spec: a wrapper must not call setWrapper concurrently
 * with itself. On Android the channel is delivered under the SDK's
 * registration lock, so two of our registrations racing can deadlock or
 * leave a superseded channel stored. WrapperRegistrar holds the one lock
 * every registration takes; a call anywhere else walks around it.
 */
describe('wrapper registration is serialised', () => {
  const sources = ROOTS.flatMap(jvmSources);
  const callers = sources
    .filter((path) => CALLS_SET_WRAPPER.test(stripComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(repo, path));

  it('found the sources to scan', () => {
    expect(sources.some((path) => basename(path) === 'BugseeModule.java')).toBe(true);
  });

  it('no source outside WrapperRegistrar calls Bugsee.setWrapper', () => {
    expect(callers.map((path) => basename(path))).toEqual(['WrapperRegistrar.java']);
  });
});
