// Exact outputs of the plugin's text transforms on small inputs, edge cases
// included. The broader tests assert on fragments; these pin every byte.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rewriteBundlePhase, rewriteProjectBundlePhase } from '../bundle-phase';
import type { XcodeProjectLike } from '../bundle-phase';
import { DSYM_POST_ACTION_SCRIPT, dsymPostActionScript } from '../dsym-script';
import {
  CANNOT_EDIT,
  HERMES_COMMAND_UNREWRITABLE,
  ensureAppAppliesPlugin,
  ensureGradlePluginDeclared,
  ensureMavenCentral,
  ensureSymbolUploads,
} from '../gradle';
import { listSchemes } from '../index';
import { manifestAutoLaunchToken } from '../manifest';
import { loadNativeVersions } from '../native-versions';
import { decodePbxString, encodePbxString } from '../pbx-string';
import { encodeXmlAttr, insertDsymPostAction, removeDsymPostAction } from '../scheme';

const lines = (...parts: string[]): string => parts.join('\n');

/** The app file up to the finish hook, which other tests pin. */
function beforeHook(source: string): string {
  const at = source.indexOf('// bugsee-sourcemaps:');
  if (at < 0) {
    throw new Error('finish hook missing');
  }
  return source.slice(0, at);
}

const SYMBOL_BLOCK = (indent: string): string =>
  [
    "// bugsee-symbol-table: AGP defaults this to NONE, so the plugin's native upload finds",
    '// nothing and skips. SYMBOL_TABLE emits symbols for code this app',
    '// builds. Maven Hermes and libreactnative.so are pre-stripped;',
    '// this level does not symbolicate those two.',
    'ndk {',
    "    debugSymbolLevel 'SYMBOL_TABLE'",
    '}',
  ]
    .map((line) => indent + line)
    .join('\n');

const HERMES_COMMAND =
  'hermesCommand = new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/scripts/hermesc-preserve-js.sh"';

describe('ensureMavenCentral, exactly', () => {
  const header = lines(
    'pluginManagement {',
    '    repositories {',
    '        gradlePluginPortal()',
    '        google()',
    '        mavenCentral()',
    '    }',
    '}',
    '',
  );

  it('prepends a pluginManagement block when there is none, whatever other blocks exist', () => {
    expect(ensureMavenCentral('plugins { id("x") }\n')).toBe(`${header}plugins { id("x") }\n`);
    // The word alone, with no block after it, is not a block.
    expect(ensureMavenCentral('include ":app"\n// pluginManagement\n')).toBe(
      `${header}include ":app"\n// pluginManagement\n`,
    );
  });

  it('adds mavenCentral after the last repository, keeping the closing brace on its line', () => {
    expect(
      ensureMavenCentral(lines('pluginManagement {', '    repositories {', '        google()', '    }', '}', '')),
    ).toBe(lines('pluginManagement {', '    repositories {', '        google()', '        mavenCentral()', '    }', '}', ''));
    // A one-line repositories block has no line to insert before: refused, not split.
    expect(() => ensureMavenCentral('pluginManagement { repositories { google() } }\n')).toThrow(
      `${CANNOT_EDIT} android/settings.gradle: line 1: \`pluginManagement { repositories { google() } }\` shares its line with other code, so mavenCentral() cannot be added without rewriting that line. Put the brace alone on its line, or add mavenCentral() to pluginManagement.repositories yourself, then run expo prebuild again`,
    );
    // The entry's indentation is kept, and a trailing comment on the closer is fine.
    expect(ensureMavenCentral(lines('pluginManagement {', '  repositories {', '\tgoogle()', '  } // repos', '}', ''))).toBe(
      lines('pluginManagement {', '  repositories {', '\tgoogle()', '\tmavenCentral()', '  } // repos', '}', ''),
    );
  });

  it('adds a repositories block to a pluginManagement without one', () => {
    expect(ensureMavenCentral(lines('pluginManagement {', '    includeBuild("x")', '}', ''))).toBe(
      lines(
        'pluginManagement {',
        '    includeBuild("x")',
        '',
        '    repositories {',
        '        gradlePluginPortal()',
        '        google()',
        '        mavenCentral()',
        '    }',
        '}',
        '',
      ),
    );
  });

  it('leaves a block that already has mavenCentral, and only looks inside pluginManagement', () => {
    const has = 'pluginManagement {\n    repositories { mavenCentral ( ) }\n}\n';
    expect(ensureMavenCentral(has)).toBe(has);
    const outside = 'pluginManagement {\n    repositories {\n        google()\n    }\n}\nrepositories { mavenCentral() }\n';
    expect(ensureMavenCentral(outside)).toBe(
      'pluginManagement {\n    repositories {\n        google()\n        mavenCentral()\n    }\n}\nrepositories { mavenCentral() }\n',
    );
    // A one-line repositories block inside pluginManagement is refused even with mavenCentral elsewhere.
    expect(() => ensureMavenCentral('pluginManagement {\n    repositories { google() }\n}\nrepositories { mavenCentral() }\n')).toThrow(
      `${CANNOT_EDIT} android/settings.gradle: line 2:`,
    );
  });

  it('adds a repositories block only before a pluginManagement closer that stands alone', () => {
    expect(ensureMavenCentral(lines('pluginManagement {', '  includeBuild("x")', '  }', ''))).toBe(
      lines('pluginManagement {', '  includeBuild("x")', '', '  repositories {', '      gradlePluginPortal()', '      google()', '      mavenCentral()', '  }', '  }', ''),
    );
    expect(() => ensureMavenCentral('pluginManagement { includeBuild("x") }\n')).toThrow(
      `${CANNOT_EDIT} android/settings.gradle: line 1: \`pluginManagement { includeBuild("x") }\` shares its line with other code, so a repositories block with mavenCentral() cannot be added without rewriting that line. Put the brace alone on its line, or add repositories { mavenCentral() } to pluginManagement yourself, then run expo prebuild again`,
    );
    expect(() => ensureMavenCentral('pluginManagement {\n    includeBuild("x") }\n')).toThrow(
      `${CANNOT_EDIT} android/settings.gradle: line 2: \`includeBuild("x") }\` shares its line with other code`,
    );
  });

  it('refuses an unclosed pluginManagement rather than guess', () => {
    expect(() => ensureMavenCentral('pluginManagement {\n')).toThrow(
      `${CANNOT_EDIT} android/settings.gradle: line 1: a brace opened on this line never closes. Fix that line, or make the Bugsee edits by hand`,
    );
  });
});

describe('ensureGradlePluginDeclared, exactly', () => {
  const declaration = "plugins {\n    id 'com.bugsee.android.gradle' version '4.0.7' apply false\n}\n";

  it('declares the plugin right after buildscript, or first when there is none', () => {
    expect(
      ensureGradlePluginDeclared('buildscript {\n  repositories { google() }\n}\napply plugin: "x"\n', '4.0.7'),
    ).toBe(`buildscript {\n  repositories { google() }\n}\n${declaration}\napply plugin: "x"\n`);
    expect(ensureGradlePluginDeclared('apply plugin: "x"\n', '4.0.7')).toBe(`${declaration}\napply plugin: "x"\n`);
  });

  it('refuses a version that is not a plain version string, as a refusal that names the option', () => {
    for (const bad of ['', '4.0.7 bad', 'bad 4.0.7', "4.0.7'", '4.0\n7']) {
      expect(() => ensureGradlePluginDeclared('', bad)).toThrow(
        `${CANNOT_EDIT} android/build.gradle: the gradlePluginVersion option "${bad}" is not a plain version string. Fix the option in the Expo config (the @bugsee/react-native plugin entry), then run expo prebuild again`,
      );
    }
    expect(ensureGradlePluginDeclared('', 'A-z_0.9+1')).toContain("version 'A-z_0.9+1'");
    expect(() => ensureAppAppliesPlugin('', '7.4.0"; evil')).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: the NDK artifact version "7.4.0"; evil" (native-versions.json android.sdk) is not a plain version string. Fix the baked version, then run expo prebuild again`,
    );
  });

  it('declares the plugin only after a buildscript closer that stands alone, at its indentation', () => {
    expect(ensureGradlePluginDeclared('buildscript {\n  ext { x = 1 }\n  } // end\nallprojects { }\n', '1.0')).toBe(
      "buildscript {\n  ext { x = 1 }\n  } // end\n  plugins {\n      id 'com.bugsee.android.gradle' version '1.0' apply false\n  }\n\nallprojects { }\n",
    );
    expect(() => ensureGradlePluginDeclared('buildscript { ext { x = 1 } }; allprojects { }\n', '1.0')).toThrow(
      `${CANNOT_EDIT} android/build.gradle: line 1: \`buildscript { ext { x = 1 } }; allprojects { }\` shares its line with other code, so the plugins block that declares the Bugsee Gradle plugin cannot be added without rewriting that line. Put the brace alone on its line, or declare \`id 'com.bugsee.android.gradle' version '1.0' apply false\` in a plugins block yourself, then run expo prebuild again`,
    );
  });
});

describe('ensureAppAppliesPlugin, exactly', () => {
  const ndkLine = '    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk';
  const ndkBlock = `dependencies { // bugsee:ndk\n${ndkLine}\n}`;
  const exclude = lines(
    'configurations.configureEach {',
    "    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'",
    '}',
  );

  it('applies the plugin first when there is no React plugin line, and adds dependencies', () => {
    expect(beforeHook(ensureAppAppliesPlugin('android {\n}\n', '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid {\n}\n\n${ndkBlock}\n\n`,
    );
  });

  it('applies the plugin after the React plugin and puts the NDK line first in dependencies', () => {
    expect(
      beforeHook(
        ensureAppAppliesPlugin(
          'apply plugin: "com.facebook.react"\ndependencies {\n    implementation("a")\n}\n',
          '7.3.0',
        ),
      ),
    ).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n    implementation("a")\n}\n\n`,
    );
  });

  it('swaps the NDK line for an exclude block when native crash reporting is off', () => {
    // In the user's block: the line goes, the block stays.
    expect(
      beforeHook(ensureAppAppliesPlugin(`apply plugin: "com.facebook.react"\ndependencies {\n${ndkLine}\n}\n`, null)),
    ).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n}\n\n${exclude}\n\n`,
    );
    // In the block the plugin appended: the block goes with it, blank line included.
    expect(
      beforeHook(ensureAppAppliesPlugin(`apply plugin: "com.facebook.react"\nandroid { }\n\n${ndkBlock}\n`, null)),
    ).toBe(`apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\nandroid { }\n\n${exclude}\n\n`);
    // Unless the user put something of their own into it.
    const shared = `apply plugin: "com.facebook.react"\n\ndependencies { // bugsee:ndk\n${ndkLine}\n    implementation("mine")\n}\n`;
    expect(beforeHook(ensureAppAppliesPlugin(shared, null))).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\n\ndependencies { // bugsee:ndk\n    implementation("mine")\n}\n\n${exclude}\n\n`,
    );
  });

  it('removes an exclude block with a whitespace-only line before it as its blank line', () => {
    expect(beforeHook(ensureAppAppliesPlugin(`apply plugin: "com.bugsee.android.gradle"\na()\n   \n${exclude}\n`, '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\na()\n\n${ndkBlock}\n\n`,
    );
  });

  it('removes an exclude block wherever it sits, with the one blank line it brought', () => {
    const expected = `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n\n`;
    const body = 'apply plugin: "com.facebook.react"\ndependencies {\n}\n';
    // Blank lines after a block at the file start are the user's.
    expect(beforeHook(ensureAppAppliesPlugin(`${exclude}\n\n\n${body}`, '7.3.0'))).toBe(`\n\n${expected}`);
    expect(beforeHook(ensureAppAppliesPlugin(`${body}${exclude}`, '7.3.0'))).toBe(expected);
    // The file's own trailing blank line stays.
    expect(beforeHook(ensureAppAppliesPlugin(`${body}\n${exclude}\n\n`, '7.3.0'))).toBe(`${expected}\n`);
    const middle = ensureAppAppliesPlugin(`${body}\n${exclude}\n\n// tail\n`, '7.3.0');
    expect(beforeHook(middle)).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n\n// tail\n\n`,
    );
  });

  it('rewrites every hermesCommand assignment but not a commented one', () => {
    const source = 'react {\n    hermesCommand = "$rootDir/x"\n\thermesCommand="y"\n    // hermesCommand = "z"\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(source, '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nreact {\n    ${HERMES_COMMAND}\n\t${HERMES_COMMAND}\n    // hermesCommand = "z"\n}\n\n${ndkBlock}\n\n`,
    );
    const already = `apply plugin: "com.bugsee.android.gradle"\nreact {\n    hermesCommand = "/custom/hermesc-preserve-js.sh"\n}\n`;
    expect(beforeHook(ensureAppAppliesPlugin(already, null))).toContain('hermesCommand = "/custom/hermesc-preserve-js.sh"');
  });

  it('adds the symbol block to debug and release only, as a nested-brace-safe last entry', () => {
    const source = lines(
      'android {',
      '    buildTypes {',
      '        debug {',
      '            ext { flag = true }',
      '        }',
      '        staging {',
      '            minifyEnabled true',
      '        }',
      '        release {',
      '            minifyEnabled true',
      '        }',
      '    }',
      '}',
      'dependencies {',
      '}',
      '',
    );
    const on = ensureAppAppliesPlugin(source, '7.3.0');
    expect(beforeHook(on)).toBe(
      lines(
        'apply plugin: "com.bugsee.android.gradle"',
        'android {',
        '    buildTypes {',
        '        debug {',
        '            ext { flag = true }',
        SYMBOL_BLOCK('            '),
        '        }',
        '        staging {',
        '            minifyEnabled true',
        '        }',
        '        release {',
        '            minifyEnabled true',
        SYMBOL_BLOCK('            '),
        '        }',
        '    }',
        '}',
        'dependencies {',
        ndkLine,
        '}',
        '',
        '',
      ),
    );
    const off = ensureAppAppliesPlugin(on, null);
    // The hook already ends the file, so the exclude block goes after it.
    expect(off.endsWith(`\n\n${exclude}\n`)).toBe(true);
    expect(beforeHook(off)).toBe(
      lines(
        'apply plugin: "com.bugsee.android.gradle"',
        'android {',
        '    buildTypes {',
        '        debug {',
        '            ext { flag = true }',
        '        }',
        '        staging {',
        '            minifyEnabled true',
        '        }',
        '        release {',
        '            minifyEnabled true',
        '        }',
        '    }',
        '}',
        'dependencies {',
        '}',
        '',
        '',
      ),
    );
  });

  it('rewrites only its own marked NDK line; a user NDK line is left alone, on or off, and noted', () => {
    const own = `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n  implementation "com.bugsee:bugsee-android-ndk:1.0.0"   // bugsee:ndk\n    implementation("a")\n}\n`;
    expect(beforeHook(ensureAppAppliesPlugin(own, '7.3.0'))).toBe(
      'apply plugin: "com.bugsee.android.gradle"\ndependencies {\n  implementation "com.bugsee:bugsee-android-ndk:7.3.0"   // bugsee:ndk\n    implementation("a")\n}\n\n',
    );
    const quiet = jest.fn();
    ensureAppAppliesPlugin(own, '7.3.0', quiet);
    ensureAppAppliesPlugin(own, null, quiet);
    expect(quiet).not.toHaveBeenCalled();
    const pinned = 'apply plugin: "com.bugsee.android.gradle"\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:1.0.0" // pinned\n    implementation("a")\n}\n';
    const log = jest.fn();
    expect(beforeHook(ensureAppAppliesPlugin(pinned, '7.3.0', log))).toBe(`${pinned}\n`);
    expect(beforeHook(ensureAppAppliesPlugin(pinned, null, log))).toBe(`${pinned}\n${exclude}\n\n`);
    expect(log.mock.calls).toEqual([
      ['@bugsee/react-native: android/app/build.gradle declares com.bugsee:bugsee-android-ndk itself; the plugin leaves that line alone and does not add or remove its own'],
      ['@bugsee/react-native: android/app/build.gradle declares com.bugsee:bugsee-android-ndk itself; the plugin leaves that line alone and does not add or remove its own'],
    ]);
    // The user's artifact in a string anywhere, in any quoting, counts as theirs.
    const quoted = "apply plugin: \"com.bugsee.android.gradle\"\ndef ndk = 'com.bugsee:bugsee-android-ndk:2.0.0'\ndependencies {\n    implementation(ndk)\n}\n";
    expect(beforeHook(ensureAppAppliesPlugin(quoted, '7.3.0', log))).toBe(`${quoted}\n`);
    // A commented-out NDK line is not the dependency: a live one is added.
    const commented = 'apply plugin: "com.bugsee.android.gradle"\ndependencies {\n    // implementation "com.bugsee:bugsee-android-ndk:1.0.0"\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(commented, '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n    // implementation "com.bugsee:bugsee-android-ndk:1.0.0"\n}\n\n`,
    );
    // The plugin's line never carries any other comment, so a marker-less line with the artifact is the user's.
    const unmarked = `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:1.0.0"\n}\n`;
    expect(beforeHook(ensureAppAppliesPlugin(unmarked, '7.3.0', () => undefined))).toBe(`${unmarked}\n`);
  });

  it('inserts the NDK line after a dependencies opener that stands alone, at the block\'s own indentation', () => {
    const tabs = 'apply plugin: "com.bugsee.android.gradle"\ndependencies { // keep sorted\n\timplementation("a")\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(tabs, '7.3.0'))).toBe(
      'apply plugin: "com.bugsee.android.gradle"\ndependencies { // keep sorted\n\timplementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk\n\timplementation("a")\n}\n\n',
    );
    for (const opener of ['dependencies { implementation("a") }', 'dependencies { implementation("a")\n}', 'foo { }; dependencies {\n}']) {
      expect(() => ensureAppAppliesPlugin(`${opener}\n`, '7.3.0')).toThrow(
        `${CANNOT_EDIT} android/app/build.gradle: line 1: \`${opener.split('\n')[0]}\` shares its line with other code, so the Bugsee NDK dependency cannot be added without rewriting that line. Put the brace alone on its line, or declare \`implementation "com.bugsee:bugsee-android-ndk:7.3.0"\` yourself, then run expo prebuild again`,
      );
    }
  });

  it('refuses a one-line build type rather than split the user line', () => {
    const oneLine = 'android {\n    buildTypes {\n        release { minifyEnabled true }\n    }\n}\n';
    expect(() => ensureAppAppliesPlugin(oneLine, '7.3.0')).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 3: \`release { minifyEnabled true }\` shares its line with other code, so debugSymbolLevel 'SYMBOL_TABLE' for the release build type cannot be added without rewriting that line. Put the brace alone on its line, or set ndk { debugSymbolLevel 'SYMBOL_TABLE' } in it yourself, then run expo prebuild again`,
    );
    // A closer that shares its line with code, or follows a comment on its line, is no anchor either.
    expect(() => ensureAppAppliesPlugin('android {\n    buildTypes {\n        release {\n            minifyEnabled true }\n    }\n}\n', '7.3.0')).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 4: \`minifyEnabled true }\` shares its line with other code`,
    );
    expect(() => ensureAppAppliesPlugin('android {\n    buildTypes {\n        release {\n            /* end */ }\n    }\n}\n', '7.3.0')).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 4: \`/* end */ }\` shares its line with other code`,
    );
    // Off has nothing to add, so nothing to refuse.
    expect(beforeHook(ensureAppAppliesPlugin(oneLine, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${oneLine}\n${exclude}\n\n`,
    );
    // The block goes right before the closer; the user's blank line stays where it was.
    const spaced = 'android {\n    buildTypes {\n        release {\n            minifyEnabled true\n\n        }\n    }\n}\n';
    expect(ensureAppAppliesPlugin(spaced, '7.3.0')).toContain(
      `            minifyEnabled true\n\n${SYMBOL_BLOCK('            ')}\n        }\n`,
    );
  });

  it('takes only the build types directly under buildTypes', () => {
    const nested = 'android {\n    buildTypes {\n        debug {\n            release { }\n        }\n    }\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(nested, '7.3.0'))).toBe(
      lines(
        'apply plugin: "com.bugsee.android.gradle"',
        'android {',
        '    buildTypes {',
        '        debug {',
        '            release { }',
        SYMBOL_BLOCK('            '),
        '        }',
        '    }',
        '}',
        '',
        'dependencies { // bugsee:ndk',
        ndkLine,
        '}',
        '',
        '',
      ),
    );
  });

  it('leaves build types that already set a symbol level or have an ndk block', () => {
    const source = lines(
      'android {',
      '    buildTypes {',
      '        debug {',
      '            ndk.debugSymbolLevel "SYMBOL_TABLE"',
      '        }',
      '        release {',
      '            ndk{ abiFilters "arm64-v8a" }',
      '        }',
      '    }',
      '}',
      '',
    );
    expect(beforeHook(ensureAppAppliesPlugin(source, '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${source}\n${ndkBlock}\n\n`,
    );
  });

  it('removes exactly its own symbol block, at any indentation, and nothing after it', () => {
    const block = SYMBOL_BLOCK('      ');
    const file = `a()\n${block}\nb()\n`;
    expect(beforeHook(ensureAppAppliesPlugin(file, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\na()\nb()\n\n${exclude}\n\n`,
    );
    // Comment lines that only resemble the marker, or a different block after it, are the user's.
    const kept = '// bugsee-symbol-table: a comment, no block\nother()\n';
    expect(beforeHook(ensureAppAppliesPlugin(kept, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${kept}\n${exclude}\n\n`,
    );
    const marker = SYMBOL_BLOCK('').split('\n')[0] as string;
    const orphan = `a()\n${marker}\nndk {\n    abiFilters "arm64-v8a"\n}\nb()\n`;
    expect(beforeHook(ensureAppAppliesPlugin(orphan, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\na()\nndk {\n    abiFilters "arm64-v8a"\n}\nb()\n\n${exclude}\n\n`,
    );
    // Only the matching marker lines go when the block stops matching among the comments.
    const twoLines = `a()\n${SYMBOL_BLOCK('').split('\n').slice(0, 2).join('\n')}\nndk {\n}\n`;
    expect(beforeHook(ensureAppAppliesPlugin(twoLines, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\na()\nndk {\n}\n\n${exclude}\n\n`,
    );
    // A user line inside the block makes the plugin refuse, never delete.
    const edited = `a()\n${SYMBOL_BLOCK('').replace("    debugSymbolLevel 'SYMBOL_TABLE'", "    debugSymbolLevel 'SYMBOL_TABLE'\n    abiFilters \"arm64-v8a\"")}\n`;
    expect(() => ensureAppAppliesPlugin(edited, null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 2: the Bugsee symbol-table block that starts here has been changed inside, so the plugin cannot tell its lines from yours. Restore the block as the plugin wrote it, or remove it and set ndk { debugSymbolLevel } yourself, then run expo prebuild again`,
    );
    // On, an edited block still counts as the level being set.
    expect(ensureAppAppliesPlugin(`android {\n    buildTypes {\n        release {\n${SYMBOL_BLOCK('            ').replace("'SYMBOL_TABLE'", "'FULL'")}\n        }\n    }\n}\n`, '7.3.0')).not.toContain("'SYMBOL_TABLE'");
  });

  it('keeps a user afterEvaluate block and adds the hook after it', () => {
    const user = 'android {\n}\nafterEvaluate {\n    println("mine")\n}\n';
    const next = ensureAppAppliesPlugin(user, null);
    expect(next.startsWith(`apply plugin: "com.bugsee.android.gradle"\n${user}`)).toBe(true);
    expect(next.match(/afterEvaluate \{/g)).toHaveLength(1);
    expect(next.endsWith('scripts/bugsee-sourcemaps.gradle")\n')).toBe(true);
  });

  it('replaces a legacy hook in place, and takes one only with its def bugseeHermesSourcemaps line', () => {
    const marker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
    const fresh = ensureAppAppliesPlugin('android { }\n', null);
    const hook = fresh.slice(fresh.indexOf('// bugsee-sourcemaps:'));
    const legacy = `${marker}\ndef bugseeHermesSourcemaps = "x"\nafterEvaluate {\n    old()\n}\n`;
    expect(ensureAppAppliesPlugin(`android { }\n${legacy}`, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n${hook}\n${exclude}\n`,
    );
    // Without that line the block is the user's: only the stray marker goes.
    const user = 'afterEvaluate {\n    old()\n}\n';
    expect(ensureAppAppliesPlugin(`android { }\n${marker}\n${user}`, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n${user}\n${exclude}\n\n${hook}`,
    );
    // An unclosed block is refused, never cut.
    expect(() => ensureAppAppliesPlugin(`android { }\n${marker}\nafterEvaluate {\n`, null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 3: a brace opened on this line never closes`,
    );
  });
});

describe('ensureSymbolUploads, exactly', () => {
  const block = lines(
    '// bugsee-upload-symbols-off: uploadSymbols is false in the Expo config. The Bugsee',
    '// Gradle plugin 4.0.7 has no switch for its mapping, NDK symbol and build',
    '// uploads, so their tasks are turned off here.',
    "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
  );

  it('appends after one blank line, keeps the file\'s own blank lines, and removes back to the original', () => {
    expect(ensureSymbolUploads('a()\n', false)).toBe(`a()\n\n${block}\n`);
    expect(ensureSymbolUploads('a()\n\n\n', false)).toBe(`a()\n\n\n\n${block}\n`);
    expect(ensureSymbolUploads(`a()\n\n${block}\n`, true)).toBe('a()\n');
    expect(ensureSymbolUploads(`a()\n\n\n\n${block}\n`, true)).toBe('a()\n\n\n');
    // Only the one blank line before the block goes with it.
    expect(ensureSymbolUploads(`a()\n\n${block}\n\n\nb()\n`, true)).toBe('a()\n\n\nb()\n');
  });
});

describe('bundle phase, exactly', () => {
  it('refuses a with-environment phase that does not run react-native-xcode.sh', () => {
    expect(() => rewriteBundlePhase('"$WITH_ENVIRONMENT" other.sh\n# with-environment.sh\n')).toThrow(
      'cannot be wired',
    );
  });

  it('refuses a project without the objects or the section', () => {
    const missing = 'PBXShellScriptBuildPhase is missing from the Xcode project';
    for (const project of [{}, { hash: {} }, { hash: { project: {} } }, { hash: { project: { objects: {} } } }]) {
      expect(() => rewriteProjectBundlePhase(project as XcodeProjectLike)).toThrow(missing);
    }
  });

  it('keeps an unquoted script unquoted even when it ends in a quote', () => {
    const script = 'set -e\nWITH_ENVIRONMENT="x/with-environment.sh"\nREACT_NATIVE_XCODE="x/react-native-xcode.sh"';
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {
              A: { name: 'Bundle React Native code and images', shellScript: script },
            },
          },
        },
      },
    };
    rewriteProjectBundlePhase(project);
    expect(project.hash.project.objects.PBXShellScriptBuildPhase.A.shellScript).toBe(rewriteBundlePhase(script));
  });
});

describe('pbx strings, exactly', () => {
  it('decodes every escape and leaves an unquoted or half-quoted value alone', () => {
    expect(decodePbxString('"a\\nb\\rc\\td\\"e\\\\f\\qg"')).toBe('a\nb\rc\td"e\\fqg');
    expect(decodePbxString('"trailing\\\\"')).toBe('trailing\\');
    expect(decodePbxString('"lone\\"')).toBe('lone\\');
    expect(decodePbxString('plain')).toBe('plain');
    expect(decodePbxString('"half')).toBe('"half');
    expect(decodePbxString('half"')).toBe('half"');
    expect(decodePbxString('""')).toBe('');
    // An escaped real newline or tab is that character.
    expect(decodePbxString('"a\\\nb\\\tc"')).toBe('a\nb\tc');
  });

  it('encodes every escape and round-trips', () => {
    expect(encodePbxString('a\nb\rc\td"e\\f')).toBe('"a\\nb\\rc\\td\\"e\\\\f"');
    const value = 'x\r\n\t"\\ y';
    expect(decodePbxString(encodePbxString(value))).toBe(value);
  });
});

describe('scheme XML, exactly', () => {
  const ref = (name: string, spacing = ' = '): string =>
    [
      '            <BuildableReference',
      '               BuildableIdentifier = "primary"',
      `               BuildableName${spacing}"${name}"`,
      '               BlueprintName = "App">',
      '            </BuildableReference>',
    ].join('\n');
  const scheme = (archiveBody: string, name = 'App.app', spacing = ' = '): string =>
    [
      '<Scheme>',
      '   <BuildAction>',
      ref(name, spacing),
      '   </BuildAction>',
      '   <ArchiveAction',
      '      buildConfiguration = "Release">',
      archiveBody,
      '   </ArchiveAction>',
      '</Scheme>',
      '',
    ].join('\n');
  const action = (refName = 'App.app', spacing = ' = '): string =>
    [
      '         <ExecutionAction',
      '            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">',
      '            <ActionContent',
      '               title = "Upload dSYMs"',
      `               scriptText = "${encodeXmlAttr('echo xcode post-action')}">`,
      '               <EnvironmentBuildable>',
      [
        '                  <BuildableReference',
        '                     BuildableIdentifier = "primary"',
        `                     BuildableName${spacing}"${refName}"`,
        '                     BlueprintName = "App">',
        '                  </BuildableReference>',
      ].join('\n'),
      '               </EnvironmentBuildable>',
      '            </ActionContent>',
      '         </ExecutionAction>',
    ].join('\n');

  it('escapes every XML-special character', () => {
    expect(encodeXmlAttr('a&b"c<d>e\rf\ng\'h')).toBe('a&amp;b&quot;c&lt;d&gt;e&#13;f&#10;g\'h');
  });

  it('wraps the action in PostActions, or appends it inside an existing one', () => {
    const empty = scheme('');
    const inserted = insertDsymPostAction(empty, 'echo xcode post-action');
    expect(inserted).toBe(scheme(['', '      <PostActions>', action(), '      </PostActions>'].join('\n')));
    expect(removeDsymPostAction(inserted)).toBe(empty);
    const sibling = ['      <PostActions attr = "1">', '         <ExecutionAction>other</ExecutionAction>', '      </PostActions>'].join(
      '\n',
    );
    expect(insertDsymPostAction(scheme(sibling), 'echo xcode post-action')).toBe(
      scheme(
        ['      <PostActions attr = "1">', '         <ExecutionAction>other</ExecutionAction>', action(), '      </PostActions>'].join(
          '\n',
        ),
      ),
    );
  });

  it('finds the .app reference however its attribute is spaced', () => {
    expect(insertDsymPostAction(scheme('', 'App.app', '='), 'echo xcode post-action')).toContain(
      'BuildableName="App.app"',
    );
    expect(() => insertDsymPostAction(scheme('', 'App.framework'), 'x')).toThrow(
      'scheme has no .app BuildableReference',
    );
    expect(() => insertDsymPostAction('<Scheme>\n</Scheme>\n', 'x')).toThrow('ArchiveAction missing');
    expect(() => insertDsymPostAction('<Scheme><ArchiveAction></ArchiveAction></Scheme>', 'x')).toThrow(
      'scheme has no .app BuildableReference',
    );
  });

  it('leaves a scheme without a Bugsee action as it was, empty PostActions included', () => {
    const userEmpty = scheme('      <PostActions>\n      </PostActions>');
    expect(removeDsymPostAction(userEmpty)).toBe(userEmpty);
    expect(removeDsymPostAction('<Scheme/>')).toBe('<Scheme/>');
  });
});

describe('Archive post-action script', () => {
  const fixtures = join(__dirname, 'fixtures');

  it('is the reviewed script, with and without a baked token', () => {
    expect(DSYM_POST_ACTION_SCRIPT).toBe(readFileSync(join(fixtures, 'dsym-post-action.sh'), 'utf8'));
    expect(dsymPostActionScript('3f2a9c1e-0000-4abc-8def-5ca1ab1e0002')).toBe(
      readFileSync(join(fixtures, 'dsym-post-action-baked.sh'), 'utf8'),
    );
  });

  it('prefers the native binary, passes its exit code through, and fails without a CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-dsym-native-'));
    try {
      const write = (file: string, text: string): void => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      };
      write(join(dir, 'node_modules/@bugsee/react-native/package.json'), '{"name":"@bugsee/react-native"}');
      const cliDir = join(dir, 'node_modules/@bugsee/cli');
      write(join(cliDir, 'package.json'), JSON.stringify({ name: '@bugsee/cli', bin: { 'bugsee-cli': 'bin/cli.js' } }));
      write(join(cliDir, 'bin/cli.js'), 'process.exit(9);\n');
      mkdirSync(join(dir, 'ios'));
      const run = () =>
        spawnSync('/bin/sh', ['-c', DSYM_POST_ACTION_SCRIPT], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', BUGSEE_ENDPOINT: 'http://127.0.0.1:9', PROJECT_DIR: join(dir, 'ios'), NODE_BINARY: process.execPath },
        });
      expect(run().status).toBe(9);

      const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
      const nativeName = arch === 'x86_64' ? '@bugsee/cli-darwin-x64' : '@bugsee/cli-darwin-arm64';
      const nativeDir = join(cliDir, 'node_modules', nativeName);
      write(join(nativeDir, 'package.json'), JSON.stringify({ name: nativeName }));
      write(join(nativeDir, 'bin/bugsee-cli'), '#!/bin/sh\necho "native $*"\nexit 7\n');
      chmodSync(join(nativeDir, 'bin/bugsee-cli'), 0o755);
      const native = run();
      expect(native.stdout).toBe('native xcode post-action\n');
      expect(native.status).toBe(7);

      rmSync(join(dir, 'node_modules/@bugsee/cli'), { recursive: true, force: true });
      const none = run();
      expect(none.status).toBe(1);
      expect(none.stderr).toBe('bugsee-cli: not found\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads node from .xcode.env when NODE_BINARY is not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-dsym-node-'));
    try {
      mkdirSync(join(dir, 'ios'));
      writeFileSync(join(dir, 'ios/.xcode.env'), `export NODE_BINARY=${process.execPath}\n`);
      const result = spawnSync('/bin/sh', ['-c', DSYM_POST_ACTION_SCRIPT], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', BUGSEE_ENDPOINT: 'http://127.0.0.1:9', PROJECT_DIR: join(dir, 'ios') },
      });
      // Node was found: the failure is the missing CLI, not a missing node.
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('bugsee-cli: not found\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('small guards', () => {
  it('writes no manifest token without one', () => {
    expect(manifestAutoLaunchToken({ autoLaunch: true })).toBeNull();
  });

  it('refuses a missing or incomplete baked versions file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-baked-'));
    try {
      const file = join(dir, 'native-versions.baked.json');
      expect(() => loadNativeVersions(dir)).toThrow(`baked native versions not found at ${file}`);
      for (const partial of [{ sdk: '1' }, { gradlePlugin: '1' }, {}]) {
        writeFileSync(file, JSON.stringify(partial));
        expect(() => loadNativeVersions(dir)).toThrow(`${file} is missing sdk or gradlePlugin`);
      }
      writeFileSync(file, JSON.stringify({ sdk: '1', gradlePlugin: '2' }));
      expect(loadNativeVersions(dir)).toEqual({ sdk: '1', gradlePlugin: '2' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('blocks found by keyword', () => {
  it('does not take another block for a missing one', () => {
    expect(ensureMavenCentral('pluginManagement {\n    plugins { id("x") }\n}\n')).toBe(
      lines(
        'pluginManagement {',
        '    plugins { id("x") }',
        '',
        '    repositories {',
        '        gradlePluginPortal()',
        '        google()',
        '        mavenCentral()',
        '    }',
        '}',
        '',
      ),
    );
    expect(ensureGradlePluginDeclared('allprojects { }\napply plugin: "x"\n', '1.0')).toBe(
      "plugins {\n    id 'com.bugsee.android.gradle' version '1.0' apply false\n}\n\nallprojects { }\napply plugin: \"x\"\n",
    );
  });

  it('inserts into a dependencies block at the very start of the file', () => {
    expect(
      beforeHook(ensureAppAppliesPlugin('dependencies {\n}\napply plugin: "com.facebook.react"\n', '7.3.0')),
    ).toBe(
      'dependencies {\n    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk\n}\napply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\n\n',
    );
  });

  it('keeps every trailing blank line and appends after them', () => {
    const ndkOn = ensureAppAppliesPlugin('android {\n}\n\n\n', '7.3.0');
    expect(beforeHook(ndkOn)).toBe(
      'apply plugin: "com.bugsee.android.gradle"\nandroid {\n}\n\n\n\ndependencies { // bugsee:ndk\n    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk\n}\n\n',
    );
    const ndkOff = ensureAppAppliesPlugin('android {\n}\n\n\n', null);
    expect(beforeHook(ndkOff)).toBe(
      "apply plugin: \"com.bugsee.android.gradle\"\nandroid {\n}\n\n\n\nconfigurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}\n\n",
    );
    // No final newline: one is added before the blank line.
    expect(beforeHook(ensureAppAppliesPlugin('android {\n}', null))).toBe(
      "apply plugin: \"com.bugsee.android.gradle\"\nandroid {\n}\n\nconfigurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}\n\n",
    );
  });

  it('finds a build type written without a space before its brace', () => {
    const next = ensureAppAppliesPlugin('android {\n    buildTypes {\n        debug{\n        }\n    }\n}\n', '7.3.0');
    expect(next).toContain("        debug{\n            // bugsee-symbol-table: ");
    expect(next).toContain("            ndk {\n                debugSymbolLevel 'SYMBOL_TABLE'\n            }\n        }\n    }\n}");
  });

  it('counts any whitespace before the symbol level as already set', () => {
    const source = "android {\n    buildTypes {\n        release {\n            ndk.debugSymbolLevel  'SYMBOL_TABLE'\n        }\n    }\n}\n";
    expect(beforeHook(ensureAppAppliesPlugin(source, '7.3.0'))).toContain(source);
    expect(ensureAppAppliesPlugin(source, '7.3.0')).not.toContain('bugsee-symbol-table:');
  });

  it('keeps a marker comment that ends the file', () => {
    const source = 'a()\n// bugsee-symbol-table: last';
    expect(beforeHook(ensureAppAppliesPlugin(source, null))).toBe(
      "apply plugin: \"com.bugsee.android.gradle\"\na()\n// bugsee-symbol-table: last\n\nconfigurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}\n\n",
    );
  });
});

describe('finish hook placement', () => {
  const marker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
  const exclude =
    "configurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}";
  let hook = '';
  beforeAll(() => {
    const fresh = ensureAppAppliesPlugin('x\n', null);
    hook = fresh.slice(fresh.indexOf('// bugsee-sourcemaps:'));
  });

  it('appends after a user afterEvaluate block and leaves it whole', () => {
    const user = 'android {\n}\nafterEvaluate {\n    println("mine")\n}\n';
    expect(ensureAppAppliesPlugin(user, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${user}\n${exclude}\n\n${hook}`,
    );
  });

  it('drops a marker with no afterEvaluate after it and appends the hook', () => {
    expect(ensureAppAppliesPlugin(`android { }\n${marker}\n`, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n\n${exclude}\n\n${hook}`,
    );
  });

  it('replaces a hook that starts the file', () => {
    const source = `${marker}\ndef bugseeHermesSourcemaps = "x"\nafterEvaluate {\n    old()\n}\napply plugin: "com.bugsee.android.gradle"\n`;
    expect(ensureAppAppliesPlugin(source, null)).toBe(
      `${hook}apply plugin: "com.bugsee.android.gradle"\n\n${exclude}\n`,
    );
  });

  it('drops a stray legacy marker at the file start and keeps the user block after it', () => {
    const source = `${marker}\nafterEvaluate {\n    old()\n}\napply plugin: "com.bugsee.android.gradle"\n`;
    expect(ensureAppAppliesPlugin(source, null)).toBe(
      `afterEvaluate {\n    old()\n}\napply plugin: "com.bugsee.android.gradle"\n\n${exclude}\n\n${hook}`,
    );
  });
});

describe('symbol uploads block edges', () => {
  const block = lines(
    '// bugsee-upload-symbols-off: uploadSymbols is false in the Expo config. The Bugsee',
    '// Gradle plugin 4.0.7 has no switch for its mapping, NDK symbol and build',
    '// uploads, so their tasks are turned off here.',
    "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
  );

  it('handles the block at the start of the file and text right after it', () => {
    expect(ensureSymbolUploads(`${block}\n`, true)).toBe('');
    expect(ensureSymbolUploads(`${block}\n`, false)).toBe(`${block}\n`);
    // The last line has more after it, so it is not Bugsee's line: nothing is removed.
    expect(ensureSymbolUploads(`a()\n${block}b()\nc()\n`, true)).toBe(`a()\n${block}b()\nc()\n`);
  });
});

describe('scheme discovery', () => {
  let ios: string;

  beforeEach(() => {
    ios = mkdtempSync(join(tmpdir(), 'bugsee-schemes-'));
  });

  afterEach(() => {
    rmSync(ios, { recursive: true, force: true });
  });

  function touch(rel: string): string {
    const file = join(ios, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  }

  it('lists only .xcscheme files of .xcodeproj bundles', () => {
    const app = touch('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme');
    touch('App.xcodeproj/xcshareddata/xcschemes/notes.txt');
    touch('Other.folder/xcshareddata/xcschemes/Other.xcscheme');
    touch('Bare.xcodeproj/project.pbxproj');
    expect(listSchemes(ios)).toEqual([app]);
  });

  it('names the directory when there is no iOS project or no shared scheme', () => {
    expect(() => listSchemes(join(ios, 'missing'))).toThrow(`ios project not found at ${join(ios, 'missing')}`);
    try {
      listSchemes(join(ios, 'missing'));
    } catch (error) {
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
    touch('App.xcodeproj/project.pbxproj');
    expect(() => listSchemes(ios)).toThrow(`no shared xcscheme under ${ios}`);
  });
});

describe('baked versions error', () => {
  it('keeps the read error as its cause', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-baked-cause-'));
    try {
      loadNativeVersions(dir);
      throw new Error('did not throw');
    } catch (error) {
      expect((error as Error).message).toContain('baked native versions not found');
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('react.hermesCommand forms', () => {
  const rewritten = (indent: string): string => `${indent}${HERMES_COMMAND}`;

  it('rewrites a one-line setter call as well as an assignment', () => {
    const source = 'react {\n    hermesCommand.set("$rootDir/hermesc")\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(source, null))).toContain(`react {\n${rewritten('    ')}\n}`);
    const nested = 'react {\n    hermesCommand.set(file("x").absolutePath)\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(nested, null))).toContain(`react {\n${rewritten('    ')}\n}`);
  });

  it('refuses a value that continues on the next line, at prebuild', () => {
    for (const source of [
      'react {\n    hermesCommand = "$rootDir/" +\n        "hermesc"\n}\n',
      'react {\n    hermesCommand = new File(\n        "x").absolutePath\n}\n',
      'react {\n    hermesCommand.set(\n        "x")\n}\n',
      'react {\n    hermesCommand = [\n    "a"].join()\n}\n',
    ]) {
      expect(() => ensureAppAppliesPlugin(source, null)).toThrow(HERMES_COMMAND_UNREWRITABLE);
    }
    expect(HERMES_COMMAND_UNREWRITABLE).toContain('hermesc-preserve-js.sh');
    expect(HERMES_COMMAND_UNREWRITABLE.startsWith(`${CANNOT_EDIT} android/app/build.gradle: `)).toBe(true);
    // An unclosed quote is refused by the lexer, before any setting is read.
    expect(() => ensureAppAppliesPlugin("react {\n    hermesCommand = 'unclosed\n}\n", null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 2: a string opened on this line does not close on it`,
    );
  });

  it('accepts quotes and brackets that close on the same line', () => {
    const source = "react {\n    hermesCommand = ['a', \"b(\"].join('/') + \"\\\"x\\\"\"\n}\n";
    expect(beforeHook(ensureAppAppliesPlugin(source, null))).toContain(`react {\n${rewritten('    ')}\n}`);
  });

  it('adds the setting to a react block without one, and leaves a file without a react block', () => {
    expect(beforeHook(ensureAppAppliesPlugin('react {\n    debuggableVariants = []\n}\n', null))).toContain(
      `react {\n${rewritten('    ')}\n    debuggableVariants = []\n}`,
    );
    expect(beforeHook(ensureAppAppliesPlugin('  react {\n  }\n', null))).toContain(`  react {\n${rewritten('      ')}\n  }`);
    // Another word ending in "react" is not the block.
    expect(beforeHook(ensureAppAppliesPlugin('notreact {\n}\n', null))).not.toContain('hermesCommand');
    expect(beforeHook(ensureAppAppliesPlugin('android {\n}\n', null))).not.toContain('hermesCommand');
  });

  it('keeps a setting that already points at the wrapper, in either form', () => {
    for (const line of [
      '    hermesCommand = "/x/hermesc-preserve-js.sh"',
      '    hermesCommand.set("/x/hermesc-preserve-js.sh")',
    ]) {
      expect(beforeHook(ensureAppAppliesPlugin(`react {\n${line}\n}\n`, null))).toContain(`react {\n${line}\n}`);
    }
  });
});

describe('react.hermesCommand edge cases', () => {
  const rewritten = `    ${HERMES_COMMAND}`;
  const ndkLine = '    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk';

  it('reads an escaped quote as part of the string', () => {
    const source = 'react {\n    hermesCommand = "a\\"b"\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(source, null))).toContain(`react {\n${rewritten}\n}`);
  });

  it('refuses an unclosed bracket even without a trailing operator, and trailing spaces after one', () => {
    for (const source of [
      'react {\n    hermesCommand = foo(bar\n}\n',
      'react {\n    hermesCommand.set(foo\n}\n',
      'react {\n    hermesCommand = "a" +   \n        "b"\n}\n',
    ]) {
      expect(() => ensureAppAppliesPlugin(source, null)).toThrow(HERMES_COMMAND_UNREWRITABLE);
    }
  });

  it('finds a react block written without a space or with trailing spaces, not a one-line one', () => {
    expect(beforeHook(ensureAppAppliesPlugin('react{\n}\n', null))).toContain(`react{\n${rewritten}\n}`);
    expect(beforeHook(ensureAppAppliesPlugin('react {  \n}\n', null))).toContain(`react {  \n${rewritten}\n}`);
    const oneLine = 'react { debuggableVariants = [] }\n';
    expect(beforeHook(ensureAppAppliesPlugin(oneLine, null))).not.toContain('hermesCommand');
  });

  it('replaces a current hook at the very start or the very end of the file', () => {
    const fresh = ensureAppAppliesPlugin('dependencies {\n}\n', '7.3.0');
    const hook = fresh.slice(fresh.indexOf('// bugsee-sourcemaps:')).trimEnd();
    const head = `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n`;
    // At the end with no newline after it: replaced in place, nothing duplicated.
    const atEnd = `${head}\n${hook}`;
    expect(ensureAppAppliesPlugin(atEnd, '7.3.0')).toBe(atEnd);
    // First in the file.
    const atStart = `${hook}\n${head}`;
    expect(ensureAppAppliesPlugin(atStart, '7.3.0')).toBe(atStart);
  });

  it('keeps every trailing blank line and appends the hook after them', () => {
    const source = `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n\n\n\n`;
    const hook = (() => {
      const fresh = ensureAppAppliesPlugin('x\n', '7.3.0');
      return fresh.slice(fresh.indexOf('// bugsee-sourcemaps:'));
    })();
    expect(ensureAppAppliesPlugin(source, '7.3.0')).toBe(
      `apply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n\n\n\n\n${hook}`,
    );
  });
});

describe('react.hermesCommand: comments, strings and continuations', () => {
  const rewritten = `    ${HERMES_COMMAND}`;
  const rewrite = (source: string): string => beforeHook(ensureAppAppliesPlugin(source, null));

  it('refuses a leading-dot continuation and a value on the next line', () => {
    for (const source of [
      'react {\n    hermesCommand = file("x")\n        .absolutePath\n}\n',
      'react {\n    hermesCommand = file("x")\n\n        ?.absolutePath\n}\n',
      'react {\n    hermesCommand = "a"\n        + "b"\n}\n',
      'react {\n    hermesCommand =\n        "x"\n}\n',
      'react {\n    hermesCommand = // set below\n        "x"\n}\n',
      'react {\n    hermesCommand = "x" /* note\n    still a comment */\n}\n',
    ]) {
      expect(() => ensureAppAppliesPlugin(source, null)).toThrow(HERMES_COMMAND_UNREWRITABLE);
    }
  });

  it('reads past a trailing line or block comment, and keeps it', () => {
    expect(rewrite('react {\n    hermesCommand = "x" // don\'t touch (really\n}\n')).toContain(
      `react {\n${rewritten} // don't touch (really\n}`,
    );
    expect(rewrite('react {\n    hermesCommand = "x"\t/* it\'s fine */  \n}\n')).toContain(`react {\n${rewritten}\t/* it's fine */  \n}`);
    // Trailing whitespace after the value is kept too.
    expect(rewrite('react {\n    hermesCommand = "x"   \n}\n')).toContain(`react {\n${rewritten}   \n}`);
    expect(rewrite('react {\n    hermesCommand = "http://host/x" /* a */ + "y"\n}\n')).toContain(`react {\n${rewritten}\n}`);
    // A comment after the value does not hide a continuation.
    expect(() => ensureAppAppliesPlugin('react {\n    hermesCommand = "x" // c\n        .trim()\n}\n', null)).toThrow(
      HERMES_COMMAND_UNREWRITABLE,
    );
  });

  it('leaves the setting alone inside comments and multi-line strings', () => {
    for (const hidden of [
      '/*\n    hermesCommand = "a" +\n*/',
      '    /* hermesCommand = (\n       */',
      'def doc = """\n    hermesCommand = (\n"""',
      "def doc = '''\nhermesCommand.set(\n'''",
      '    // hermesCommand = (',
    ]) {
      const next = rewrite(`react {\n${hidden}\n}\n`);
      // Not refused, not rewritten in place; the real setting is added to the block.
      expect(next).toContain(hidden);
      expect(next).toContain(`react {\n${rewritten}\n${hidden}\n}`);
    }
  });

  it('finds a react block only in code', () => {
    expect(rewrite('/*\nreact {\n*/\nandroid { }\n')).not.toContain(HERMES_COMMAND);
    expect(rewrite('react { // the RN block\n}\n')).toContain(`react { // the RN block\n${rewritten}\n}`);
  });

  it('refuses a string that does not close on its line, whatever follows the quote', () => {
    const open = `${CANNOT_EDIT} android/app/build.gradle: line 2: a string opened on this line does not close on it`;
    expect(() => ensureAppAppliesPlugin('react {\n    hermesCommand = "x /* y */\n}\n', null)).toThrow(open);
    expect(() => ensureAppAppliesPlugin("react {\n    hermesCommand = 'x\n}\n", null)).toThrow(open);
    // A one-line string open at the end of the file.
    expect(() => ensureAppAppliesPlugin('react {\n}\ndef a = "x', null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 3: a string opened on this line does not close on it`,
    );
  });
});

describe('lexer and react block, exactly', () => {
  const rewritten = `    ${HERMES_COMMAND}`;
  const rewrite = (source: string): string => beforeHook(ensureAppAppliesPlugin(source, null));
  const applied = 'apply plugin: "com.bugsee.android.gradle"';

  it('returns to code after a multi-line string or a block comment closing at column 0', () => {
    expect(rewrite('def doc = """\nx\n"""\nreact {\n    hermesCommand = "a"\n}\n')).toContain(`react {\n${rewritten}\n}`);
    expect(rewrite("def doc = '''\nx\n'''\nreact {\n}\n")).toContain(`react {\n${rewritten}\n}`);
    expect(rewrite('/* c\n*/\nreact {\n    hermesCommand = "a"\n}\n')).toContain(`react {\n${rewritten}\n}`);
  });

  it('reads a one-line triple-quoted value as a value, and a comment as whitespace', () => {
    expect(rewrite('react {\n    hermesCommand = """x"""\n}\n')).toContain(`react {\n${rewritten}\n}`);
    expect(rewrite('react/* c */{\n}\n')).toContain(`react/* c */{\n${rewritten}\n}`);
    // Groovy reads a comment as whitespace: these are two tokens, not the setting.
    const split = 'react {\n    hermes/* x */Command = "y"\n}\n';
    expect(rewrite(split)).toContain(`react {\n${rewritten}\n    hermes/* x */Command = "y"\n}`);
  });

  it('does not close a block comment on its own opening slash', () => {
    expect(rewrite('/*/\nreact {\n*/\n')).not.toContain(HERMES_COMMAND);
  });

  it('finds a react block on the first line, and only the first react block', () => {
    expect(ensureAppAppliesPlugin(`react {\n}\n${applied}\n`, null).startsWith(`react {\n${rewritten}\n}\n`)).toBe(true);
    const two = rewrite('react {\n}\nreact {\n}\n');
    expect(two).toContain(`react {\n${rewritten}\n}\nreact {\n}`);
    expect(two.match(/hermesCommand =/g)).toHaveLength(1);
  });

  it('looks past whitespace-only lines for a continuation, and handles a file without a final newline', () => {
    expect(() => ensureAppAppliesPlugin('react {\n    hermesCommand = file("x")\n    \n        .absolutePath\n}\n', null)).toThrow(
      HERMES_COMMAND_UNREWRITABLE,
    );
    expect(ensureAppAppliesPlugin(`${applied}\nreact {\n    hermesCommand = "x"\n}`, null)).toContain(`react {\n${rewritten}\n}`);
    // Braces that do not balance are refused, with the line of the open brace.
    expect(() => ensureAppAppliesPlugin(`${applied}\nreact {\n    hermesCommand = "x"`, null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 2: a brace opened on this line never closes`,
    );
  });
});

describe('every internal error is a refusal', () => {
  const file = 'apply plugin: "com.bugsee.android.gradle"\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:1.0.0"\n}\n';

  it('turns an error thrown inside a transform into the standard refusal, and lets a refusal through', () => {
    expect(() =>
      ensureAppAppliesPlugin(file, '7.3.0', () => {
        throw new TypeError('boom');
      }),
    ).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: the plugin hit an internal error while reading it (boom). Report this with the file attached, or make the Bugsee edits by hand (package README, "Android source maps"), then run expo prebuild again`,
    );
    expect(() =>
      ensureAppAppliesPlugin(file, '7.3.0', () => {
        throw new Error(`${CANNOT_EDIT} android/app/build.gradle: passed through`);
      }),
    ).toThrow(new Error(`${CANNOT_EDIT} android/app/build.gradle: passed through`));
    expect(() =>
      ensureAppAppliesPlugin(file, '7.3.0', () => {
        throw 'not an error';
      }),
    ).toThrow('internal error while reading it (not an error)');
  });

  it('reads a comment between the operands of a division as ambiguous', () => {
    expect(() => ensureAppAppliesPlugin('def x = 4 /*c*/ / 2\n', null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 1: cannot tell whether the / starts a slashy string or divides. Fix that line`,
    );
    expect(() => ensureAppAppliesPlugin('def z = a$/2\n', null)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 1: cannot tell whether the / starts a slashy string or divides`,
    );
  });
});

describe('refusals name the construct left open', () => {
  const at = (reason: string): string =>
    `${CANNOT_EDIT} android/app/build.gradle: ${reason}. Fix that line, or make the Bugsee edits by hand (package README, "Android source maps"), then run expo prebuild again`;

  it('says which line opened what', () => {
    expect(() => ensureAppAppliesPlugin('a()\n/* open\nb()\n', null)).toThrow(at('line 2: a block comment opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('a()\ndef s = """\nopen\n', null)).toThrow(at('line 2: a string opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('def s = /open\n', null)).toThrow(at('line 1: a string opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('def s = $/open\n', null)).toThrow(at('line 1: a string opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('def s = "${open\n', null)).toThrow(at('line 1: a ${ interpolation opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('a()\n}\n', null)).toThrow(at('line 2: a closing brace has no opening brace'));
    expect(() => ensureAppAppliesPlugin('android {\n    x {\n}\n', null)).toThrow(at('line 1: a brace opened on this line never closes'));
    expect(() => ensureAppAppliesPlugin('def a = { 1 } / 2\n', null)).toThrow(at('line 1: cannot tell whether the / starts a slashy string or divides'));
    // A string open at the end of the file without a newline, with or without a trailing backslash.
    expect(() => ensureAppAppliesPlugin('def a = "x', null)).toThrow(at('line 1: a string opened on this line does not close on it'));
    expect(() => ensureAppAppliesPlugin('def a = "x\\', null)).toThrow(at('line 1: a string opened on this line does not close on it'));
  });
});

describe('hook lines, exactly', () => {
  const marker = '// bugsee-sourcemaps: debug ids and source-map upload for release bundles (@bugsee/react-native).';
  const legacyMarker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
  const applied = 'apply plugin: "com.bugsee.android.gradle"';
  const exclude = "configurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}";
  let hook = '';
  let apply = '';
  beforeAll(() => {
    const fresh = ensureAppAppliesPlugin('x\n', null);
    hook = fresh.slice(fresh.indexOf(marker)).trimEnd();
    apply = hook.split('\n')[1] as string;
  });

  it('drops a marker that ends the file, keeps a comment that only names the script', () => {
    const next = ensureAppAppliesPlugin(`${applied}\nx()\n// see scripts/bugsee-sourcemaps.gradle\n${marker}`, null);
    expect(next).toContain('x()\n// see scripts/bugsee-sourcemaps.gradle\n');
    expect(next.split('\n').filter((line) => line === marker)).toHaveLength(1);
    expect(next.endsWith(`${hook}\n`)).toBe(true);
  });

  it('takes an indented apply line after the marker as the hook', () => {
    const source = `${applied}\nx()\n${marker}\n    ${apply.trim()}\ny()\n`;
    const next = ensureAppAppliesPlugin(source, null);
    expect(next.startsWith(`${applied}\nx()\n${hook}\ny()\n`)).toBe(true);
  });

  it('keeps the hook where the first complete one was', () => {
    const legacy = `${legacyMarker}\ndef bugseeHermesSourcemaps = "x"\nafterEvaluate {\n    old()\n}`;
    const source = `${applied}\na()\n${legacy}\nb()\n${hook}\nc()\n`;
    expect(ensureAppAppliesPlugin(source, null).startsWith(`${applied}\na()\n${hook}\nb()\nc()\n`)).toBe(true);
    // A hook first in the file stays first.
    const first = `${hook}\na()\n${hook}\n${applied}\n`;
    expect(ensureAppAppliesPlugin(first, null).startsWith(`${hook}\na()\n${applied}\n`)).toBe(true);
  });

  it('drops a marker that is the last line when nothing is appended after it', () => {
    // NDK on with its line present and no build types: the hook step sees the marker last.
    const ndk = '    implementation "com.bugsee:bugsee-android-ndk:7.3.0"';
    const source = `${applied}\ndependencies {\n${ndk}\n}\n${marker}`;
    expect(ensureAppAppliesPlugin(source, '7.3.0')).toBe(`${applied}\ndependencies {\n${ndk}\n}\n\n${hook}\n`);
  });

  it('reads a marker followed only by comment lines to the end of the file', () => {
    const legacy = `${applied}\nx()\n${legacyMarker}\n// one\n// two`;
    expect(ensureAppAppliesPlugin(legacy, '7.3.0')).toContain(`x()\n// one\n// two\n`);
    const symbol = `${applied}\nx()\n// bugsee-symbol-table: x\n// more`;
    expect(ensureAppAppliesPlugin(symbol, null)).toContain(`x()\n// bugsee-symbol-table: x\n// more\n`);
    // With nothing appended before the hook step, the comments really are the last lines.
    const ndk = '    implementation "com.bugsee:bugsee-android-ndk:7.3.0"';
    const legacyLast = `${applied}\ndependencies {\n${ndk}\n}\n${legacyMarker}\n// one`;
    expect(ensureAppAppliesPlugin(legacyLast, '7.3.0')).toBe(`${applied}\ndependencies {\n${ndk}\n}\n// one\n\n${hook}\n`);
    const exclude = "configurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}";
    const symbolLast = `${applied}\n${exclude}\n// bugsee-symbol-table: x\n// more`;
    expect(ensureAppAppliesPlugin(symbolLast, null)).toBe(`${applied}\n${exclude}\n// bugsee-symbol-table: x\n// more\n\n${hook}\n`);
  });

  it('reads a legacy marker and a symbol marker whose lines end the file', () => {
    const own = `${applied}\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk\n}\n`;
    expect(ensureAppAppliesPlugin(`${own}${legacyMarker}\ndef bugseeHermesSourcemaps = "x"`, '7.3.0')).toBe(
      `${own}def bugseeHermesSourcemaps = "x"\n\n${hook}\n`,
    );
    // Replaced in place, the hook keeps the file's missing final newline.
    expect(ensureAppAppliesPlugin(`${own}${legacyMarker}\ndef bugseeHermesSourcemaps = "x"\nafterEvaluate {\n}`, '7.3.0')).toBe(
      `${own}${hook}`,
    );
    const exclude = "configurations.configureEach {\n    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'\n}";
    const symbolMarker = "// bugsee-symbol-table: AGP defaults this to NONE, so the plugin's native upload finds";
    expect(ensureAppAppliesPlugin(`${applied}\n${exclude}\n${symbolMarker}`, null)).toBe(`${applied}\n${exclude}\n\n${hook}\n`);
  });

  it('keeps an apply line with a trailing comment, and the line that follows a marker with one', () => {
    const source = `${applied}\nx()\n${marker}\n${apply} // mine\n`;
    expect(ensureAppAppliesPlugin(source, null)).toBe(`${applied}\nx()\n${apply} // mine\n\n${exclude}\n\n${hook}\n`);
  });

  it('does not take a legacy marker followed by a code line with a trailing comment as a hook', () => {
    const user = 'x() // note\nafterEvaluate {\n    println("mine")\n}';
    const next = ensureAppAppliesPlugin(`${applied}\n${legacyMarker}\n${user}\n`, null);
    expect(next).toContain(`${applied}\n${user}\n`);
  });
});
