#!/bin/bash
# Compose the Hermes source map, then inject a debug id into that composed
# map and into the JavaScript hermesc compiles, then upload that map with
# bugsee-cli. The upload needs a real app token: BUGSEE_PLUGIN_APP_TOKEN (the
# Expo plugin bakes it into this phase), BUGSEE_APP_TOKEN, BUGSEE_TOKEN_IOS,
# or `ios` in ../credentials.json. BUGSEE_UPLOAD_SOURCEMAPS=false turns it off.
# Debug configurations skip it unless BUGSEE_UPLOAD_DEBUG_SOURCEMAPS=true.
# Without a token, or with the placeholder, one build-log line says it skipped.
# A failed upload warns; it never fails the build.

set -euo pipefail

# react-native-xcode.sh cds to PROJECT_ROOT before compose. CocoaPods expands
# REACT_NATIVE_PATH to an absolute path; SPM leaves it relative to ios/
# (`../node_modules/react-native`). Resolve it while cwd is still SRCROOT, or
# Node looks for the composer under the project root after that cd.
REACT_NATIVE_PATH="$(cd "$REACT_NATIVE_PATH" && pwd)"
export REACT_NATIVE_PATH

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_XCODE="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"
BUNDLE_NAME="${BUNDLE_NAME:-main}"

if [[ -z "${SOURCEMAP_FILE:-}" ]]; then
  mkdir -p "$CONFIGURATION_TEMP_DIR"
  export SOURCEMAP_FILE="$CONFIGURATION_TEMP_DIR/${BUNDLE_NAME}.jsbundle.composed.map"
fi

export BUGSEE_JS_BUNDLE="${CONFIGURATION_BUILD_DIR}/${BUNDLE_NAME}.jsbundle"
export BUGSEE_BYTECODE_BUNDLE="${CONFIGURATION_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/${BUNDLE_NAME}.jsbundle"
export BUGSEE_REAL_COMPOSE="$REACT_NATIVE_PATH/scripts/compose-source-maps.js"
export COMPOSE_SOURCEMAP_PATH="$HOOK_DIR/compose-then-inject.js"
export BUGSEE_CREDENTIALS_FILE="${BUGSEE_CREDENTIALS_FILE:-${SRCROOT}/../credentials.json}"

if [[ "${CONFIGURATION:-}" == *Debug* ]]; then
  export BUGSEE_HERMES_ARGS="-Og -output-source-map"
else
  export BUGSEE_HERMES_ARGS="-O -output-source-map"
fi

resolve_hermesc() {
  if [[ -n "${HERMES_CLI_PATH:-}" && -x "$HERMES_CLI_PATH" ]]; then
    echo "$HERMES_CLI_PATH"
    return
  fi
  if [[ -n "${PODS_ROOT:-}" && -x "$PODS_ROOT/hermes-engine/destroot/bin/hermesc" ]]; then
    echo "$PODS_ROOT/hermes-engine/destroot/bin/hermesc"
    return
  fi
  REACT_NATIVE_PATH="$REACT_NATIVE_PATH" "$NODE_BINARY" -e '
    const fs = require("fs");
    const path = require("path");
    try {
      const pkg = require.resolve("hermes-compiler/package.json", {
        paths: [process.env.REACT_NATIVE_PATH],
      });
      const bin = path.join(path.dirname(pkg), "hermesc", "osx-bin", "hermesc");
      if (fs.existsSync(bin)) process.stdout.write(bin);
    } catch (e) {}
  '
}

if [[ "${USE_HERMES:-true}" != "false" ]]; then
  export BUGSEE_HERMESC="$(resolve_hermesc)"
fi

/bin/sh "$REAL_XCODE"

# No compose step when Hermes is off. The map Metro wrote is the one to inject
# and upload. With Hermes on, compose-then-inject.js has already uploaded.
if [[ "${USE_HERMES:-true}" == "false" && -f "$BUGSEE_BYTECODE_BUNDLE" && -f "$SOURCEMAP_FILE" ]]; then
  "$NODE_BINARY" "$HOOK_DIR/hermes-sourcemaps.js" inject \
    --bundle "$BUGSEE_BYTECODE_BUNDLE" \
    --composed "$SOURCEMAP_FILE"
  "$NODE_BINARY" "$HOOK_DIR/hermes-sourcemaps.js" upload \
    --composed "$SOURCEMAP_FILE" \
    --platform ios \
    --configuration "${CONFIGURATION:-}" \
    --credentials "$BUGSEE_CREDENTIALS_FILE" \
    --app-version "${MARKETING_VERSION:-}" \
    --app-build "${CURRENT_PROJECT_VERSION:-}"
fi
