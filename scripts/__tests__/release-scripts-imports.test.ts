import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The publish job runs `publish-all.mjs --tarballs` with no `yarn install`, because it holds the npm
 * OIDC token and no dependency's install script may run beside it. A static import of anything that
 * is not a Node built-in or a sibling file would then fail the first real publish with
 * ERR_MODULE_NOT_FOUND while the dry run, which installs, stayed green.
 */
const scripts = join(__dirname, '..');
const SPEC = String.raw`(['"\x60])([^'"\x60]+)\1`;
const PATTERNS = [
  new RegExp(String.raw`^import\s+(?:[^;]*?from\s+)?${SPEC}`, 'gms'),
  new RegExp(String.raw`\bimport\(\s*${SPEC}\s*\)`, 'g'),
  new RegExp(String.raw`\brequire\(\s*${SPEC}\s*\)`, 'g'),
];
// Anything that loads a module by a name the patterns cannot read (a variable, createRequire(...)(x))
// fails the test rather than slipping through it.
const OPAQUE = /\bcreateRequire\b|\bimport\(\s*[^'"\x60\s]|\brequire\(\s*[^'"\x60\s]/;

const importsOf = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  if (OPAQUE.test(text)) throw new Error(`${file}: loads a module by a name this test cannot read`);
  const found = PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[2] as string));
  // Every call the patterns did not capture whole (`import('sem' + 'ver')`, a spread argument) is a
  // load whose name this test cannot read, so count the calls and refuse on any gap.
  const calls = (text.match(/\bimport\(/g) ?? []).length + (text.match(/\brequire\(/g) ?? []).length;
  const captured = [PATTERNS[1], PATTERNS[2]].reduce(
    (n, re) => n + [...text.matchAll(re as RegExp)].length,
    0,
  );
  if (calls !== captured) throw new Error(`${file}: a dynamic load this test cannot read in full`);
  return found;
};

function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of importsOf(entry)) {
    if (spec.startsWith('.')) closure(join(dirname(entry), spec), seen);
  }
  return seen;
}

describe('the publish entry point loads without installed dependencies', () => {
  it.each(['publish-all.mjs', 'npm-trust-all.mjs'])('%s imports only Node built-ins and sibling files', (name) => {
    const files = closure(join(scripts, name));
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      for (const spec of importsOf(file)) {
        expect(spec.startsWith('node:') || spec.startsWith('.')).toBe(true);
      }
    }
  });
});

describe('the import scan itself', () => {
  const scan = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'imports-'));
    const file = join(dir, 'x.mjs');
    writeFileSync(file, text);
    return importsOf(file);
  };

  it('reads single-quoted, double-quoted and template specifiers', () => {
    expect(scan("import a from 'one';")).toEqual(['one']);
    expect(scan('import b from "two";')).toEqual(['two']);
    expect(scan('const m = await import(`three`);')).toEqual(['three']);
    expect(scan('import "four";')).toEqual(['four']);
    expect(scan("const r = require('five');")).toEqual(['five']);
  });

  it('refuses a load it cannot read', () => {
    expect(() => scan("createRequire(import.meta.url)('x');")).toThrow();
    expect(() => scan('await import(name);')).toThrow();
    expect(() => scan("await import('sem' + 'ver');")).toThrow();
    expect(() => scan("const r = require('a' + b);")).toThrow();
  });
});
