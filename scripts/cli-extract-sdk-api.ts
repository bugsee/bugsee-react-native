/**
 * Regenerates `scripts/sdk-api.json`, the public method names of the native
 * SDKs, from SDK checkouts at the PINNED versions (native-versions.json).
 *
 * Usage: cli-extract-sdk-api.ts [iosSdkRoot] [androidSdkRoot]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndroidApi, parseIosApi } from './sdk-api.ts';

const home = process.env.HOME ?? '';
const [iosRoot = join(home, 'Projects/Bugsee/ios/sdk'),
       androidRoot = join(home, 'Projects/Bugsee/android/sdk')] = process.argv.slice(2);

const android = parseAndroidApi(readFileSync(
  join(androidRoot, 'library/src/main/java/com/bugsee/library/Bugsee.java'), 'utf8'));
const ios = parseIosApi(readFileSync(
  join(iosRoot, 'BugseeDev/BugseeLib/BugseeLib/Bugsee.h'), 'utf8'));

const out = join(import.meta.dirname, 'sdk-api.json');
writeFileSync(out, `${JSON.stringify({ android, ios }, null, 2)}\n`);
console.log(`android ${android.length} methods, ios ${ios.length} -> ${out}`);
