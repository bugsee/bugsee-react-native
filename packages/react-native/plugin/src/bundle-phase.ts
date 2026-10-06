import { decodePbxString, encodePbxString } from './pbx-string';

/**
 * The "Bundle React Native code and images" shell script from the bare
 * example's pbxproj. It runs `bugsee-xcode.sh`, which makes
 * `REACT_NATIVE_PATH` absolute with `cd`/`pwd`, injects after compose, and
 * uploads the composed map when a real token is configured.
 */
export const BARE_BUNDLE_SCRIPT = [
  'set -e',
  '',
  'WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"',
  'BUGSEE_XCODE="${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh"',
  '',
  '/bin/sh -c "\\"$WITH_ENVIRONMENT\\" \\"$BUGSEE_XCODE\\""',
  '',
].join('\n');

/**
 * Expo's bundle phase sets ENTRY_FILE, CLI_PATH and BUNDLE_COMMAND, then
 * runs react-native-xcode.sh. Replacing the whole phase would drop those
 * and the Expo bundle would not be the one bugsee-xcode.sh injects into.
 * Swap only that invocation. Resolve the hook the way Expo resolves
 * react-native-xcode.sh, so a hoisted node_modules still finds it.
 */
const EXPO_XCODE_INVOCATION =
  /`"\$NODE_BINARY" --print "require\('path'\)\.dirname\(require\.resolve\('react-native\/package\.json'\)\) \+ '\/scripts\/react-native-xcode\.sh'"`/;

const EXPO_REPLACEMENT = [
  'export REACT_NATIVE_PATH="$("$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\'))")"',
  'BUGSEE_XCODE="$("$NODE_BINARY" --print "require(\'path\').join(require(\'path\').dirname(require.resolve(\'@bugsee/react-native/package.json\')), \'scripts/bugsee-xcode.sh\')")"',
  '/bin/bash "$BUGSEE_XCODE"',
].join('\n');

export interface BundlePhaseSettings {
  /** `false` exports BUGSEE_UPLOAD_SOURCEMAPS=false for bugsee-xcode.sh. */
  readonly uploadSourcemaps?: boolean;
  /** Exported as BUGSEE_PLUGIN_APP_TOKEN, ahead of every other token source. */
  readonly iosAppToken?: string;
}

const SETTINGS_BEGIN = '# >>> bugsee settings, written by the @bugsee/react-native config plugin';
const SETTINGS_END = '# <<< bugsee settings';

function settingsBlock(settings: BundlePhaseSettings): string | null {
  const lines: string[] = [];
  if (settings.uploadSourcemaps === false) {
    lines.push('export BUGSEE_UPLOAD_SOURCEMAPS=false');
  }
  if (settings.iosAppToken) {
    lines.push(`export BUGSEE_PLUGIN_APP_TOKEN='${settings.iosAppToken}'`);
  }
  if (lines.length === 0) {
    return null;
  }
  return [SETTINGS_BEGIN, ...lines, SETTINGS_END].join('\n');
}

function stripSettings(script: string): string {
  const begin = script.indexOf(SETTINGS_BEGIN);
  const end = script.indexOf(SETTINGS_END);
  if (begin < 0 || end < begin) {
    return script;
  }
  let stop = end + SETTINGS_END.length;
  if (script[stop] === '\n') {
    stop += 1;
  }
  return script.slice(0, begin) + script.slice(stop);
}

export const UNRECOGNISED_BUNDLE_PHASE =
  'Bundle React Native code and images does not run react-native-xcode.sh the way React Native ' +
  "or Expo's templates do, so the Bugsee hook cannot be wired into it. Run bugsee-xcode.sh " +
  'from that phase yourself, or regenerate it with `expo prebuild --clean`.';

/**
 * Wires bugsee-xcode.sh into the bundle phase. Only the two shapes the
 * templates write are rewritten; any other script is refused rather than
 * guessed at. A phase this plugin already rewrote keeps its body and gets
 * its settings block replaced, so a later prebuild can change them.
 */
export function rewriteBundlePhase(script: string, settings: BundlePhaseSettings = {}): string {
  const base = stripSettings(script);
  let body: string;
  if (base.includes('bugsee-xcode.sh')) {
    body = base;
  } else if (EXPO_XCODE_INVOCATION.test(base)) {
    body = base.replace(EXPO_XCODE_INVOCATION, EXPO_REPLACEMENT);
  } else if (base.includes('with-environment.sh') && base.includes('react-native-xcode.sh')) {
    body = BARE_BUNDLE_SCRIPT;
  } else {
    throw new Error(UNRECOGNISED_BUNDLE_PHASE);
  }
  const block = settingsBlock(settings);
  return block ? `${block}\n${body}` : body;
}

export interface ShellPhase {
  isa?: string;
  name?: string;
  shellScript?: string;
}

export interface XcodeProjectLike {
  hash?: {
    project?: {
      objects?: {
        PBXShellScriptBuildPhase?: Record<string, ShellPhase | string | undefined>;
      };
    };
  };
}

export function rewriteProjectBundlePhase(
  project: XcodeProjectLike,
  settings: BundlePhaseSettings = {},
): void {
  const section = project.hash?.project?.objects?.PBXShellScriptBuildPhase;
  if (!section) {
    throw new Error('PBXShellScriptBuildPhase is missing from the Xcode project');
  }
  const BUNDLE_PHASE = 'Bundle React Native code and images';
  let found = false;
  // `<id>_comment` entries are strings; a phase is an object.
  for (const phase of Object.values(section)) {
    if (typeof phase !== 'object' || decodePbxString(phase.name ?? '') !== BUNDLE_PHASE) {
      continue;
    }
    if (typeof phase.shellScript !== 'string') {
      throw new Error('Bundle React Native code and images has no shellScript');
    }
    const quoted = phase.shellScript.startsWith('"');
    const next = rewriteBundlePhase(decodePbxString(phase.shellScript), settings);
    phase.shellScript = quoted ? encodePbxString(next) : next;
    found = true;
  }
  if (!found) {
    throw new Error('Bundle React Native code and images build phase not found');
  }
}
