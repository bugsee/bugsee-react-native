/**
 * Regenerates `scripts/sdk-api.json`, the public method names of the native
 * SDKs, from SDK checkouts at the PINNED versions (native-versions.json).
 *
 * Usage: cli-extract-sdk-api.ts [iosSdkRoot] [androidSdkRoot]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndroidApi, parseIosApi } from './sdk-api.ts';
import { assertAtPinnedVersion, readSdkVersion } from './sdk-version.ts';

const home = process.env.HOME ?? '';
const [iosRoot = join(home, 'Projects/Bugsee/ios/sdk'),
       androidRoot = join(home, 'Projects/Bugsee/android/sdk')] = process.argv.slice(2);

// Refuse before reading anything: the snapshot is stamped with the version MEASURED from the
// checkouts, and a tree that is not at the pin would bless methods the pinned SDK lacks.
const pinned = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'native-versions.json'), 'utf8'),
) as { android: { sdk: string }; ios: { sdk: string } };
assertAtPinnedVersion('ios', iosRoot, pinned.ios.sdk);
assertAtPinnedVersion('android', androidRoot, pinned.android.sdk);

const android = parseAndroidApi(readFileSync(
  join(androidRoot, 'library/src/main/java/com/bugsee/library/Bugsee.java'), 'utf8'));
const ios = parseIosApi(readFileSync(
  join(iosRoot, 'BugseeDev/BugseeLib/BugseeLib/Bugsee.h'), 'utf8'));

const out = join(import.meta.dirname, 'sdk-api.json');
writeFileSync(
  out,
  `${JSON.stringify({ sdk: { android: readSdkVersion(androidRoot), ios: readSdkVersion(iosRoot) }, android, ios }, null, 2)}\n`,
);
console.log(`android ${android.length} methods, ios ${ios.length} -> ${out}`);
