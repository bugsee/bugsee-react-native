import type { Env } from '../assert-framework-embedded';
import {
  inspect,
  installNames,
  linksFramework,
  embeddedBinaryPath,
  explain,
} from '../assert-framework-embedded';

// Captured verbatim from `otool -L` on a real Debug device build. Note the
// leading line is the binary's own path, not a dependency.
const MAIN_BINARY = `/…/BareExample.app/BareExample:
\t@rpath/BareExample.debug.dylib (compatibility version 0.0.0, current version 0.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

const DEBUG_DYLIB = `/…/BareExample.app/BareExample.debug.dylib:
\t@rpath/Bugsee.framework/Bugsee (compatibility version 1.0.0, current version 1.0.0)
\t@rpath/React.framework/React (compatibility version 0.0.0, current version 0.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

describe('installNames', () => {
  it('drops the header line naming the binary itself', () => {
    expect(installNames(MAIN_BINARY)).toEqual([
      '@rpath/BareExample.debug.dylib',
      '/usr/lib/libSystem.B.dylib',
    ]);
  });

  it('returns nothing for empty output rather than a bogus entry', () => {
    expect(installNames('')).toEqual([]);
  });

  // The header line is distinguished only by NOT being indented. A path can
  // legitimately contain spaces (Xcode's own DerivedData does), so a match
  // that is not anchored to the start of the line swallows it as a dependency.
  it('drops a header line whose path contains spaces', () => {
    const output = `/Users/me/My Builds/App.app/App:\n\t@rpath/Bugsee.framework/Bugsee (compatibility version 1.0.0, current version 1.0.0)\n`;
    expect(installNames(output)).toEqual(['@rpath/Bugsee.framework/Bugsee']);
  });

  it('drops blank indented lines instead of emitting empty names', () => {
    const output = `/app/App:\n\t\n\t@rpath/Bugsee.framework/Bugsee (compatibility version 1.0.0, current version 1.0.0)\n`;
    expect(installNames(output)).toEqual(['@rpath/Bugsee.framework/Bugsee']);
  });

  // otool indents with a tab, but the width is not part of any contract.
  // Requiring exactly one whitespace character would drop space-indented
  // output entirely, reporting a sound app as unlinked.
  it('accepts a dependency indented by more than one character', () => {
    const output = `/app/App:\n    @rpath/Bugsee.framework/Bugsee (compatibility version 1.0.0, current version 1.0.0)\n`;
    expect(installNames(output)).toEqual(['@rpath/Bugsee.framework/Bugsee']);
  });

  // otool aligns the annotation with a run of whitespace, not always one
  // space. Stripping only a single space leaves the name with a trailing one.
  it('strips the whole run of whitespace before the version annotation', () => {
    const output = `/app/App:\n\t@rpath/Bugsee.framework/Bugsee   (compatibility version 1.0.0, current version 1.0.0)\n`;
    expect(installNames(output)).toEqual(['@rpath/Bugsee.framework/Bugsee']);
  });
});

describe('linksFramework', () => {
  it('finds the framework by its @rpath install name', () => {
    expect(linksFramework(installNames(DEBUG_DYLIB), 'Bugsee')).toBe(true);
  });

  // This is the whole point: on a Debug build the app's main executable links
  // only the debug dylib, so checking it alone reports "not linked" for a
  // perfectly good build. The check must consider every Mach-O in the bundle.
  it('is false for the main executable of a Debug build', () => {
    expect(linksFramework(installNames(MAIN_BINARY), 'Bugsee')).toBe(false);
  });

  // A framework whose name merely contains ours must not count.
  it('does not match a different framework with a similar name', () => {
    const libs = ['@rpath/BugseeFeedback.framework/BugseeFeedback'];
    expect(linksFramework(libs, 'Bugsee')).toBe(false);
  });

  it('matches regardless of the rpath prefix used', () => {
    expect(linksFramework(
      ['@executable_path/Frameworks/Bugsee.framework/Bugsee'], 'Bugsee',
    )).toBe(true);
  });
});

describe('embeddedBinaryPath', () => {
  it('points inside the bundle Frameworks directory', () => {
    expect(embeddedBinaryPath('/tmp/X.app', 'Bugsee'))
      .toBe('/tmp/X.app/Frameworks/Bugsee.framework/Bugsee');
  });
});

describe('inspect', () => {
  const env = (over: Partial<Env> = {}): Env => ({
    exists: () => true,
    binariesIn: () => ['/app/Main'],
    otool: () => DEBUG_DYLIB,
    ...over,
  });

  it('reports a sound bundle', () => {
    expect(inspect('/app', 'Bugsee', env())).toEqual({
      embedded: true,
      linked: true,
    });
  });

  it('looks for the framework at the bundle Frameworks path', () => {
    const seen: string[] = [];
    inspect('/app', 'Bugsee', env({ exists: (p) => (seen.push(p), true) }));
    expect(seen).toEqual(['/app/Frameworks/Bugsee.framework/Bugsee']);
  });

  it('sees the missing framework as not embedded', () => {
    expect(inspect('/app', 'Bugsee', env({ exists: () => false })).embedded)
      .toBe(false);
  });

  // The regression this whole script exists for: on Debug the executable
  // links nothing but the debug dylib, and the framework reference lives in
  // that second binary. Stopping at the first binary reports a false failure.
  it('finds the link in a later binary, not just the first', () => {
    const outputs: Record<string, string> = {
      '/app/Main': MAIN_BINARY,
      '/app/Main.debug.dylib': DEBUG_DYLIB,
    };
    const findings = inspect('/app', 'Bugsee', env({
      binariesIn: () => ['/app/Main', '/app/Main.debug.dylib'],
      otool: (b) => outputs[b] ?? '',
    }));
    expect(findings.linked).toBe(true);
  });

  it('reports not linked when no binary references it', () => {
    expect(inspect('/app', 'Bugsee', env({ otool: () => MAIN_BINARY })).linked)
      .toBe(false);
  });

  it('reports not linked when the bundle has no binaries at all', () => {
    expect(inspect('/app', 'Bugsee', env({ binariesIn: () => [] })).linked)
      .toBe(false);
  });
});

describe('explain', () => {
  it('names both when the dependency is not wired up at all', () => {
    const message = explain({ embedded: false, linked: false }, 'Bugsee');
    expect(message).toMatch(/neither embedded/i);
    expect(message).toMatch(/nor linked/i);
    expect(message).toMatch(/not wired up/i);
  });

  // The two failures have completely different causes, and the spike hit
  // both. A message that does not distinguish them wastes the next person's
  // afternoon.
  it('names embedding when the framework is absent', () => {
    const message = explain({ embedded: false, linked: true }, 'Bugsee');
    expect(message).toMatch(/not embedded/i);
    expect(message).toMatch(/Bugsee/);
    expect(message).toMatch(/dyld/i);
    expect(message).toMatch(/spm_dependency/);
  });

  it('names linking when nothing references it', () => {
    const message = explain({ embedded: true, linked: false }, 'Bugsee');
    expect(message).toMatch(/not linked/i);
    expect(message).toMatch(/dead weight/i);
    expect(message).toMatch(/never loads/i);
  });

  it('is null when both hold', () => {
    expect(explain({ embedded: true, linked: true }, 'Bugsee')).toBeNull();
  });
});
