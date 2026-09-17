/**
 * Asserts that a built `.app` will actually load the Bugsee framework.
 *
 * Building is not evidence. In the distribution spike the `spm_dependency`
 * variant compiled and linked cleanly, then dyld-crashed on launch because
 * nothing embedded the framework into the bundle. So CI checks two separate
 * things, which fail for different reasons:
 *
 *   embedded — Frameworks/<name>.framework/<name> exists in the bundle
 *   linked   — some Mach-O in the bundle has a load command for it
 *
 * Embedded without linked is dead weight; linked without embedded is the
 * launch crash.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Findings {
  embedded: boolean;
  linked: boolean;
}

/** The install names `otool -L` reports, excluding its header line. */
export function installNames(otoolOutput: string): string[] {
  return (
    otoolOutput
      .split('\n')
      // otool prints the inspected binary's own path unindented; dependencies
      // are indented beneath it. Anchored, because a bundle path may itself
      // contain spaces and would otherwise read as a dependency.
      .filter((line) => /^\s+\S/.test(line))
      // The line filter guarantees a non-space character survives `trim`, and
      // the annotation can only be stripped when whitespace precedes it, so
      // no empty name can reach the caller -- no defensive filter needed.
      // Stryker disable next-line Regex: dropping `$` is an equivalent mutant
      // here; the input is one line and `.` never matches a newline.
      .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, ''))
  );
}

/** Whether any install name refers to `<name>.framework/<name>`. */
export function linksFramework(names: string[], name: string): boolean {
  // Anchored on the path separator so BugseeFeedback does not satisfy Bugsee.
  const suffix = `/${name}.framework/${name}`;
  return names.some((n) => n.endsWith(suffix));
}

/** Where a correctly embedded framework's binary sits inside the bundle. */
export function embeddedBinaryPath(appPath: string, name: string): string {
  return join(appPath, 'Frameworks', `${name}.framework`, name);
}

/** The failure message, or null when the app is sound. */
export function explain(f: Findings, name: string): string | null {
  if (!f.embedded && !f.linked) {
    return `${name}.framework is neither embedded in the bundle nor linked by ` +
      `any binary in it. The dependency is not wired up at all.`;
  }
  if (!f.embedded) {
    return `${name}.framework is linked but NOT embedded: it is missing from ` +
      `the bundle's Frameworks directory. This builds and then dyld-crashes ` +
      `on launch — exactly the spm_dependency failure.`;
  }
  if (!f.linked) {
    return `${name}.framework is embedded but NOT linked: no binary in the ` +
      `bundle references it, so it ships as dead weight and the SDK never ` +
      `loads.`;
  }
  return null;
}

/**
 * The filesystem and tooling `inspect` needs, injected so the decision logic
 * is testable without building an app. The real implementation is a thin
 * shim; everything worth getting wrong lives above it.
 */
export interface Env {
  exists(path: string): boolean;
  /** Every Mach-O at the bundle root — the executable and any debug dylib. */
  binariesIn(appPath: string): string[];
  otool(binary: string): string;
}

// Stryker disable all: a pure IO shim over readdir/file/otool. Its real
// exercise is the iOS CI job, which runs the CLI against an actual built
// .app; mutating it here only manufactures unkillable mutants.
export const realEnv: Env = {
  exists: existsSync,
  binariesIn(appPath) {
    return readdirSync(appPath)
      .map((entry) => join(appPath, entry))
      .filter((path) => statSync(path).isFile())
      .filter((path) => {
        try {
          // `file` is cheap and avoids depending on a naming convention.
          return /Mach-O/.test(
            execFileSync('file', ['-b', path], { encoding: 'utf8' }),
          );
        } catch {
          return false;
        }
      });
  },
  otool(binary) {
    return execFileSync('otool', ['-L', binary], { encoding: 'utf8' });
  },
};
// Stryker restore all

export function inspect(appPath: string, name: string, env: Env = realEnv): Findings {
  // A Debug build links the framework from <App>.debug.dylib, not from the
  // main executable, so checking only the executable reports a false failure.
  return {
    embedded: env.exists(embeddedBinaryPath(appPath, name)),
    linked: env
      .binariesIn(appPath)
      .some((binary) => linksFramework(installNames(env.otool(binary)), name)),
  };
}
