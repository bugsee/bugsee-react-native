import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = (...p: string[]) =>
  readFileSync(join(__dirname, '..', '..', 'packages', 'react-native', ...p), 'utf8');

/**
 * Every callable member the `Spec` interface declares in `NativeBugsee.ts`.
 *
 * The `EventEmitter` properties (`onLifecycleEvent`, `onReportHandlerRequest`)
 * are deliberately excluded: codegen turns those into `emit*` methods on the
 * generated `NativeBugseeSpecBase` class, not into a selector this module
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

const wanted = specMethodNames(pkg('src', 'NativeBugsee.ts'));
const implemented = moduleSelectorFirstSegments(pkg('ios', 'BugseeModule.mm'));

describe('every Spec method in NativeBugsee.ts has an implementation in BugseeModule.mm', () => {
  it('found at least one method to check', () => {
    expect(wanted.length).toBeGreaterThan(0);
  });

  it.each(wanted)('%s is implemented', (name) => {
    expect(implemented.has(name)).toBe(true);
  });
});
