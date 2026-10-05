// The binding rule for the Expo plugin's Gradle edits: a prebuild, clean or
// --no-clean, run any number of times, never removes or changes a byte of the
// user's own code. Where an edit cannot be made with certainty, the plugin
// refuses with one error, never a partial edit.
//
// Every input here is made of segments: user code, which must survive each
// run byte for byte and in order, and Bugsee leftovers (markers, old hooks,
// stray apply lines, blocks an earlier prebuild wrote), which the plugin may
// take or replace. The one allowed rewrite is the user's own
// `react.hermesCommand` line, which becomes the preserve wrapper.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANNOT_EDIT,
  ensureAppAppliesPlugin,
  ensureGradlePluginDeclared,
  ensureMavenCentral,
  ensureSymbolUploads,
} from '../gradle';

const fixtures = join(__dirname, 'fixtures');
const read = (rel: string): string => readFileSync(join(fixtures, rel), 'utf8');

const MARKER = '// bugsee-sourcemaps: debug ids and source-map upload for release bundles (@bugsee/react-native).';
const APPLY =
  'apply from: new File(new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/bugsee-sourcemaps.gradle")';
const LEGACY_MARKER = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
const PLUGIN_APPLY = 'apply plugin: "com.bugsee.android.gradle"';
const REACT_APPLY = 'apply plugin: "com.facebook.react"';
const LEGACY_HOOK_000 = read('finish-hook-0.0.0.gradle').trimEnd();
const LEGACY_HOOK_R1 = read('finish-hook-13.6-r1.gradle').trimEnd();

/** The wrapper expression the plugin writes, read off its own output. */
const EXPR = ((): string => {
  const line = ensureAppAppliesPlugin('react {\n}\n', null)
    .split('\n')
    .find((entry) => /^\s*hermesCommand = /.test(entry));
  if (!line) {
    throw new Error('the plugin did not write hermesCommand');
  }
  return line.replace(/^\s*hermesCommand = /, '');
})();

const EXCLUDE_BLOCK = [
  'configurations.configureEach {',
  "    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'",
  '}',
].join('\n');

const SYMBOL_BLOCK = [
  "// bugsee-symbol-table: AGP defaults this to NONE, so the plugin's native upload finds",
  '// nothing and skips. SYMBOL_TABLE emits symbols for code this app',
  '// builds. Maven Hermes and libreactnative.so are pre-stripped;',
  '// this level does not symbolicate those two.',
  'ndk {',
  "    debugSymbolLevel 'SYMBOL_TABLE'",
  '}',
].join('\n');

const UPLOADS_OFF_BLOCK = [
  '// bugsee-upload-symbols-off: uploadSymbols is false in the Expo config. The Bugsee',
  '// Gradle plugin 4.0.7 has no switch for its mapping, NDK symbol and build',
  '// uploads, so their tasks are turned off here.',
  "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
].join('\n');

type Kind = 'user' | 'bugsee' | 'hermes';
interface Segment {
  readonly text: string;
  readonly kind: Kind;
  /** For a hermes line: what must follow the wrapper expression, such as a trailing comment. */
  readonly tail?: string;
}
/** User code: every line survives byte for byte. */
const u = (text: string): Segment => ({ text, kind: 'user' });
/** A Bugsee leftover: the plugin may take or replace it. */
const b = (text: string): Segment => ({ text, kind: 'bugsee' });
/** The user's `react.hermesCommand` line: survives, or becomes the wrapper line with `tail` kept. */
const h = (text: string, tail = ''): Segment => ({ text, kind: 'hermes', tail });

interface Case {
  readonly name: string;
  readonly segments: readonly Segment[];
  /** The plugin must throw the refusal error and name the file; a function decides per option set. */
  readonly refuse?: boolean | ((option: AppOption) => boolean);
  readonly crlf?: boolean;
  /** No final newline. */
  readonly noEol?: boolean;
  /** Case-specific checks on the first run's output. */
  readonly check?: (output: string, option: AppOption) => void;
  /** Copies of Bugsee lines the user text itself quotes, inside comments or strings. */
  readonly quoted?: Partial<Record<'marker' | 'apply' | 'uploads' | 'exclude', number>>;
}

interface AppOption {
  readonly ndk: string | null;
  readonly uploads: boolean;
}

interface UserLine {
  readonly line: string;
  /** Null for a line that must survive as is; the required tail after the wrapper otherwise. */
  readonly tail: string | null;
}

interface Input {
  readonly text: string;
  readonly userLines: readonly UserLine[];
}

function input(c: Case): Input {
  let text = c.segments.map((segment) => segment.text).join('\n');
  if (!c.noEol) {
    text += '\n';
  }
  const userLines: UserLine[] = [];
  for (const segment of c.segments) {
    if (segment.kind === 'bugsee') {
      continue;
    }
    for (const line of segment.text.split('\n')) {
      userLines.push({ line, tail: segment.kind === 'hermes' ? (segment.tail ?? '') : null });
    }
  }
  if (c.crlf) {
    return {
      text: text.replace(/\n/g, '\r\n'),
      userLines: userLines.map((entry) => ({
        line: `${entry.line}\r`,
        tail: entry.tail === null ? null : `${entry.tail}\r`,
      })),
    };
  }
  return { text, userLines };
}

/** The first user line that is not in the output, in order; null when all survive. */
function lost(userLines: readonly UserLine[], output: string): string | null {
  const out = output.split('\n');
  let from = 0;
  for (const { line, tail } of userLines) {
    let at = out.indexOf(line, from);
    if (at < 0 && tail !== null) {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      at = out.indexOf(`${indent}hermesCommand = ${EXPR}${tail}`, from);
    }
    if (at < 0) {
      return line;
    }
    from = at + 1;
  }
  return null;
}

const countLines = (text: string, wanted: string): number =>
  text.split('\n').filter((line) => line.replace(/\r$/, '').trim() === wanted).length;

/** The template's own hermesCommand line is the one the plugin may rewrite. */
function template(text: string): Case['segments'] {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (/^\s*hermesCommand\s*=/.test(line) ? h(line) : u(line)));
}

const SDKS = ['sdk54', 'sdk55', 'sdk56', 'sdk57'] as const;

const userDeps = 'dependencies {\n    implementation("com.example:kept:1.0")\n}';
const userAfter = 'afterEvaluate {\n    println("mine")\n}';
const reactOpen = 'react {';
const reactClose = '}';

// ---------------------------------------------------------------------------
// android/app/build.gradle
// ---------------------------------------------------------------------------

const appCases: Case[] = [
  // --- The reviewer's inputs that lost user code (re-review 3) ---
  {
    name: 'legacy marker, then the user afterEvaluate with } at column 0',
    segments: [u(REACT_APPLY), b(LEGACY_MARKER), u(userAfter), u(userDeps)],
  },
  {
    name: 'legacy marker, user // comments, then the user afterEvaluate',
    segments: [u(REACT_APPLY), b(LEGACY_MARKER), u('// mine\n// also mine'), u(userAfter)],
  },
  {
    name: 'legacy marker, a user def bugseeMyFlag, then the user afterEvaluate',
    segments: [u(REACT_APPLY), b(LEGACY_MARKER), u('def bugseeMyFlag = true'), u(userAfter)],
  },
  {
    name: 'hermesCommand with a second statement after ; is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = "/opt/hermesc"; bundleCommand = "export:embed"'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'hermesCommand.set with a second statement after ; is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand.set("/h"); cliFile = file("../cli.js")'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'the Bugsee apply line with another statement after ; (with its marker)',
    segments: [u(REACT_APPLY), b(MARKER), u(`${APPLY}; apply plugin: "kotlin-android"`)],
  },
  {
    name: 'the Bugsee apply line with another statement after ; (no marker)',
    segments: [u(REACT_APPLY), u(`${APPLY}; apply plugin: "kotlin-android"`)],
  },
  {
    name: 'a trailing // comment on the hermesCommand line',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = "/x" // keep me', ' // keep me'), u(reactClose)],
    check: (output) => expect(output).toContain(`hermesCommand = ${EXPR} // keep me\n`),
  },
  {
    name: 'a trailing /* */ comment on the hermesCommand line',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = "/x"  /* keep me */', '  /* keep me */'), u(reactClose)],
    check: (output) => expect(output).toContain(`hermesCommand = ${EXPR}  /* keep me */\n`),
  },
  {
    name: 'a trailing comment on the hermesCommand line, CRLF',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = "/x" // keep me', ' // keep me'), u(reactClose), u(userDeps)],
    crlf: true,
    check: (output) => expect(output).toContain(`hermesCommand = ${EXPR} // keep me\r\n`),
  },
  {
    name: 'hermesCommand inside another block is not the react setting',
    segments: [u(REACT_APPLY), u('myTool {\n    hermesCommand = "/x"\n}'), u(reactOpen), u(reactClose)],
    check: (output) => expect(output.split(EXPR)).toHaveLength(2),
  },
  {
    name: 'hermesCommand inside another block, no react block at all',
    segments: [u(REACT_APPLY), u('myTool {\n    hermesCommand.set("/x")\n}'), u(userDeps)],
    check: (output) => expect(output).not.toContain(EXPR),
  },
  {
    name: 'a dollar-slashy string holding a hermesCommand line',
    segments: [
      u(REACT_APPLY),
      u('def doc = $/\nhermesCommand = "a"\nplain text\n/$'),
      u(reactOpen),
      h('    hermesCommand = "/x"'),
      u(reactClose),
    ],
  },
  {
    name: 'a slashy string holding a hermesCommand.set line',
    segments: [
      u(REACT_APPLY),
      u('def doc = /\nhermesCommand.set(\nplain text\n/'),
      u(reactOpen),
      h('    hermesCommand = "/x"'),
      u(reactClose),
    ],
  },
  {
    name: 'a user fork of the script is kept and the package hook added',
    segments: [u(REACT_APPLY), u('apply from: rootProject.file("my-scripts/bugsee-sourcemaps.gradle")')],
  },
  {
    name: 'a Bugsee apply line inside an if block is kept',
    segments: [u(REACT_APPLY), u(`if (System.getenv("CI")) {\n    ${APPLY}\n}`)],
    quoted: { apply: 1 },
  },
  {
    name: 'a legacy r1 hook with a user line added inside it is still the hook',
    segments: [u(REACT_APPLY), b(LEGACY_HOOK_R1.replace('afterEvaluate {\n', 'afterEvaluate {\n    println("added")\n')), u(userDeps)],
  },
  {
    // A one-line build type cannot take the symbol block without a rewrite of
    // the user's line, so native crash reporting on refuses; off leaves it.
    name: 'braces inside a string in a one-line release block',
    segments: [
      u(REACT_APPLY),
      u('android {\n    buildTypes {\n        release { minifyEnabled true; def s = "}}}" }\n    }\n}'),
    ],
    refuse: (option) => option.ndk !== null,
  },
  {
    name: 'braces inside a string in a release block',
    segments: [
      u(REACT_APPLY),
      u('android {\n    buildTypes {\n        release {\n            minifyEnabled true; def s = "}}}"\n\n        }\n    }\n}'),
    ],
    check: (output, option) => {
      expect(countLines(output, "debugSymbolLevel 'SYMBOL_TABLE'")).toBe(option.ndk === null ? 0 : 1);
      if (option.ndk !== null) {
        // Inside the release block, after the string, with the user's blank line kept before the brace.
        expect(output).toMatch(/def s = "}}}"\n {12}\/\/ bugsee-symbol-table:[^]*?\n {12}}\n\n {8}}\n {4}}\n}/);
      }
    },
  },
  {
    name: 'a // comment naming dependencies { before the real block',
    segments: [u(REACT_APPLY), u('// Keep dependencies { sorted } please'), u(userDeps)],
    check: (output, option) => {
      if (option.ndk !== null) {
        expect(output).toContain(`// Keep dependencies { sorted } please\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:${option.ndk}"\n`);
      }
    },
  },
  {
    name: 'a commented-out dependencies block before the real block',
    segments: [u(REACT_APPLY), u('/*\ndependencies {\n    implementation("old")\n}\n*/'), u(userDeps)],
    check: (output, option) => {
      if (option.ndk !== null) {
        expect(output).toContain(`*/\ndependencies {\n    implementation "com.bugsee:bugsee-android-ndk:${option.ndk}"\n`);
      }
    },
  },

  // --- The reviewer's safe inputs, kept safe ---
  { name: 'an empty file', segments: [u('')], noEol: true },
  {
    name: 'braces in strings and comments around the hook',
    segments: [u(REACT_APPLY), u('def a = "{"\n// }\n/* { */'), b(`${MARKER}\n${APPLY}`), u('def z = "}"')],
  },
  {
    name: 'user afterEvaluate blocks around a current hook',
    segments: [u(REACT_APPLY), u(userAfter), b(`${MARKER}\n${APPLY}`), u(userAfter)],
  },
  {
    name: 'tabs everywhere',
    segments: [u(REACT_APPLY), u('android {\n\tbuildTypes {\n\t\trelease {\n\t\t\tminifyEnabled true\n\t\t}\n\t}\n}'), u(reactOpen), h('\thermesCommand = "/x"'), u(reactClose)],
  },
  {
    name: 'an indented marker',
    segments: [u(REACT_APPLY), b(`    ${MARKER}`), u(userDeps)],
  },
  {
    name: 'the marker quoted inside a user comment',
    segments: [u(REACT_APPLY), u(`// see "${MARKER}"`), u(userDeps)],
  },
  {
    name: 'an exact marker inside a block comment is user text',
    segments: [u(REACT_APPLY), u(`/*\n${MARKER}\n*/`), u(userDeps)],
    quoted: { marker: 1 },
  },
  {
    name: 'a block comment around the whole hook is user text',
    segments: [u(REACT_APPLY), u(`/*\n${MARKER}\n${APPLY}\n*/`), u(userDeps)],
    quoted: { marker: 1, apply: 1 },
  },
  {
    name: 'a legacy hook with braces in a string closes on its own brace',
    segments: [u(REACT_APPLY), b(`${LEGACY_MARKER}\ndef bugseeHermesSourcemaps = "x"\nafterEvaluate {\n    def s = "{"\n}`), u(userDeps)],
  },
  {
    name: 'a triple-quoted string holding the marker and the apply line',
    segments: [u(REACT_APPLY), u(`def doc = """\n${MARKER}\n${APPLY}\n"""`), u(userDeps)],
    quoted: { marker: 1, apply: 1 },
  },
  {
    name: 'escaped quotes, backslashes and a GString with nested quotes',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = "a\\"b\\\\" + "${rootDir}/x" + "${["q"].join("\'")}"'), u(reactClose)],
  },
  {
    name: 'a dollar-slashy value',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = $/opt/hermesc/$'), u(reactClose)],
  },
  {
    name: 'a slashy value',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = /opt\\/hermesc/'), u(reactClose)],
  },
  {
    name: 'a slashy value with an unescaped slash is two tokens and refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = /opt/hermesc/'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'a multi-line triple-quoted value is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = """\n/x\n"""'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'slashy strings that would hide the react block',
    segments: [u(REACT_APPLY), u("def a = /'''/\ndef c = /a\\/*b/"), u(reactOpen), h('    hermesCommand = "/x"'), u(reactClose)],
  },
  {
    name: 'no trailing newline',
    segments: [u(REACT_APPLY), u(userDeps)],
    noEol: true,
  },
  {
    name: 'CRLF with a current hook and user blocks',
    segments: [u(REACT_APPLY), u(userDeps), b(`${MARKER}\n${APPLY}`), u(userAfter)],
    crlf: true,
  },
  {
    name: 'CRLF with a legacy hook',
    segments: [u(REACT_APPLY), u(userDeps), b(LEGACY_HOOK_000), u(userAfter)],
    crlf: true,
  },
  {
    name: 'CRLF with an orphan marker',
    segments: [u(REACT_APPLY), b(MARKER), u(userDeps)],
    crlf: true,
  },

  // --- Hostile: every marker, keyword and brace in comments and strings ---
  {
    name: 'every keyword inside strings',
    segments: [
      u(REACT_APPLY),
      u('def a = "dependencies {"\ndef b = \'buildTypes {\'\ndef c = "react {"\ndef d = "release {"\ndef e = "afterEvaluate {"\ndef f = "}"'),
      u(reactOpen),
      h('    hermesCommand = "/x"'),
      u(reactClose),
      u(userDeps),
    ],
  },
  {
    name: 'every keyword inside a block comment',
    segments: [
      u(REACT_APPLY),
      u('/*\ndependencies {\nbuildTypes {\nreact {\n    hermesCommand = "/y"\nrelease {\n}\n*/'),
      u(reactOpen),
      h('    hermesCommand = "/x"'),
      u(reactClose),
      u(userDeps),
    ],
  },
  {
    name: 'the Bugsee plugin id and the react plugin apply inside comments',
    segments: [u(`// ${REACT_APPLY}`), u(`// ${PLUGIN_APPLY}`), u(REACT_APPLY), u(userDeps)],
  },
  {
    name: 'the react plugin apply with a trailing comment',
    segments: [u(`${REACT_APPLY} // RN`), u(userDeps)],
  },
  {
    name: 'a commented NDK line is not the dependency',
    segments: [u(REACT_APPLY), u('dependencies {\n    // implementation "com.bugsee:bugsee-android-ndk:1.0.0"\n    implementation("a")\n}')],
    check: (output, option) =>
      expect(countLines(output, `implementation "com.bugsee:bugsee-android-ndk:${option.ndk}"`)).toBe(option.ndk === null ? 0 : 1),
  },
  {
    name: 'the react plugin apply inside an if block',
    segments: [u('if (true) {\n    apply plugin: "com.facebook.react"\n}'), u(userDeps)],
    check: (output) => expect(output.startsWith(`${PLUGIN_APPLY}\n`)).toBe(true),
  },
  {
    name: 'the exclude and uploads-off blocks inside a block comment are user text',
    segments: [u(REACT_APPLY), u(`/*\n${EXCLUDE_BLOCK}\n${UPLOADS_OFF_BLOCK}\n*/`), u(userDeps)],
    quoted: { exclude: 1, uploads: 1 },
  },
  {
    name: 'a symbol block inside a triple-quoted string is user text',
    segments: [u(REACT_APPLY), u(`def doc = """\n${SYMBOL_BLOCK}\n"""`), u('android {\n    buildTypes {\n        release {\n            minifyEnabled true\n        }\n    }\n}')],
  },
  {
    name: 'GString interpolation with braces and quotes',
    segments: [
      u(REACT_APPLY),
      u('def v = "${project.ext.get("x")}{"\ndef w = "${ [a: 1].collect { k, v -> "$k" }.join("}") }"'),
      u(userDeps),
    ],
  },
  {
    name: 'division and regex operators',
    segments: [
      u(REACT_APPLY),
      u('def half = 10 / 2\ndef third = (9) / 3\ndef ok = "a" ==~ /a+/\ndef m = x =~ /\\/{/'),
      u('def fourth = [8][0] / 2\ndef fifth = "10" / 2\ndef sixth = a/ b\ndef f = { -> return /a{b/ }\ndef g = x in /c{d/'),
      u('def r = /a${[1].collect { it }}b/\ndef ds = $/a$$b$/c{/$'),
      u(userDeps),
    ],
  },
  {
    name: 'a fourth quote is content, and a backslash before a newline is one character',
    segments: [u(REACT_APPLY), u('def four = """x"""" + "{"\ndef cont = """a\\\nb"""'), u(userDeps)],
  },
  {
    name: 'a fourth single quote is content too',
    segments: [u(REACT_APPLY), u("def five = '''y'''' + '{'"), u(userDeps)],
  },
  {
    name: 'a slash spaced like a regex argument is ambiguous and refused',
    segments: [u(REACT_APPLY), u('def q = a /b/'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a trailing block comment then a line comment on the hermesCommand line',
    segments: [u(REACT_APPLY), u(reactOpen), h('    hermesCommand = "/x" /* a */ // b', ' /* a */ // b'), u(reactClose)],
  },
  {
    name: 'a Bugsee apply line with a trailing comment is user code',
    segments: [u(REACT_APPLY), u(`${APPLY} // mine`), u(userDeps)],
  },
  {
    name: 'the exclude block inside a user if block is not the plugin block',
    segments: [u(REACT_APPLY), u(`if (x) {\n${EXCLUDE_BLOCK}\n}`), u(userDeps)],
    quoted: { exclude: 1 },
  },
  {
    name: 'a symbol marker with code before it, or in a block comment, starts no block',
    segments: [u(REACT_APPLY), u('a() // bugsee-symbol-table: x\nndk {\n}\n/* bugsee-symbol-table: y */\nndk {\n}'), u(userDeps)],
  },
  {
    name: 'the react plugin apply inside a block comment is not the apply line',
    segments: [u(`/*\n${REACT_APPLY}\n*/`), u(REACT_APPLY), u(userDeps)],
    check: (output) => expect(output).toContain(`*/\n${REACT_APPLY}\n${PLUGIN_APPLY}\n`),
  },
  {
    name: 'a nested react block is not the react block',
    segments: [u(REACT_APPLY), u('android {\n    react {\n    }\n}'), u(userDeps)],
    check: (output) => expect(output).not.toContain(EXPR),
  },
  {
    name: 'a legacy fingerprint line that opens a string is not a hook',
    segments: [u(REACT_APPLY), b(LEGACY_MARKER), u('def bugseeHermesSourcemaps = """\nafterEvaluate {\n"""'), u(userAfter)],
  },
  {
    name: 'hermesCommand compared, not assigned',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand == "/x"'), u(reactClose)],
  },
  {
    name: 'hermesCommand nested deeper in the react block is left alone',
    segments: [u(REACT_APPLY), u(reactOpen), u('    if (isCI) {\n        hermesCommand = "/ci"\n    }'), u(reactClose)],
  },
  {
    name: 'a current hook with a blank line between marker and apply line',
    segments: [u(REACT_APPLY), b(MARKER), u(''), b(APPLY), u(userDeps)],
  },
  {
    name: 'two user dependencies blocks and a buildscript dependencies block',
    segments: [
      u(REACT_APPLY),
      u('buildscript {\n    dependencies {\n        classpath("x")\n    }\n}'),
      u(userDeps),
      u('dependencies {\n    implementation("second")\n}'),
    ],
  },
  {
    name: 'blank lines at the end of the file',
    segments: [u(REACT_APPLY), u(userDeps), u(''), u(''), u('')],
  },
  {
    name: 'trailing spaces at the end of the file',
    segments: [u(REACT_APPLY), u(userDeps), u('   ')],
    noEol: true,
  },
  {
    name: 'a user NONE symbol level and a user ndk block',
    segments: [
      u(REACT_APPLY),
      u("android {\n    buildTypes {\n        debug {\n            ndk { abiFilters 'arm64-v8a' }\n        }\n        release {\n            ndk.debugSymbolLevel 'NONE'\n        }\n    }\n}"),
    ],
  },

  // --- Hostile: inputs that cannot be read with certainty are refused ---
  {
    name: 'a string that does not close on its line is refused',
    segments: [u(REACT_APPLY), u('def a = "open'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a block comment that never closes is refused',
    segments: [u(REACT_APPLY), u('/* open'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a slashy string that never closes is refused',
    segments: [u(REACT_APPLY), u('def a = /open'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a dollar-slashy string that never closes is refused',
    segments: [u(REACT_APPLY), u('def a = $/open'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a slash after a closing brace is ambiguous and refused',
    segments: [u(REACT_APPLY), u('def a = { 1 } / 2'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a line starting with a slash is ambiguous and refused',
    segments: [u(REACT_APPLY), u('def a = (4\n/ 2)'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'unbalanced braces are refused',
    segments: [u(REACT_APPLY), u('android {\n    buildTypes {\n    }'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a closing brace without an opening one is refused',
    segments: [u(REACT_APPLY), u('}'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'an interpolation that never closes is refused',
    segments: [u(REACT_APPLY), u('def a = "${open'), u(userDeps)],
    refuse: true,
  },
  {
    name: 'a hermesCommand value that continues on the next line is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = "a" +\n        "b"'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'a hermesCommand value with a leading-dot continuation is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = file("x")\n        .absolutePath'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'a hermesCommand with nothing after = is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand =\n        "x"'), u(reactClose)],
    refuse: true,
  },
  {
    name: 'a hermesCommand value with an open bracket is refused',
    segments: [u(REACT_APPLY), u(reactOpen), u('    hermesCommand = foo(bar\n    )'), u(reactClose)],
    refuse: true,
  },
];

const appOptions: readonly AppOption[] = [
  { ndk: '9.9.9', uploads: true },
  { ndk: '9.9.9', uploads: false },
  { ndk: null, uploads: true },
  { ndk: null, uploads: false },
];

const prebuildApp = (text: string, option: AppOption): string =>
  ensureSymbolUploads(ensureAppAppliesPlugin(text, option.ndk), option.uploads);

function expectAppOutcome(c: Case, source: Input, option: AppOption): void {
  const label = `${c.name} [ndk=${option.ndk}, uploads=${option.uploads}]`;
  if (typeof c.refuse === 'function' ? c.refuse(option) : c.refuse) {
    let message = '';
    try {
      prebuildApp(source.text, option);
    } catch (error) {
      message = (error as Error).message;
    }
    expect([label, message.startsWith(`${CANNOT_EDIT} android/app/build.gradle:`)]).toEqual([label, true]);
    return;
  }
  const once = prebuildApp(source.text, option);
  const twice = prebuildApp(once, option);
  expect([label, lost(source.userLines, once)]).toEqual([label, null]);
  expect([label, twice]).toEqual([label, once]);
  // Exactly one hook, marker and apply line adjacent, no legacy marker.
  const quoted = c.quoted ?? {};
  expect([label, countLines(once, MARKER)]).toEqual([label, 1 + (quoted.marker ?? 0)]);
  expect([label, countLines(once, APPLY)]).toEqual([label, 1 + (quoted.apply ?? 0)]);
  const eol = c.crlf ? '\r\n' : '\n';
  expect([label, once.includes(`${MARKER}${eol}${APPLY}${eol}`)]).toEqual([label, true]);
  expect([label, once.includes(LEGACY_MARKER)]).toEqual([label, false]);
  expect([label, countLines(once, PLUGIN_APPLY)]).toEqual([label, 1]);
  expect([label, countLines(once, UPLOADS_OFF_BLOCK.split('\n')[3] as string)]).toEqual([
    label,
    (option.uploads ? 0 : 1) + (quoted.uploads ?? 0),
  ]);
  expect([label, countLines(once, (EXCLUDE_BLOCK.split('\n')[1] as string).trim())]).toEqual([
    label,
    (option.ndk === null ? 1 : 0) + (quoted.exclude ?? 0),
  ]);
  c.check?.(once, option);
  // CRLF files stay CRLF on every line, and a LF file gains no CR.
  const bareLf = once.split('\n').filter((line, i, all) => i < all.length - 1 && !line.endsWith('\r')).length;
  expect([label, c.crlf ? bareLf : once.includes('\r')]).toEqual([label, c.crlf ? 0 : false]);
}

describe('app/build.gradle corpus: every user byte survives, or the plugin refuses', () => {
  const cases: Case[] = [
    ...appCases,
    ...SDKS.map((sdk) => ({ name: `Expo ${sdk} template`, segments: template(read(`expo-templates/${sdk}/app-build.gradle`)) })),
    ...SDKS.map((sdk) => ({
      name: `Expo ${sdk} template, CRLF`,
      segments: template(read(`expo-templates/${sdk}/app-build.gradle`)),
      crlf: true,
    })),
  ];

  it('has the reviewer\'s cases and more', () => {
    expect(cases.length).toBeGreaterThanOrEqual(51 + SDKS.length);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const source = input(c);
    for (const option of appOptions) {
      expectAppOutcome(c, source, option);
    }
  });

  it.each(cases.filter((c) => !c.refuse).map((c) => [c.name, c] as const))(
    'survives a chain of every option change: %s',
    (_name, c) => {
      const source = input(c);
      let text = source.text;
      for (const option of [...appOptions, appOptions[0]!]) {
        text = prebuildApp(text, option);
        expect([c.name, option, lost(source.userLines, text)]).toEqual([c.name, option, null]);
      }
      // Back at the first option set: the same as a direct run from the source.
      expect(text).toBe(prebuildApp(source.text, appOptions[0]!));
    },
  );
});

// ---------------------------------------------------------------------------
// android/build.gradle and android/settings.gradle
// ---------------------------------------------------------------------------

const DECLARATION = "    id 'com.bugsee.android.gradle' version '1.2.3' apply false";

const rootCases: Case[] = [
  { name: 'buildscript then allprojects', segments: [u('buildscript {\n    ext { x = 1 }\n}'), u('allprojects { }')] },
  { name: 'a plugins block of its own', segments: [u('plugins {\n    id("x") version "1"\n}'), u('allprojects { }')] },
  { name: 'the Bugsee plugin id inside a comment', segments: [u(`// plugins { ${DECLARATION.trim()} }`), u('allprojects { }')] },
  { name: 'buildscript inside a comment', segments: [u('// buildscript {\n/* buildscript { } */'), u('allprojects { }')] },
  { name: 'a declaration from an earlier prebuild', segments: [u('plugins {'), b(DECLARATION), u('}'), u('allprojects { }')] },
  { name: 'a declaration in a string is left', segments: [u('def doc = "plugins { id \'com.bugsee.android.gradle\' version \'0\' }"'), u('allprojects { }')] },
  { name: 'CRLF root', segments: [u('buildscript {\n    ext { x = 1 }\n}'), u('allprojects { }')], crlf: true },
  { name: 'unterminated string in the root file is refused', segments: [u('def a = "open'), u('allprojects { }')], refuse: true },
  { name: 'unbalanced braces in the root file are refused', segments: [u('buildscript {'), u('allprojects { }')], refuse: true },
  ...SDKS.map((sdk) => ({ name: `Expo ${sdk} root template`, segments: template(read(`expo-templates/${sdk}/build.gradle`)) })),
];

describe('build.gradle corpus', () => {
  it.each(rootCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const source = input(c);
    if (c.refuse) {
      expect(() => ensureGradlePluginDeclared(source.text, '1.2.3')).toThrow(`${CANNOT_EDIT} android/build.gradle:`);
      return;
    }
    const once = ensureGradlePluginDeclared(source.text, '1.2.3');
    const twice = ensureGradlePluginDeclared(once, '1.2.3');
    expect(lost(source.userLines, once)).toBeNull();
    expect(twice).toBe(once);
    const declared = countLines(once, "id 'com.bugsee.android.gradle' version '1.2.3' apply false");
    if (c.name.includes('in a string')) {
      // Another declaration form: left alone rather than declared twice.
      expect(declared).toBe(0);
      expect(once).toBe(source.text);
      return;
    }
    expect(declared).toBe(1);
    const bumped = ensureGradlePluginDeclared(once, '2.0.0');
    expect(lost(source.userLines, bumped)).toBeNull();
    expect(countLines(bumped, "id 'com.bugsee.android.gradle' version '2.0.0' apply false")).toBe(1);
    expect(bumped.includes("version '1.2.3'")).toBe(c.name.includes('plugin id inside a comment'));
    if (c.crlf) {
      expect(once.split('\n').filter((line, i, all) => i < all.length - 1 && !line.endsWith('\r'))).toEqual([]);
    }
  });
});

const settingsCases: Case[] = [
  { name: 'no pluginManagement', segments: [u('rootProject.name = "x"'), u('include ":app"')] },
  { name: 'pluginManagement without repositories', segments: [u('pluginManagement {\n    plugins { id("x") }\n}'), u('include ":app"')] },
  { name: 'repositories without mavenCentral', segments: [u('pluginManagement {\n    repositories {\n        google()\n    }\n}'), u('include ":app"')] },
  { name: 'mavenCentral already there', segments: [u('pluginManagement {\n    repositories {\n        mavenCentral()\n    }\n}'), u('include ":app"')] },
  { name: 'mavenCentral only in a comment', segments: [u('pluginManagement {\n    repositories {\n        // mavenCentral()\n        google()\n    }\n}'), u('include ":app"')] },
  { name: 'pluginManagement only in a comment', segments: [u('// pluginManagement {\n/* pluginManagement { repositories { } } */'), u('include ":app"')] },
  { name: 'repositories in a string', segments: [u('pluginManagement {\n    def s = "repositories {"\n}'), u('include ":app"')] },
  { name: 'a trailing comment in repositories', segments: [u('pluginManagement {\n    repositories {\n        google() // first\n        // last\n    }\n}'), u('include ":app"')] },
  { name: 'CRLF settings', segments: [u('pluginManagement {\n    repositories {\n        google()\n    }\n}'), u('include ":app"')], crlf: true },
  { name: 'unbalanced settings are refused', segments: [u('pluginManagement {\n    repositories {\n}'), u('include ":app"')], refuse: true },
  ...SDKS.map((sdk) => ({ name: `Expo ${sdk} settings template`, segments: template(read(`expo-templates/${sdk}/settings.gradle`)) })),
];

describe('settings.gradle corpus', () => {
  it.each(settingsCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const source = input(c);
    if (c.refuse) {
      expect(() => ensureMavenCentral(source.text)).toThrow(`${CANNOT_EDIT} android/settings.gradle:`);
      return;
    }
    const once = ensureMavenCentral(source.text);
    const twice = ensureMavenCentral(once);
    expect(lost(source.userLines, once)).toBeNull();
    expect(twice).toBe(once);
    expect(countLines(once, 'mavenCentral()')).toBe(1);
    if (c.crlf) {
      expect(once.split('\n').filter((line, i, all) => i < all.length - 1 && !line.endsWith('\r'))).toEqual([]);
    }
  });
});
