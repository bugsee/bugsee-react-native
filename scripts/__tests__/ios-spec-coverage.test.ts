import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = (...p: string[]) =>
  readFileSync(join(__dirname, '..', '..', 'packages', 'react-native', ...p), 'utf8');

/**
 * Every callable member the `Spec` interface declares in `NativeBugsee.ts`.
 *
 * The `EventEmitter` properties (`onLifecycleEvent`, `onReportHandlerRequest`,
 * `onDataRequest`) are deliberately excluded: codegen turns those into
 * `emit*` methods on the generated `NativeBugseeSpecBase` class, not into a
 * selector this module
 * implements -- that wiring is covered by event-emitter-wiring.test.ts, not
 * this file. A plain interface method reads as `name(` at the start of a
 * line; an `EventEmitter` property reads as `readonly name:` and never
 * matches.
 *
 * Derived rather than listed: a hardcoded list silently stops covering a
 * method the moment the spec grows one, which is exactly the failure mode
 * java-signatures.ts was rewritten to avoid.
 */
function specMethodNames(source: string): string[] {
  const body = /export interface Spec extends TurboModule \{([\s\S]*?)\n\}\n/.exec(
    source,
  )?.[1];
  if (body === undefined) {
    throw new Error('Spec interface not found in NativeBugsee.ts');
  }
  const names = new Set<string>();
  for (const [, name] of body.matchAll(/^\s*(\w+)\s*\(/gm)) {
    names.add(name as string);
  }
  return [...names].sort();
}

/**
 * The first selector segment of every method inside `@implementation
 * BugseeModule` -- not the whole file, which also declares an unrelated
 * `BGSRNWrapper (BugseeConformance)` category with its own `onBeforeReportCreated`
 * / `onAfterReportCreated` selectors from a different protocol entirely.
 */
function moduleSelectorFirstSegments(source: string): Set<string> {
  const body = /@implementation BugseeModule\b([\s\S]*?)\n@end/.exec(source)?.[1];
  if (body === undefined) {
    throw new Error('@implementation BugseeModule not found in BugseeModule.mm');
  }
  const names = new Set<string>();
  for (const [, name] of body.matchAll(/^[ \t]*[-+]\s*\([^)]*\)\s*(\w+)/gm)) {
    names.add(name as string);
  }
  return names;
}

/**
 * The full selector codegen expects for every Spec method, derived from the
 * spec's own parameter names: the method name takes the first argument, each
 * later parameter names its segment, and a `Promise` return appends
 * `resolve`/`reject`. `event(name, paramsJson)` is `event:paramsJson:`.
 *
 * The first segment alone cannot see a renamed parameter, and ObjC treats a
 * protocol method with no implementation as a warning, not an error: the
 * module builds, and the call dies at runtime with an unrecognized selector.
 */
function specSelectors(source: string): Map<string, string> {
  const body = /export interface Spec extends TurboModule \{([\s\S]*?)\n\}\n/.exec(
    source,
  )?.[1];
  if (body === undefined) {
    throw new Error('Spec interface not found in NativeBugsee.ts');
  }
  const selectors = new Map<string, string>();
  for (const [, name, params, returns] of body.matchAll(
    /^\s*(\w+)\s*\(([^)]*)\)\s*:\s*([^;]+);/gm,
  )) {
    const args = (params as string)
      .split(',')
      .map((param) => param.trim())
      .filter((param) => param !== '')
      .map((param) => param.split(':')[0]!.trim());
    if ((returns as string).trim().startsWith('Promise<')) {
      args.push('resolve', 'reject');
    }
    selectors.set(
      name as string,
      args.length === 0
        ? (name as string)
        : `${name as string}:${args.slice(1).map((arg) => `${arg}:`).join('')}`,
    );
  }
  return selectors;
}

/** Every full selector `@implementation BugseeModule` defines. */
function moduleSelectors(source: string): Set<string> {
  const body = /@implementation BugseeModule\b([\s\S]*?)\n@end/.exec(source)?.[1];
  if (body === undefined) {
    throw new Error('@implementation BugseeModule not found in BugseeModule.mm');
  }
  const selectors = new Set<string>();
  for (const [declaration] of body.matchAll(/^[ \t]*[-+]\s*\([^)]*\)[^{;]*/gm)) {
    // Types out first -- `(NSString * _Nullable)` -- then the segments.
    const bare = declaration.replace(/^[ \t]*[-+]\s*/, '').replace(/\([^)]*\)/g, ' ');
    const segments = [...bare.matchAll(/(\w+)\s*:/g)].map((m) => `${m[1] as string}:`);
    selectors.add(segments.length > 0 ? segments.join('') : bare.trim());
  }
  return selectors;
}

const wanted = specMethodNames(pkg('src', 'NativeBugsee.ts'));
const implemented = moduleSelectorFirstSegments(pkg('ios', 'BugseeModule.mm'));
const wantedSelectors = specSelectors(pkg('src', 'NativeBugsee.ts'));
const implementedSelectors = moduleSelectors(pkg('ios', 'BugseeModule.mm'));

describe('every Spec method in NativeBugsee.ts has an implementation in BugseeModule.mm', () => {
  it('found at least one method to check', () => {
    expect(wanted.length).toBeGreaterThan(0);
  });

  it.each(wanted)('%s is implemented', (name) => {
    expect(implemented.has(name)).toBe(true);
  });

  it('derived a full selector for every Spec method', () => {
    expect([...wantedSelectors.keys()].sort()).toEqual(wanted);
  });

  it.each(wanted)('%s is implemented under the full selector codegen expects', (name) => {
    expect(implementedSelectors).toContain(wantedSelectors.get(name));
  });

  // The two object payloads that cross as JSON text (src/bridge/json.ts):
  // pinned by name, so the derivation above cannot drift into agreeing with
  // a module that still takes the old `params:`/`patch:` dictionaries.
  it('takes the object payloads as JSON text', () => {
    expect(wantedSelectors.get('event')).toBe('event:paramsJson:');
    expect(wantedSelectors.get('reportUpdate')).toBe('reportUpdate:patchJson:resolve:reject:');
    expect(wantedSelectors.get('stop')).toBe('stop:reject:');
    expect(wantedSelectors.get('testCrash')).toBe('testCrash');
  });
});
