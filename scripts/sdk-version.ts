import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The version an SDK checkout declares in its root `version.txt` (both SDKs keep one). */
export function readSdkVersion(root: string): string {
  return readFileSync(join(root, 'version.txt'), 'utf8').trim();
}

/**
 * Aborts when a checkout is not at the version `native-versions.json` pins.
 *
 * The extractors stamp what they extract and the tests trust the stamp, so it has to be measured
 * from the tree that was read: a checkout a release ahead of the pin would otherwise bless
 * options and methods the pinned SDK does not have.
 */
export function assertAtPinnedVersion(
  platform: 'android' | 'ios',
  root: string,
  pinned: string,
): void {
  const found = readSdkVersion(root);
  if (found !== pinned) {
    throw new Error(
      `${platform} SDK checkout at ${root} is ${found}, but native-versions.json pins ${pinned}. ` +
        'Check out the pinned release (or bump the pin) before extracting.',
    );
  }
}
