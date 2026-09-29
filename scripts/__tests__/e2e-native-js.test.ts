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
