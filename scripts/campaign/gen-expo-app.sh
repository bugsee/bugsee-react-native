#!/usr/bin/env bash
#
# N-20 / MX-EXPO: one Expo app per SDK, built from the blank template, with
# @bugsee/react-native installed from the packed tarball, the config plugin in
# app.json as the package README shows (no options: the placeholder token
# never goes into native files), examples/expo's App.js (N-20 smoke wiring)
# and `expo prebuild --clean`. Outside this repo.
#
#   gen-expo-app.sh <sdk> [--plugin-options '<json>'] [--with-feedback]
#
#   <sdk>              54 (RN 0.81), 55 (0.83), 56 (0.85) or 57 (0.86)
#   --plugin-options   the plugin's options object for a PLG-* variant, e.g.
#                      '{"uploadSymbols":false}' (never a real token)
#   --with-feedback    also install @bugsee/react-native-feedback (PLG-12)
#
# Output: $CAMPAIGN_APPS/expo<sdk>/ (package/bundle id
# com.bugsee.campaign.expo<sdk>), Metro port 8300+<sdk> in campaign.port,
# logs/gen-expo<sdk>.log. Build with build-app.sh, launch with
# launch-check.sh, exactly as the bare campaign apps.
set -euo pipefail

main() {
  local REPO HERE SDK PLUGIN_OPTIONS="" FEEDBACK=0
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  HERE="$REPO/scripts/campaign"
  SDK="${1:?usage: gen-expo-app.sh <54|55|56|57> [--plugin-options json] [--with-feedback]}"
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin-options) PLUGIN_OPTIONS="$2"; shift 2 ;;
      --with-feedback) FEEDBACK=1; shift ;;
      *) echo "unknown argument $1" >&2; exit 2 ;;
    esac
  done
  [[ "$SDK" =~ ^5[4-7]$ ]] || { echo "sdk must be 54..57" >&2; exit 2; }

  local APPS TARBALLS CORE_TGZ FB_TGZ DIR ID PORT GEN_LOG
  APPS="${CAMPAIGN_APPS:-$(cd "$REPO/.." && pwd)/campaign-apps}"
  TARBALLS="$APPS/tarballs"
  CORE_TGZ="$(ls "$TARBALLS"/bugsee-react-native-[0-9]*.tgz | head -1)"
  FB_TGZ="$(ls "$TARBALLS"/bugsee-react-native-feedback-[0-9]*.tgz | head -1)"
  DIR="$APPS/expo$SDK"
  ID="com.bugsee.campaign.expo$SDK"
  PORT=$((8300 + SDK))
  mkdir -p "$APPS/logs"
  GEN_LOG="$APPS/logs/gen-expo$SDK.log"
  : >"$GEN_LOG"
  log() { echo "$*" | tee -a "$GEN_LOG"; }

  rm -rf "$DIR"
  log "== generating expo$SDK from blank@sdk-$SDK into $DIR"
  (cd "$APPS" && npx --yes create-expo-app@latest "expo$SDK" --template "blank-typescript@sdk-$SDK" \
    --no-install --no-agents-md) >>"$GEN_LOG" 2>&1
  cd "$DIR"
  npm install --no-audit --no-fund >>"$GEN_LOG" 2>&1
  log "-- template: expo $(node -p "require('expo/package.json').version"), react-native $(node -p "require('react-native/package.json').version")"

  npm install --no-audit --no-fund "$CORE_TGZ" >>"$GEN_LOG" 2>&1
  log "README install: npm install $(basename "$CORE_TGZ")"
  if [[ "$FEEDBACK" -eq 1 ]]; then
    npm install --no-audit --no-fund "$FB_TGZ" >>"$GEN_LOG" 2>&1
    log "feedback: npm install $(basename "$FB_TGZ")"
  fi
  # WORKAROUND W-1: native-versions.json is not in the tarball (gen-rn-app.sh).
  cp "$REPO/native-versions.json" node_modules/native-versions.json
  log "WORKAROUND W-1 native-versions.json copied to node_modules/ (not in the tarball)"

  # app.json: ids, the e2e scheme, and the plugin as the README shows it.
  node -e '
    const fs = require("fs");
    const [id, opts] = process.argv.slice(1);
    const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
    const e = app.expo;
    e.ios = { ...(e.ios || {}), bundleIdentifier: id };
    e.android = { ...(e.android || {}), package: id };
    e.scheme = "bugsee-e2e";
    const plugin = opts ? ["@bugsee/react-native", JSON.parse(opts)] : "@bugsee/react-native";
    e.plugins = [...(e.plugins || []).filter((p) => (Array.isArray(p) ? p[0] : p) !== "@bugsee/react-native"), plugin];
    fs.writeFileSync("app.json", JSON.stringify(app, null, 2) + "\n");
  ' "$ID" "$PLUGIN_OPTIONS"
  log "app.json: ids $ID, scheme bugsee-e2e, plugin @bugsee/react-native ${PLUGIN_OPTIONS:-(no options)}"

  # The app: examples/expo's App.js and index.js (N-20) and its placeholder
  # config, in place of the template's App.tsx / index.ts.
  rm -f App.tsx App.js index.ts
  cp "$REPO/examples/expo/App.js" App.js
  cp "$REPO/examples/expo/index.js" index.js
  node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); p.main="index.js"; fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");' 
  cp "$REPO/examples/expo/campaign-config.json" campaign-config.json
  log "app: examples/expo/App.js (N-20)"

  CI=1 npx expo prebuild --clean --no-install >>"$GEN_LOG" 2>&1
  log "expo prebuild --clean: ok"
  grep -q 'com.bugsee.android.gradle' android/app/build.gradle && log "plugin: Bugsee Gradle plugin applied"
  grep -q 'bugsee-xcode.sh' ios/*.xcodeproj/project.pbxproj && log "plugin: iOS bundle phase runs bugsee-xcode.sh"

  # Harness support, as gen-rn-app.sh: debuggable release, own Metro port.
  node -e '
    const fs=require("fs"); const f="android/app/build.gradle"; let s=fs.readFileSync(f,"utf8");
    s=s.replace(/(\n\s*release \{\n)/, "$1            debuggable findProperty(\"bugseeE2eDebuggable\") == \"true\" // campaign harness\n");
    fs.writeFileSync(f,s);'
  node "$HERE/lib/metro-port.js" "$DIR" "$PORT" >>"$GEN_LOG"
  log "harness: debuggable release flag, Metro port $PORT"

  (cd ios && pod install) >>"$GEN_LOG" 2>&1
  log "pod install: ok"
  if node "$HERE/lib/workaround-fmt.js" ios | tee -a "$GEN_LOG" | grep -q NEEDS_POD_INSTALL; then
    (cd ios && pod install) >>"$GEN_LOG" 2>&1
    log "WORKAROUND W-3 fmt 11.x built as C++17 (React Native + Xcode 26.4+), pod install again"
  fi

  cp "$HERE/template/campaign-consumer-check.ts" .
  npx tsc --noEmit >>"$GEN_LOG" 2>&1 && log "tsc --noEmit: clean" || { log "tsc --noEmit: FAILED"; exit 1; }
  log "== done: $DIR"
}

main "$@"
