import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const exampleDir = join(__dirname, '..', '..', 'examples', 'bare');
const read = (...p: string[]) => readFileSync(join(exampleDir, ...p), 'utf8');
const scripts = (JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
}).scripts;

// `yarn --cwd <dir>` runs the child process WITH <dir> as its working
// directory. A path written relative to examples/bare therefore resolves
// against the repo root instead, and the embed assertion reports "no such app
// bundle" for every build, sound or not.
//
// This shipped, and CI did not notice, because CI called the root script with
// its own root-relative path while developers called this one. The workflow
// now runs this exact script; these tests stop the invocation drifting back.
/** Drops // and block comments, so prose about a rule is not read as the rule. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('the example wires the embed assertion to a path it can resolve', () => {
    // Comments in these files explain the --cwd trap by name, so a naive
  // search matches the warning rather than the mistake. Check what runs.
  const code = (source: string) =>
    source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  const callers: [string, string][] = [
    ['package.json assert:ios-embed', scripts['assert:ios-embed'] ?? ''],
    ['scripts/run-ios.sh', code(read('scripts', 'run-ios.sh'))],
  ];

  it.each(callers)('%s does not cross a --cwd boundary', (_name, source) => {
    expect(source).not.toMatch(/--cwd/);
  });

  it.each(callers)('%s invokes the shared, tested CLI', (_name, source) => {
    expect(source).toMatch(/cli-assert-framework-embedded\.ts/);
  });

  // A textual "no --cwd" check does not stop the path being wrong in some
  // other way: a sound build plus a wrong path exits 2, which reads as "your
  // build is missing" rather than "your script is misconfigured".
  it('passes the path xcodebuild is configured to write', () => {
    const script = scripts['assert:ios-embed'] ?? '';
    const workflow = readFileSync(
      join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    // -derivedDataPath build, so products land under <that>/Build/Products.
    expect(workflow).toMatch(/-derivedDataPath build/);
    expect(script).toMatch(/ios\/build\/Build\/Products\/Debug-iphoneos\//);
  });

  // Same rule for the endpoint: the example carried its own copy of the
  // iOS "/v2" normalisation, which is the library's job and is tested there.
  // The intent is that the example does not carry the rule, not that it calls
  // one particular function: reaching it through the typed options accessor
  // is better than calling endpointFor directly, and an assertion naming the
  // function went stale the moment the example improved.
  it('does not re-implement endpoint normalisation', () => {
    const code = codeOf(read('App.tsx'));
    expect(code).toMatch(/endpointFor|\.endpoint\s*=/);
    expect(code).not.toMatch(/v2/);
  });

  // One implementation of this check, not two. There used to be a second copy
  // as a shell script, and only one of them was tested.
  it('has no second copy of the assertion', () => {
    expect(() => read('scripts', 'assert-ios-embed.sh')).toThrow();
  });
});

// Task 6.4: without Bugsee.wrap, the SDK's 'vh' view-hierarchy request always
// answers with nothing -- there is no registered anchor for the walk to start
// from. The example is the one place a regression here would otherwise go
// unnoticed, since nothing else renders the real app's root.
describe('the example registers Bugsee.wrap(App)', () => {
  it('wraps App with Bugsee.wrap before registering it', () => {
    const code = codeOf(read('index.js'));
    expect(code).toMatch(/AppRegistry\.registerComponent\(\s*appName\s*,\s*\(\)\s*=>\s*Bugsee\.wrap\(App\)\s*\)/);
  });
});

// Final-review ruling D3: CI's ios-e2e job runs the launch suite only. The
// report-handler and wrapper-channel suites have tight timing windows (a 25 s
// deadline asserted to within a second) that a shared runner cannot promise,
// and they retain bundles, which hold credentials on iOS beta3 -- CI has no
// policy for that. A bare `yarn e2e` would pick them all up silently.
describe("CI's ios-e2e step", () => {
  const workflow = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const step = (() => {
    const start = workflow.indexOf('- name: Reach Status.Launched');
    expect(start).toBeGreaterThanOrEqual(0);
    const next = workflow.indexOf('\n      - name:', start + 1);
    const jobEnd = workflow.indexOf('\n  ios:', start);
    const ends = [next, jobEnd].filter(i => i > 0);
    return workflow.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
  })();

  it('runs launch.test.ts and nothing else', () => {
    const run = /\n\s*run:\s*(.+)/.exec(step)?.[1]?.trim();
    expect(run).toBe("yarn e2e '/launch\\.test\\.ts$'");
  });

  // Jest reads the argument as a regex over each test path: it must select
  // launch.test.ts alone among the e2e suites (api-relaunch.test.ts holds
  // "launch.test.ts" as a substring).
  it('its path pattern selects launch.test.ts alone among the e2e suites', () => {
    const run = /\n\s*run:\s*(.+)/.exec(step)?.[1]?.trim() ?? '';
    const pattern = /'([^']+)'/.exec(run)?.[1];
    expect(pattern).toBeDefined();
    const e2e = join(__dirname, '..', '..', 'examples', 'bare', 'e2e');
    const suites = readdirSync(e2e).filter(name => name.endsWith('.test.ts'));
    expect(suites).toContain('api-relaunch.test.ts');
    const selected = suites.filter(name => new RegExp(pattern!, 'i').test(join(e2e, name)));
    expect(selected).toEqual(['launch.test.ts']);
  });
});

// Task 7.6a (R12): `bugsee-e2e-native` holds a JNI library whose only job is
// to crash the process, plus temp-file helpers for the device tests. It is an
// example-only workspace package. A consumer of @bugsee/react-native must
// never autolink it, so no library package may depend on it, and no library
// source (JS, Java, Objective-C, Gradle, podspec) may name it.
describe('bugsee-e2e-native stays in the example', () => {
  const repo = join(__dirname, '..', '..');
  const packagesDir = join(repo, 'packages');
  const E2E_NATIVE = /bugsee-e2e-native|com\.bugsee\.e2enative|BugseeE2E/;
  const SKIP = new Set(['node_modules', 'build', '.gradle', '.cxx', 'Pods', 'Bugsee.xcframework']);

  function filesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...filesUnder(path));
      } else if (/\.(tsx?|jsx?|json|java|kt|mm?|h|swift|gradle|podspec|txt|cpp)$/.test(entry.name)) {
        found.push(path);
      }
    }
    return found;
  }

  type Manifest = {
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const dependencyNames = (manifest: Manifest): string[] => [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];

  it('bugsee-e2e-native is a dependency of the bare example only', () => {
    const bare = JSON.parse(read('package.json')) as Manifest;
    expect(bare.dependencies?.['bugsee-e2e-native']).toBe('workspace:*');

    const libraries = readdirSync(packagesDir).filter((name) =>
      existsSync(join(packagesDir, name, 'package.json')),
    );
    expect(libraries).toContain('react-native');
    for (const name of libraries) {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, name, 'package.json'), 'utf8'),
      ) as Manifest;
      expect({ name, deps: dependencyNames(manifest) }).toEqual({
        name,
        deps: expect.not.arrayContaining(['bugsee-e2e-native']),
      });
    }
  });

  it('bugsee-e2e-native is private, so it can never be published', () => {
    const manifest = JSON.parse(
      readFileSync(join(repo, 'examples', 'e2e-native', 'package.json'), 'utf8'),
    ) as Manifest & { name?: string };
    expect(manifest.name).toBe('bugsee-e2e-native');
    expect(manifest.private).toBe(true);
  });

  // CI builds the example on SwiftPM too, and there React Native refuses an
  // autolinked dependency with no Package.swift ("it ships no Swift Package
  // Manager support"). A hand-written one, without the autolinker's
  // generated-file marker, is what makes it "self-managed".
  it('bugsee-e2e-native ships its own SwiftPM manifest', () => {
    const manifest = readFileSync(
      join(repo, 'examples', 'e2e-native', 'ios', 'Package.swift'),
      'utf8',
    );
    expect(manifest).not.toMatch(/AUTO-GENERATED|AUTO-SCAFFOLDED/);
    // toSwiftName('bugsee-e2e-native'): the product the autolinker asks for.
    expect(manifest).toMatch(/\.library\(name: "BugseeE2eNative"/);
  });

  it('no library source imports bugsee-e2e-native', () => {
    const sources = filesUnder(packagesDir);
    // The scan must reach every native and JS tree the library ships.
    expect(sources.some((path) => path.endsWith(join('src', 'index.ts')))).toBe(true);
    expect(sources.some((path) => path.endsWith('BugseeModule.java'))).toBe(true);
    expect(sources.some((path) => path.endsWith('BugseeModule.mm'))).toBe(true);
    expect(sources.some((path) => path.endsWith('build.gradle'))).toBe(true);
    expect(sources.some((path) => path.endsWith('.podspec'))).toBe(true);

    const naming = sources
      .filter((path) => E2E_NATIVE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repo, path));
    expect(naming).toEqual([]);
  });
});
