/**
 * Regenerates the committed option-key fixture from the native SDK sources.
 *
 * Usage: cli-extract-option-keys.ts [iosSdkRoot] [androidSdkRoot]
 * Defaults to the sibling Bugsee checkouts. Point both at checkouts of the PINNED
 * versions (native-versions.json): the key lists gate what the wrapper warns about,
 * so a newer SDK tree would bless options the pinned release silently drops.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readObjcEnum } from './ios-enums.ts';
import { assertAtPinnedVersion } from './sdk-version.ts';
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

// Everything that can refuse runs before the first write, so a refusal never leaves some of the
// generated fixtures regenerated and others stale.
const nativeVersions = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'native-versions.json'), 'utf8'),
) as { android: { sdk: string }; ios: { sdk: string } };
assertAtPinnedVersion('ios', iosRoot, nativeVersions.ios.sdk);
assertAtPinnedVersion('android', androidRoot, nativeVersions.android.sdk);

// No golden manifest means the generated manifest would lose the NDK and leak options while the key
// list (read from their sources) still includes them, so the two artifacts would disagree.
const goldenPath = join(androidRoot, 'options-manifest/options-manifest.golden.json');
if (!existsSync(goldenPath)) {
  throw new Error(
    `${goldenPath} is missing. Point the extractor at an Android SDK checkout that has ` +
      'options-manifest/options-manifest.golden.json (every pinned release does).',
  );
}

// Every fixture is computed first and written together at the end, so a failure anywhere (an enum a
// header no longer declares, a golden manifest that does not parse) leaves no fixture regenerated
// and the others stale.
const pending: [path: string, content: string][] = [];

const iosSource = join(iosRoot, 'BugseeDev/BugseeLib/BugseeLib/BugseeOptions.m');
const androidSource = join(
  androidRoot,
  'library/src/main/java/com/bugsee/library/contracts/options/Options.java',
);

// Android declares its options in three modules. The extension holders matter:
// NDK crash detection is bundled by this package and the leak module is one
// dependency away, and a key missing from this list would draw the unknown-key
// warning for an option the SDK honours.
const androidSources = [
  androidSource,
  join(androidRoot, 'ndk/src/main/java/com/bugsee/library/contracts/options/NdkOptions.java'),
  join(androidRoot, 'leak/src/main/java/com/bugsee/library/contracts/options/LeakOptions.java'),
];

const keys = splitByPlatform(
  parseIosKeys(readFileSync(iosSource, 'utf8')),
  parseAndroidKeys(androidSources.map((file) => readFileSync(file, 'utf8')).join('\n')),
);

const out = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'option-keys.json',
);
pending.push([out, `${JSON.stringify(keys, null, 2)}\n`]);

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
pending.push([enumsOut, `${JSON.stringify(enums, null, 2)}\n`]);

// The SAME enums read from the iOS headers, so the two platforms can be
// compared. Extracted rather than hand-copied because the value that matters
// is agreement at a pinned version: the fixture must move when
// native-versions.json's ios.sdk moves, and a header copied by hand does not.
//
// iOS declares these across several headers and with a `Bugsee`/`BGS` prefix
// on every member; the parity gate strips the prefix and compares VALUES.
const iosEnumHeaders = {
  IssueSeverity: ['BugseeConstants.h', 'BugseeSeverityLevel'],
  CrashHandlerType: ['BugseeConstants.h', 'BugseeCrashHandlerType'],
  ReportingUIStyle: ['BugseeConstants.h', 'BugseeStyle'],
} as const;
const iosEnums = Object.fromEntries(
  Object.entries(iosEnumHeaders).map(([name, [header, objcName]]) => {
    // Throws on a missing, empty or partly unreadable enum: a rename or a new
    // attribute in the header must fail here rather than silently producing a
    // short parity check.
    try {
      return [name, readObjcEnum(
        readFileSync(join(iosRoot, 'BugseeDev/BugseeLib/BugseeLib', header), 'utf8'),
        objcName,
      )];
    } catch (error) {
      throw new Error(`${(error as Error).message} (${header}, the source for ${name})`, { cause: error });
    }
  }),
);
const iosEnumsOut = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'ios-enums.json',
);
pending.push([iosEnumsOut, `${JSON.stringify(iosEnums, null, 2)}\n`]);

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

// The core library's options come from its descriptors. The extension modules (NDK, leak)
// register theirs elsewhere, so reading OptionsDescriptors.java alone would leave out options
// the wrapper exposes. The SDK's golden manifest covers every module, so the extension rows
// are taken from it (its presence was checked up front, before anything was written).
const extensionOptions: OptionsManifest['options'] = (
  JSON.parse(readFileSync(goldenPath, 'utf8')) as { options: OptionsManifest['options'] }
).options.filter((option) => option.module !== 'bugsee-android');
const options: OptionsManifest['options'] = [
  ...parseAndroidDescriptors(
    readFileSync(join(
      androidRoot, 'library/src/main/java/com/bugsee/library/options/OptionsDescriptors.java',
    ), 'utf8'),
    androidConstants,
    enums,
  ),
  ...extensionOptions,
];

const manifest: OptionsManifest = {
  manifestVersion: 1,
  sdk: 'android',
  sdkVersion: nativeVersions.android.sdk,
  buildConfiguration: 'release',
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  options,
};
const manifestOut = join(
  import.meta.dirname, '..', 'packages', 'react-native', 'src', 'options',
  'android-options-manifest.json',
);
pending.push([manifestOut, `${JSON.stringify(manifest, null, 2)}\n`]);
for (const [path, content] of pending) {
  writeFileSync(path, content);
}
console.log(`android manifest: ${manifest.options.length} options -> ${manifestOut}`);

console.log(
  `shared ${keys.shared.length}, iOS-only ${keys.ios.length}, ` +
    `Android-only ${keys.android.length} -> ${out}`,
);
for (const [name, constants] of Object.entries(enums)) {
  console.log(`  ${name}: ${JSON.stringify(constants)}`);
}
