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
    expect(ensureMavenCentral('pluginManagement { repositories { google() } }\n')).toBe(
      'pluginManagement { repositories { google()\n        mavenCentral() } }\n',
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
    const outside = 'pluginManagement {\n    repositories { google() }\n}\nrepositories { mavenCentral() }\n';
    expect(ensureMavenCentral(outside)).toBe(
      'pluginManagement {\n    repositories { google()\n        mavenCentral() }\n}\nrepositories { mavenCentral() }\n',
    );
  });

  it('treats an unclosed pluginManagement as absent', () => {
    expect(ensureMavenCentral('pluginManagement {\n')).toBe(`${header}pluginManagement {\n`);
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

  it('refuses a version that is not a plain version string', () => {
    for (const bad of ['', '4.0.7 bad', 'bad 4.0.7', "4.0.7'", '4.0\n7']) {
      expect(() => ensureGradlePluginDeclared('', bad)).toThrow(`refusing Gradle plugin version ${bad}`);
    }
    expect(ensureGradlePluginDeclared('', 'A-z_0.9+1')).toContain("version 'A-z_0.9+1'");
  });
});

describe('ensureAppAppliesPlugin, exactly', () => {
  const ndkLine = '    implementation "com.bugsee:bugsee-android-ndk:7.3.0"';
  const exclude = lines(
    'configurations.configureEach {',
    "    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'",
    '}',
  );

  it('applies the plugin first when there is no React plugin line, and adds dependencies', () => {
    expect(beforeHook(ensureAppAppliesPlugin('android {\n}\n', '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid {\n}\n\ndependencies {\n${ndkLine}\n}\n\n`,
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
    expect(
      beforeHook(ensureAppAppliesPlugin(`apply plugin: "com.facebook.react"\ndependencies {\n${ndkLine}\n}\n`, null)),
    ).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n}\n\n${exclude}\n\n`,
    );
  });

  it('removes an exclude block wherever it sits, with the blank lines it brought', () => {
    const expected = `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n\n`;
    const body = 'apply plugin: "com.facebook.react"\ndependencies {\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(`${exclude}\n\n\n${body}`, '7.3.0'))).toBe(expected);
    expect(beforeHook(ensureAppAppliesPlugin(`${body}${exclude}`, '7.3.0'))).toBe(expected);
    expect(beforeHook(ensureAppAppliesPlugin(`${body}\n${exclude}\n\n`, '7.3.0'))).toBe(expected);
    const middle = ensureAppAppliesPlugin(`${body}\n${exclude}\n\n// tail\n`, '7.3.0');
    expect(beforeHook(middle)).toBe(
      `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\ndependencies {\n${ndkLine}\n}\n// tail\n\n`,
    );
  });

  it('rewrites every hermesCommand assignment but not a commented one', () => {
    const source = 'react {\n    hermesCommand = "$rootDir/x"\n\thermesCommand="y"\n    // hermesCommand = "z"\n}\n';
    expect(beforeHook(ensureAppAppliesPlugin(source, '7.3.0'))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nreact {\n    ${HERMES_COMMAND}\n\t${HERMES_COMMAND}\n    // hermesCommand = "z"\n}\n\ndependencies {\n${ndkLine}\n}\n\n`,
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
      '        release { minifyEnabled true }',
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
        '        release { minifyEnabled true',
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
        '        release { minifyEnabled true',
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
      `apply plugin: "com.bugsee.android.gradle"\n${source}\ndependencies {\n${ndkLine}\n}\n\n`,
    );
  });

  it('removes only a marked block that is followed by an ndk block', () => {
    const kept = '// bugsee-symbol-table: a comment, no block\nother()\n';
    expect(beforeHook(ensureAppAppliesPlugin(kept, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${kept}\n${exclude}\n\n`,
    );
    const unclosed = 'a()\n    // bugsee-symbol-table: x\n    // more\n    ndk {\n        debugSymbolLevel \'SYMBOL_TABLE\'\n';
    expect(beforeHook(ensureAppAppliesPlugin(unclosed, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${unclosed}\n${exclude}\n\n`,
    );
    const twice =
      'a()\n// bugsee-symbol-table: x\nndk {\n    x { }\n}\nb()\n  // bugsee-symbol-table: y\n  ndk {\n  }  \nc()\n';
    expect(beforeHook(ensureAppAppliesPlugin(twice, null))).toBe(
      `apply plugin: "com.bugsee.android.gradle"\na()\nb()\nc()\n\n${exclude}\n\n`,
    );
  });

  it('keeps a user afterEvaluate block and adds the hook after it', () => {
    const user = 'android {\n}\nafterEvaluate {\n    println("mine")\n}\n';
    const next = ensureAppAppliesPlugin(user, null);
    expect(next.startsWith(`apply plugin: "com.bugsee.android.gradle"\n${user}`)).toBe(true);
    expect(next.match(/afterEvaluate \{/g)).toHaveLength(1);
    expect(next.endsWith('scripts/bugsee-sourcemaps.gradle")\n')).toBe(true);
  });

  it('replaces from the marker even when a block opens before it', () => {
    const marker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
    const fresh = ensureAppAppliesPlugin('android { }\n', null);
    const hook = fresh.slice(fresh.indexOf('// bugsee-sourcemaps:'));
    expect(ensureAppAppliesPlugin(`android { }\n${marker}\nafterEvaluate {\n    old()\n}\n`, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n${hook}\n${exclude}\n`,
    );
    // An unclosed hook is not replaced; a complete one is appended.
    const unclosed = ensureAppAppliesPlugin(`android { }\n${marker}\nafterEvaluate {\n`, null);
    expect(unclosed).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n${marker}\nafterEvaluate {\n\n${exclude}\n\n${hook}`,
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

  it('appends after one blank line and removes back to the original', () => {
    expect(ensureSymbolUploads('a()\n\n\n', false)).toBe(`a()\n\n${block}\n`);
    expect(ensureSymbolUploads(`a()\n\n${block}\n`, true)).toBe('a()\n');
    expect(ensureSymbolUploads(`a()\n\n${block}\n\n\nb()\n`, true)).toBe('a()\nb()\n');
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
      'dependencies {\n    implementation "com.bugsee:bugsee-android-ndk:7.3.0"\n}\napply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\n\n',
    );
  });

  it('trims all trailing blank lines before appending', () => {
    const ndkOn = ensureAppAppliesPlugin('android {\n}\n\n\n', '7.3.0');
    expect(beforeHook(ndkOn)).toBe(
      'apply plugin: "com.bugsee.android.gradle"\nandroid {\n}\n\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:7.3.0"\n}\n\n',
    );
    const ndkOff = ensureAppAppliesPlugin('android {\n}\n\n\n', null);
    expect(beforeHook(ndkOff)).toBe(
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
  const hook = (() => {
    const fresh = ensureAppAppliesPlugin('x\n', null);
    return fresh.slice(fresh.indexOf('// bugsee-sourcemaps:'));
  })();

  it('appends after a user afterEvaluate block and leaves it whole', () => {
    const user = 'android {\n}\nafterEvaluate {\n    println("mine")\n}\n';
    expect(ensureAppAppliesPlugin(user, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\n${user}\n${exclude}\n\n${hook}`,
    );
  });

  it('appends when the marker has no afterEvaluate after it', () => {
    expect(ensureAppAppliesPlugin(`android { }\n${marker}\n`, null)).toBe(
      `apply plugin: "com.bugsee.android.gradle"\nandroid { }\n${marker}\n\n${exclude}\n\n${hook}`,
    );
  });

  it('replaces a hook that starts the file', () => {
    const source = `${marker}\nafterEvaluate {\n    old()\n}\napply plugin: "com.bugsee.android.gradle"\n`;
    expect(ensureAppAppliesPlugin(source, null)).toBe(
      `${hook}apply plugin: "com.bugsee.android.gradle"\n\n${exclude}\n`,
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
    expect(ensureSymbolUploads(`a()\n${block}b()\nc()\n`, true)).toBe('a()\nb()\nc()\n');
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
      "react {\n    hermesCommand = 'unclosed\n}\n",
      'react {\n    hermesCommand = [\n    "a"].join()\n}\n',
    ]) {
      expect(() => ensureAppAppliesPlugin(source, null)).toThrow(HERMES_COMMAND_UNREWRITABLE);
    }
    expect(HERMES_COMMAND_UNREWRITABLE).toContain('hermesc-preserve-js.sh');
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
