/**
 * Task 7.6a: the JS guards of the example-only `bugsee-e2e-native` module.
 *
 * The device test (examples/bare/e2e/e2e-native.test.ts) proves the guard on
 * the real bridge for one bad kind; this pins every rule without a device.
 * The native module is mocked, so a call that reaches it is visible.
 */
const native = {
  crashNative: jest.fn(),
  writeTempFile: jest.fn(async (name: string) => `/cache/${name}`),
  fileExists: jest.fn(async () => true),
};
jest.mock('../../examples/e2e-native/src/NativeBugseeE2E', () => ({
  __esModule: true,
  default: native,
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { crashNative, fileExists, writeTempFile } from '../../examples/e2e-native/src';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('crashNative', () => {
  it.each(['segv', 'abort'] as const)('passes %s through', (kind) => {
    crashNative(kind);
    expect(native.crashNative).toHaveBeenCalledWith(kind);
  });

  it.each([['bogus'], [''], ['SEGV'], [undefined], [null], [0], [{}]])(
    'rejects %p with a TypeError before crossing',
    (kind) => {
      expect(() => crashNative(kind as never)).toThrow(TypeError);
      expect(native.crashNative).not.toHaveBeenCalled();
    },
  );

  it('does not echo the rejected value', () => {
    expect(() => crashNative('secret-kind' as never)).toThrow(/^(?!.*secret-kind)/);
  });
});

describe('writeTempFile', () => {
  it('resolves what native resolves', async () => {
    await expect(writeTempFile('smoke-1.txt', 'smoke 1')).resolves.toBe('/cache/smoke-1.txt');
    expect(native.writeTempFile).toHaveBeenCalledWith('smoke-1.txt', 'smoke 1');
  });

  it.each([['a'], ['A_b-c.9'], ['x'.repeat(64)], ['.hidden']])('accepts the name %p', async (name) => {
    await writeTempFile(name, '');
    expect(native.writeTempFile).toHaveBeenCalledWith(name, '');
  });

  it.each([
    [''],
    ['x'.repeat(65)],
    ['a/b'],
    ['../escape'],
    ['.'],
    ['..'],
    ['sp ace'],
    ['é'],
    [undefined],
    [42],
  ])('rejects the name %p with a TypeError before crossing', (name) => {
    expect(() => writeTempFile(name as never, 'x')).toThrow(TypeError);
    expect(native.writeTempFile).not.toHaveBeenCalled();
  });

  it('rejects non-string contents with a TypeError before crossing', () => {
    expect(() => writeTempFile('a.txt', 42 as never)).toThrow(TypeError);
    expect(native.writeTempFile).not.toHaveBeenCalled();
  });

  it('does not echo the rejected name', () => {
    expect(() => writeTempFile('secret name', 'x')).toThrow(/^(?!.*secret)/);
  });
});

describe('fileExists', () => {
  it('asks native', async () => {
    await expect(fileExists('/cache/a')).resolves.toBe(true);
    expect(native.fileExists).toHaveBeenCalledWith('/cache/a');
  });

  it('rejects a non-string path with a TypeError before crossing', () => {
    expect(() => fileExists(7 as never)).toThrow(TypeError);
    expect(native.fileExists).not.toHaveBeenCalled();
  });
});

/**
 * The file-name rule lives in three places: the JS guard, and the native
 * re-checks behind it (Java TempFileNames, ObjC BGSE2EIsPlainName). The Java
 * one has its own JVM test; the example module has no XCTest target, so the
 * ObjC one is covered here. Each native pattern is read out of its source
 * and run over the same names as the JS guard, so the three cannot drift
 * apart unnoticed.
 */
describe('the native name checks agree with the JS guard', () => {
  const moduleDir = join(__dirname, '..', '..', 'examples', 'e2e-native');
  const read = (...p: string[]) => readFileSync(join(moduleDir, ...p), 'utf8');

  const javaSource = read('android', 'src', 'main', 'java', 'com', 'bugsee', 'e2enative', 'TempFileNames.java');
  const objcSource = read('ios', 'BugseeE2EModule.mm');

  // Java string literal -> regex source: "\\w" in the file is \w in the regex.
  const javaPlain = /PLAIN = Pattern\.compile\("((?:[^"\\]|\\.)*)"\)/.exec(javaSource)?.[1]?.replace(/\\\\/g, '\\');
  const javaDots = /ONLY_DOTS = Pattern\.compile\("((?:[^"\\]|\\.)*)"\)/.exec(javaSource)?.[1]?.replace(/\\\\/g, '\\');
  const objcPlain = /regularExpressionWithPattern:@"((?:[^"\\]|\\.)*)"/.exec(objcSource)?.[1];

  const NAMES = [
    'a', 'A_b-c.9', 'smoke-0123abcd.txt', '.hidden', 'a..b', 'x'.repeat(64),
    '', 'x'.repeat(65), 'a/b', '../escape', '/abs', 'a\\b', 'sp ace', 'é', '／',
    '.', '..', '...', '.'.repeat(64),
  ];

  /** What the JS guard accepts, observed through its TypeError. */
  const jsAccepts = (name: string): boolean => {
    try {
      writeTempFile(name, '');
      return true;
    } catch {
      return false;
    }
  };

  it('found each native pattern in its source', () => {
    expect(javaPlain).toBe('^[\\w.-]{1,64}$');
    expect(javaDots).toBe('^\\.+$');
    expect(objcPlain).toBe('^[A-Za-z0-9_.-]{1,64}$');
    // The ObjC dot-only rule: trim the dots, and a name with nothing left is refused.
    expect(objcSource).toMatch(/characterSetWithCharactersInString:@"\."\]\];\s*return dots\.length > 0;/);
  });

  it.each(NAMES)('Java and ObjC decide %p as JS does', (name) => {
    const js = jsAccepts(name);
    const java = new RegExp(javaPlain!).test(name) && !new RegExp(javaDots!).test(name);
    const objc = new RegExp(objcPlain!).test(name) && name.replace(/\./g, '').length > 0;
    expect({ name, java, objc }).toEqual({ name, java: js, objc: js });
  });
});
