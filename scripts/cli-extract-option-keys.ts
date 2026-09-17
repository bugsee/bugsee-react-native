/**
 * Regenerates the committed option-key fixture from the native SDK sources.
 *
 * Usage: cli-extract-option-keys.ts [iosSdkRoot] [androidSdkRoot]
 * Defaults to the sibling Bugsee checkouts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAndroidDescriptors,
  parseAndroidKeys,
  parseIosKeys,
  parseJavaEnum,
  splitByPlatform,
  type OptionsManifest,
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

// An Android manifest in the shape bugsee/specs sdk/options/manifest.md
// defines, so that swapping to the SDK's own published manifest is a change of
// SOURCE and not of format. Status there is still "Proposed -- no SDK
// publishes a manifest yet"; this stands in until one does.
const androidConstants = Object.fromEntries(
  [...readFileSync(
    join(androidRoot, 'library/src/main/java/com/bugsee/library/contracts/options/Options.java'),
    'utf8',
  ).matchAll(/String (\w+)\s*=\s*"(com\.bugsee\.option[^"]*)"/g)]
    .map((m) => [m[1] as string, m[2] as string]),
);

const nativeVersions = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'native-versions.json'), 'utf8'),
) as { android: { sdk: string }; ios: { sdk: string } };

const manifest: OptionsManifest = {
  manifestVersion: 1,
  sdk: 'android',
  sdkVersion: nativeVersions.android.sdk,
  buildConfiguration: 'release',
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  options: parseAndroidDescriptors(
    readFileSync(join(
      androidRoot, 'library/src/main/java/com/bugsee/library/options/OptionsDescriptors.java',
    ), 'utf8'),
    androidConstants,
    enums,
  ),
};
const manifestOut = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'android-options-manifest.json',
);
writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`android manifest: ${manifest.options.length} options -> ${manifestOut}`);

console.log(
  `shared ${keys.shared.length}, iOS-only ${keys.ios.length}, ` +
    `Android-only ${keys.android.length} -> ${out}`,
);
for (const [name, constants] of Object.entries(enums)) {
  console.log(`  ${name}: ${JSON.stringify(constants)}`);
}
