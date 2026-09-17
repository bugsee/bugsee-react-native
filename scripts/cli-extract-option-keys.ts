/**
 * Regenerates the committed option-key fixture from the native SDK sources.
 *
 * Usage: cli-extract-option-keys.ts [iosSdkRoot] [androidSdkRoot]
 * Defaults to the sibling Bugsee checkouts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndroidKeys, parseIosKeys, splitByPlatform } from './option-keys.ts';

const home = process.env.HOME ?? '';
const [iosRoot = join(home, 'Projects/Bugsee/ios/sdk'),
       androidRoot = join(home, 'Projects/Bugsee/android/sdk')] = process.argv.slice(2);

const iosSource = join(iosRoot, 'BugseeDev/BugseeLib/BugseeLib/BugseeOptions.m');
const androidSource = join(
  androidRoot,
  'library/src/main/java/com/bugsee/library/contracts/options/Options.java',
);

const keys = splitByPlatform(
  parseIosKeys(readFileSync(iosSource, 'utf8')),
  parseAndroidKeys(readFileSync(androidSource, 'utf8')),
);

const out = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'option-keys.json',
);
writeFileSync(out, `${JSON.stringify(keys, null, 2)}\n`);

console.log(
  `shared ${keys.shared.length}, iOS-only ${keys.ios.length}, ` +
    `Android-only ${keys.android.length} -> ${out}`,
);
