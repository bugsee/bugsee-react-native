import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAtPinnedVersion, readSdkVersion } from '../sdk-version';

const checkout = (version: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-version-'));
  writeFileSync(join(root, 'version.txt'), `${version}\n`);
  return root;
};

describe('sdk-version', () => {
  it('reads the version a checkout declares, without the trailing newline', () => {
    expect(readSdkVersion(checkout('7.4.2'))).toBe('7.4.2');
  });

  it('accepts a checkout at the pinned version', () => {
    expect(() => assertAtPinnedVersion('android', checkout('7.4.2'), '7.4.2')).not.toThrow();
  });

  it('refuses a checkout a release ahead of the pin, naming both versions', () => {
    expect(() => assertAtPinnedVersion('ios', checkout('7.0.1'), '7.0.0')).toThrow(
      /ios SDK checkout .* is 7\.0\.1, but native-versions\.json pins 7\.0\.0/,
    );
  });

  it('refuses a checkout with no version.txt rather than assuming it matches', () => {
    expect(() => readSdkVersion(mkdtempSync(join(tmpdir(), 'sdk-version-')))).toThrow();
  });
});
