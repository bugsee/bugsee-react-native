/**
 * Regenerates the committed option-key fixture from the native SDK sources.
 *
 * Usage: cli-extract-option-keys.ts [iosSdkRoot] [androidSdkRoot]
 * Defaults to the sibling Bugsee checkouts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAndroidKeys,
  parseIosKeys,
  parseJavaEnum,
  splitByPlatform,
} from './option-keys.ts';

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

// The option enums, read from the same sources. These cross the bridge as
// numbers, so a wrong one is honoured by the SDK as a different setting.
const enumDir = join(
  androidRoot, 'library/src/main/java/com/bugsee/library/contracts/options',
);
const enums = Object.fromEntries(
  ['LogLevel', 'VideoMode', 'VideoQuality', 'FrameRate', 'IssueSeverity'].map(
    (name) => [name, parseJavaEnum(readFileSync(join(enumDir, `${name}.java`), 'utf8'))],
  ),
);
const enumsOut = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'option-enums.json',
);
writeFileSync(enumsOut, `${JSON.stringify(enums, null, 2)}\n`);

console.log(
  `shared ${keys.shared.length}, iOS-only ${keys.ios.length}, ` +
    `Android-only ${keys.android.length} -> ${out}`,
);
for (const [name, constants] of Object.entries(enums)) {
  console.log(`  ${name}: ${JSON.stringify(constants)}`);
}
