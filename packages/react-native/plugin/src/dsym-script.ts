// Archive post-action inserted into the Expo scheme. After NODE_BINARY is
// known, ${PROJECT_DIR}/.. is passed to node as the app root. The wrapper is
// resolved from that root, @bugsee/cli from the wrapper directory (a nested
// install is not visible from the app root), and the native optional
// dependency from the CLI directory. Otherwise the JS entry comes from the
// CLI package bin field. Without a real token (none, or the placeholder) the
// script stops, exit 0, before any of that (TOKEN_GUARD). A token or endpoint
// the Expo plugin baked in comes first; the environment, .xcode.env(.local) and
// credentials.json follow it.

const locateBugseeCliPackage = [
  "const path = require('path');",
  'const appRoot = process.argv[1];',
  "const wrapperPkg = require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] });",
  'const wrapperDir = path.dirname(wrapperPkg);',
  "const cliPkg = require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] });",
  'const cliDir = path.dirname(cliPkg);',
].join(' ');

/** Node --print source. Prints the CLI package.json path, or '' when missing. */
export const RESOLVE_BUGSEE_CLI_PACKAGE = `try { ${locateBugseeCliPackage} cliPkg; } catch (e) { '' }`;

export function resolveNativeCliPackageSource(packageJson: string): string {
  return `try { ${locateBugseeCliPackage} require.resolve('${packageJson}', { paths: [cliDir] }); } catch (e) { '' }`;
}

const resolveBugseeCliJsSource = `try { const fs = require('fs'); ${locateBugseeCliPackage} const rel = JSON.parse(fs.readFileSync(cliPkg, 'utf8')).bin['bugsee-cli']; rel ? path.join(cliDir, rel) : ''; } catch (e) { '' }`;

function nodePrint(source: string): string {
  return `"$("$NODE_BINARY" --print "${source}" "$APP_ROOT")"`;
}

function tokenSource(bakedToken: string | undefined): string[] {
  if (!bakedToken) {
    return ['TOKEN="$BUGSEE_APP_TOKEN"'];
  }
  return [`TOKEN='${bakedToken}'`, 'if [ -z "$TOKEN" ]; then', '  TOKEN="$BUGSEE_APP_TOKEN"', 'fi'];
}

/**
 * Stops the post-action, with exit 0 and one warning, when there is no real
 * app token. `xcode post-action` registers the build and uploads dSYMs to the
 * configured endpoint, or to the CLI's own default, production, when none is
 * set; the placeholder token must reach neither. The rule is
 * `isPlaceholderToken` (properties.ts) in POSIX sh: every dash goes first, and
 * whitespace too, because the CLI trims the token before it builds the URL.
 * The character lists are spelled out: a bracket range can follow the locale.
 * Shared with the bare example's scheme (scripts/__tests__/dsym-scheme-post-action.test.ts).
 */
export const TOKEN_GUARD: readonly string[] = [
  'TOKEN_CHECK=$(printf \'%s\' "$TOKEN" | /usr/bin/tr -d \' \\t\\r\\n-\')',
  'if [ -z "$TOKEN_CHECK" ]; then',
  '  echo "warning: bugsee: dSYM upload skipped: no app token is configured"',
  '  exit 0',
  'fi',
  'case "$TOKEN_CHECK" in',
  '  000000000000[0123456789abcdefABCDEF]000[0123456789abcdefABCDEF]000000000000000)',
  '    echo "warning: bugsee: dSYM upload skipped: the app token is the placeholder"',
  '    exit 0',
  '    ;;',
  'esac',
];

/**
 * Looks for the token in ios/.xcode.env and ios/.xcode.env.local, the files
 * the README sends a bare app's `export BUGSEE_APP_TOKEN=...` to for the
 * bundle phase. A GUI Archive does not inherit a shell, so the post-action
 * reads them itself, and only when no earlier source gave a token. Each file
 * is sourced in a subshell that prints the token: a file written for bash, a
 * syntax error or an `exit` in it cannot stop this script or change its
 * NODE_BINARY or BUGSEE_ENDPOINT, and the later file (.local) wins. Shared
 * with the bare example's scheme (scripts/__tests__/dsym-scheme-post-action.test.ts).
 */
export const ENV_FILE_TOKEN: readonly string[] = [
  'if [ -z "$TOKEN" ]; then',
  '  for ENV_FILE in "${PROJECT_DIR}/.xcode.env" "${PROJECT_DIR}/.xcode.env.local"; do',
  '    if [ -f "$ENV_FILE" ]; then',
  '      ENV_TOKEN=$( ( . "$ENV_FILE" >/dev/null 2>&1; if [ -n "$BUGSEE_APP_TOKEN" ]; then printf \'%s\' "$BUGSEE_APP_TOKEN"; else printf \'%s\' "$BUGSEE_TOKEN_IOS"; fi ) 2>/dev/null || true )',
  '      if [ -n "$ENV_TOKEN" ]; then',
  '        TOKEN="$ENV_TOKEN"',
  '      fi',
  '    fi',
  '  done',
  'fi',
];

/**
 * Relays bugsee-cli output with Xcode's `error:` diagnostics turned into
 * `warning: bugsee: ...`, and returns the CLI's exit status. A failed upload
 * must never read as a build error. Post-action output is not parsed for
 * diagnostics, but every place that relays the CLI does this the same way
 * (scripts/hermes-sourcemaps.js `diagnosticSafe`, and the bare example's
 * scheme, which tests this shared text).
 */
export const CLI_OUTPUT_FILTER: readonly string[] = [
  '# An "error:" line reads as a build error to Xcode; a failed upload is a warning.',
  'run_cli() {',
  '  CLI_OUT=$("$@" 2>&1)',
  '  CLI_RC=$?',
  '  if [ -n "$CLI_OUT" ]; then',
  '    printf \'%s\\n\' "$CLI_OUT" | /usr/bin/sed -E \'s/^(.*: )?([Ff]atal [Ee]rror|[Ee]rror): (.*)$/warning: bugsee: \\3/\'',
  '  fi',
  '  return $CLI_RC',
  '}',
];

/**
 * The Archive post-action script. `bakedToken` is the plugin's iOS token,
 * written into the script so an Archive from the Xcode GUI, which does not
 * inherit a shell environment, still has one. `bakedEndpoint`, the plugin's
 * validated `endpoint` option, is exported the same way, ahead of the
 * environment and credentials.json; without it the CLI keeps its default.
 */
export function dsymPostActionScript(bakedToken?: string, bakedEndpoint?: string): string {
  return [
    'CREDS="${PROJECT_DIR}/../credentials.json"',
    ...(bakedEndpoint ? [`export BUGSEE_ENDPOINT='${bakedEndpoint}'`] : []),
    ...tokenSource(bakedToken),
    'if [ -z "$TOKEN" ]; then',
    '  TOKEN="$BUGSEE_TOKEN_IOS"',
    'fi',
    ...ENV_FILE_TOKEN,
    'if [ -z "$TOKEN" ] && [ -f "$CREDS" ]; then',
    '  TOKEN=$(/usr/bin/plutil -extract ios raw -o - "$CREDS" 2>/dev/null || true)',
    'fi',
    ...TOKEN_GUARD,
    ...CLI_OUTPUT_FILTER,
    'if [ -n "$TOKEN" ]; then',
    '  export BUGSEE_APP_TOKEN="$TOKEN"',
    'fi',
    'if [ -z "$BUGSEE_ENDPOINT" ] && [ -f "$CREDS" ]; then',
    '  ENDPOINT=$(/usr/bin/plutil -extract endpoint raw -o - "$CREDS" 2>/dev/null || true)',
    '  if [ -n "$ENDPOINT" ]; then',
    '    export BUGSEE_ENDPOINT="$ENDPOINT"',
    '  fi',
    'fi',
    '',
    "# Archive's PATH has no node, and the npm shim's shebang searches PATH.",
    'if [ ! -x "$NODE_BINARY" ]; then',
    '  if [ -f "${PROJECT_DIR}/.xcode.env" ]; then',
    '    . "${PROJECT_DIR}/.xcode.env"',
    '  fi',
    '  if [ -f "${PROJECT_DIR}/.xcode.env.local" ]; then',
    '    . "${PROJECT_DIR}/.xcode.env.local"',
    '  fi',
    'fi',
    'if [ ! -x "$NODE_BINARY" ]; then',
    '  RN_FIND=""',
    '  if [ -n "$REACT_NATIVE_PATH" ] && [ -f "$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh" ]; then',
    '    RN_FIND="$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh"',
    '  elif [ -f "${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh" ]; then',
    '    RN_FIND="${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh"',
    '  fi',
    '  if [ -n "$RN_FIND" ]; then',
    '    NODE_BINARY=$(/bin/bash -c \'. "$1" >/dev/null 2>&1; command -v node\' _ "$RN_FIND" || true)',
    '  fi',
    'fi',
    'if [ -n "$NODE_BINARY" ] && [ -x "$NODE_BINARY" ]; then',
    '  PATH="$(dirname "$NODE_BINARY"):$PATH"',
    '  export PATH NODE_BINARY',
    '  APP_ROOT="${PROJECT_DIR}/.."',
    '  if [ "$(uname -m)" = "x86_64" ]; then',
    `    NATIVE_PKG=${nodePrint(resolveNativeCliPackageSource('@bugsee/cli-darwin-x64/package.json'))}`,
    '  else',
    `    NATIVE_PKG=${nodePrint(resolveNativeCliPackageSource('@bugsee/cli-darwin-arm64/package.json'))}`,
    '  fi',
    '  if [ -n "$NATIVE_PKG" ]; then',
    '    NATIVE_BIN="$(dirname "$NATIVE_PKG")/bin/bugsee-cli"',
    '    if [ -x "$NATIVE_BIN" ]; then',
    '      run_cli "$NATIVE_BIN" xcode post-action',
    '      exit $?',
    '    fi',
    '  fi',
    `  CLI_JS=${nodePrint(resolveBugseeCliJsSource)}`,
    '  if [ -n "$CLI_JS" ]; then',
    '    run_cli "$NODE_BINARY" "$CLI_JS" xcode post-action',
    '    exit $?',
    '  fi',
    'fi',
    '',
    'echo "bugsee-cli: not found" >&2',
    'exit 1',
    '',
  ].join('\n');
}

export const DSYM_POST_ACTION_SCRIPT = dsymPostActionScript();
