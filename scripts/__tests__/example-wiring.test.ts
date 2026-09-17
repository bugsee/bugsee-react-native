import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  it('does not re-implement endpoint normalisation', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/endpointFor/);
    // Executable lines only. A comment explaining the rule is not a second
    // implementation of it -- checking the raw text matched this file's own
    // prose, the same false positive as the --cwd guard above.
    expect(codeOf(app)).not.toMatch(/v2/);
  });

  // One implementation of this check, not two. There used to be a second copy
  // as a shell script, and only one of them was tested.
  it('has no second copy of the assertion', () => {
    expect(() => read('scripts', 'assert-ios-embed.sh')).toThrow();
  });
});
