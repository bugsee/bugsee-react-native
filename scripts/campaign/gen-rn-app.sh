#!/usr/bin/env bash
#
# N-21 / N-22: generates one bare React Native app on a given minor and
# integrates @bugsee/react-native into it the way the package README says,
# from the packed tarball (scripts/campaign/pack.sh), outside this repo.
#
#   gen-rn-app.sh <minor> [--engine hermes|jsc] [--pm npm|yarn|pnpm]
#                 [--readme-only] [--no-workarounds] [--smoke <dir>]
#
#   <minor>        0.81 .. 0.87 (0.87 is examples/bare; generate it only for a
#                  variant such as --engine jsc)
#   --engine jsc   N-22: Hermes off, through @react-native-community/javascriptcore
#                  wired as that package's README says.
#   --pm <pm>      N-23 / MX-PACK: the package manager the app installs with.
#                  npm (default); yarn = Yarn 4 with the node-modules linker
#                  (corepack); pnpm with nodeLinker: hoisted, which React
#                  Native itself requires (its Gradle settings include
#                  ../node_modules/@react-native/gradle-plugin).
#   --readme-only  apply only what packages/react-native/README.md says.
#                  Without it the deviations the README is missing (R-2, R-3
#                  in campaign-prep-build.md) are applied too and each one is
#                  logged with a "DEVIATION" line, so a README bug is never
#                  silently papered over.
#   --no-workarounds  leave out the WORKAROUND steps for product bugs (W-*),
#                  to reproduce them.
#   --smoke <dir>  copy the N-01 smoke module (App.tsx, index.js and whatever
#                  else <dir> holds) over the generated app instead of the
#                  launch-check App in scripts/campaign/template.
#
# Environment:
#   CAMPAIGN_APPS   where apps go (default: <repo>/../campaign-apps)
#   RN_CLI_VERSION  @react-native-community/cli used for init (default 20.2.0)
#
# Output: $CAMPAIGN_APPS/rn0<minor>[-jsc]/, with package and bundle id
# com.bugsee.campaign.rn0<minor>[jsc], the placeholder token and the dead
# endpoint in campaign-config.json, and gen.log listing every step.
set -euo pipefail

# One function, so bash parses the whole script before running any of it.
main() {
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/scripts/campaign"
MINOR="${1:?usage: gen-rn-app.sh <minor, e.g. 0.81> [--engine jsc] [--readme-only] [--smoke dir]}"
shift
ENGINE=hermes
README_ONLY=0
WORKAROUNDS=1
SMOKE=""
PM=npm
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --readme-only) README_ONLY=1; shift ;;
    --no-workarounds) WORKAROUNDS=0; shift ;;
    --smoke) SMOKE="$(cd "$2" && pwd)"; shift 2 ;;
    --pm) PM="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$ENGINE" == hermes || "$ENGINE" == jsc ]] || { echo "--engine hermes|jsc" >&2; exit 2; }
case "$PM" in npm|yarn|pnpm) ;; *) echo "--pm npm|yarn|pnpm" >&2; exit 2 ;; esac
[[ "$MINOR" =~ ^0\.8[1-7]$ ]] || { echo "minor must be 0.81..0.87" >&2; exit 2; }

APPS="${CAMPAIGN_APPS:-$(cd "$REPO/.." && pwd)/campaign-apps}"
TARBALLS="$APPS/tarballs"
CORE_TGZ="$(ls "$TARBALLS"/bugsee-react-native-[0-9]*.tgz 2>/dev/null | head -1 || true)"
[[ -n "$CORE_TGZ" ]] || { echo "no tarball in $TARBALLS; run scripts/campaign/pack.sh first" >&2; exit 1; }

NUM="${MINOR#0.}"
SUFFIX=""
CAP=""
PORT=$((8100 + NUM))
if [[ "$ENGINE" == jsc ]]; then SUFFIX="jsc"; CAP="Jsc"; PORT=$((8200 + NUM)); fi
if [[ "$README_ONLY" -eq 1 ]]; then SUFFIX="${SUFFIX}readme"; CAP="${CAP}Readme"; PORT=$((8600 + NUM)); fi
case "$PM" in
  yarn) SUFFIX="${SUFFIX}yarn"; CAP="${CAP}Yarn"; PORT=$((8400 + NUM)) ;;
  pnpm) SUFFIX="${SUFFIX}pnpm"; CAP="${CAP}Pnpm"; PORT=$((8500 + NUM)) ;;
esac
NAME="Rn0${NUM}${CAP}"                # Rn081, Rn087Jsc
ID="com.bugsee.campaign.rn0${NUM}${SUFFIX}"
DIR="$APPS/rn0${NUM}${SUFFIX:+-$SUFFIX}"
VERSION="$(npm view "react-native@~${MINOR}.0" version --json | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(Array.isArray(v)?v[v.length-1]:v)')"

mkdir -p "$APPS"
rm -rf "$DIR"
LOG_DIR="$APPS/logs"
mkdir -p "$LOG_DIR"
GEN_LOG="$APPS/logs/gen-rn0${NUM}${SUFFIX:+-$SUFFIX}.log"
: > "$GEN_LOG"
log() { echo "$*" | tee -a "$GEN_LOG"; }
deviation() { log "DEVIATION $*"; }

log "== generating $NAME: react-native $VERSION, engine $ENGINE, id $ID"
log "   into $DIR from $(basename "$CORE_TGZ")"

# 1. The template, exactly as `npx @react-native-community/cli init` writes it.
(cd "$APPS" && npx --yes "@react-native-community/cli@${RN_CLI_VERSION:-20.2.0}" init "$NAME" \
  --version "$VERSION" --directory "$DIR" --package-name "$ID" \
  --skip-install --skip-git-init --install-pods false) >>"$GEN_LOG" 2>&1
log "-- template written"

cd "$DIR"
# The app is outside this repo, so none of the workspace's Yarn settings
# reach it. The README says `yarn add`; from a tarball every package manager
# resolves the same files.
pm_add() {
  case "$PM" in
    npm) npm install --no-audit --no-fund "$@" ;;
    yarn) yarn add "$@" ;;
    pnpm) pnpm add "$@" ;;
  esac
}
case "$PM" in
  npm) npm install --no-audit --no-fund >>"$GEN_LOG" 2>&1 ;;
  yarn)
    printf 'nodeLinker: node-modules\nenableTelemetry: false\n' > .yarnrc.yml
    rm -f package-lock.json
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack use yarn@4.11.0 >>"$GEN_LOG" 2>&1 ;;
  pnpm)
    # pnpm 11 reads its settings from pnpm-workspace.yaml, not .npmrc.
    printf 'nodeLinker: hoisted\n' > pnpm-workspace.yaml
    pnpm install >>"$GEN_LOG" 2>&1 ;;
esac
log "-- template dependencies installed ($PM $($PM --version))"

# 2. README "Install": the package (from the packed tarball, since it is not
#    published yet).
if [[ "$PM" == pnpm ]]; then
  # pnpm 10+ runs no dependency build script unless allowed, and pnpm 11
  # fails the install over it: @bugsee/cli has a postinstall. The README does
  # not say so (R-4).
  printf "allowBuilds:\n  '@bugsee/cli': true\n" >> pnpm-workspace.yaml
  deviation "R-4 pnpm: @bugsee/cli's postinstall allowed (allowBuilds in pnpm-workspace.yaml)"
fi
if [[ "$PM" == yarn ]]; then
  pm_add "@bugsee/react-native@file:$CORE_TGZ" >>"$GEN_LOG" 2>&1
else
  pm_add "$CORE_TGZ" >>"$GEN_LOG" 2>&1
fi
log "README install: $PM add $(basename "$CORE_TGZ")"

# 3. Engine (N-22). JSC left core react-native; the community package's
#    README is followed: gradle.properties, the pod install flags (step 8),
#    and the runtime factory in AppDelegate / MainApplication.
if [[ "$ENGINE" == jsc ]]; then
  pm_add @react-native-community/javascriptcore >>"$GEN_LOG" 2>&1
  node "$HERE/lib/use-jsc.js" "$DIR" >>"$GEN_LOG"
  log "JSC: @react-native-community/javascriptcore $(node -p "require('@react-native-community/javascriptcore/package.json').version"): hermesEnabled=false, useThirdPartyJSC=true, runtime factories"
fi

# 4. README "Android source maps": the two edits in android/app/build.gradle.
node "$HERE/lib/readme-android.js" android/app/build.gradle >>"$GEN_LOG"
log "README android: bugseeDir + react.hermesCommand + apply from bugsee-sourcemaps.gradle"

# 5. Deviations: what examples/bare needs and the package README does not say.
if [[ "$README_ONLY" -eq 0 ]]; then
  node "$HERE/lib/deviation-gradle-plugin.js" "$DIR/android" "$REPO/native-versions.json" >>"$GEN_LOG"
  deviation "R-2 Bugsee Gradle plugin: mavenCentral() in pluginManagement, root plugins{} pin, app apply plugin, bugsee.properties (placeholder: no token)"
  node "$HERE/lib/deviation-ios-bundle-phase.js" "$DIR/ios/$NAME.xcodeproj/project.pbxproj" >>"$GEN_LOG"
  deviation "R-3 iOS bundle phase runs scripts/bugsee-xcode.sh instead of react-native-xcode.sh"
fi

# 6. Harness support (not integration): a release build the e2e can run-as
#    into, as examples/bare does with -PbugseeE2eDebuggable=true.
node -e '
  const fs=require("fs"); const f=process.argv[1]; let s=fs.readFileSync(f,"utf8");
  s=s.replace(/(release \{\n)/, "$1            debuggable findProperty(\"bugseeE2eDebuggable\") == \"true\" // campaign harness\n");
  fs.writeFileSync(f,s);' android/app/build.gradle
log "harness: release { debuggable findProperty(bugseeE2eDebuggable) }"

# 7. The app: README "Use" (launch with options), the placeholder token and the
#    dead endpoint, never a real one.
cat > campaign-config.json <<'JSON'
{
  "ios": "00000000-0000-4000-8000-000000000000",
  "android": "00000000-0000-4000-8000-000000000000",
  "endpoint": "https://127.0.0.1:9"
}
JSON
if [[ -n "$SMOKE" ]]; then
  cp -R "$SMOKE"/. .
  log "app: N-01 smoke module from $SMOKE"
else
  cp "$HERE/template/App.tsx" App.tsx
  log "app: launch-check App.tsx (scripts/campaign/template)"
fi
# tsconfig: resolveJsonModule for campaign-config.json.
node -e '
  const fs=require("fs");
  // Template tsconfigs are JSONC (comments, trailing commas).
  const t=new Function("return (" + fs.readFileSync("tsconfig.json","utf8") + ")")();
  t.compilerOptions={...(t.compilerOptions||{}), resolveJsonModule:true};
  fs.writeFileSync("tsconfig.json", JSON.stringify(t,null,2)+"\n");'

# 7b. Harness support: this app's own Metro port (lib/metro-port.js).
node "$HERE/lib/metro-port.js" "$DIR" "$PORT" >>"$GEN_LOG"
log "harness: Metro port $PORT (campaign.port, RCT_METRO_PORT on React-Core)"

# 8. iOS: README says CocoaPods before 0.87, SPM from 0.87.
if [[ "$NUM" -ge 87 ]]; then
  log "README ios: 0.87+ resolves the SDK through SPM (pod install still sets up React Native)"
fi
# WORKAROUND W-1 (product bug, see campaign-prep-build.md): the packed
#     podspecs read ../../native-versions.json and the wrapper's
#     android/build.gradle walks up for it, but the file is not in the
#     tarball, so neither `pod install` nor Gradle configures from a real
#     install. <app>/node_modules/native-versions.json satisfies both lookups.
#     --no-workarounds leaves it out, to reproduce the bug.
#     Applied last: a later npm install prunes it from node_modules.
if [[ "$WORKAROUNDS" -eq 1 ]]; then
  cp "$REPO/native-versions.json" node_modules/native-versions.json
  PKG_REAL="$(node -p "require('fs').realpathSync(require('path').dirname(require.resolve('@bugsee/react-native/package.json')))")"
  [[ -f "$PKG_REAL/../../native-versions.json" ]] || cp "$REPO/native-versions.json" "$PKG_REAL/../../native-versions.json"
  log "WORKAROUND W-1 native-versions.json copied to node_modules/ (not in the tarball)"
fi

POD_ENV=()
[[ "$ENGINE" == jsc ]] && POD_ENV=(USE_THIRD_PARTY_JSC=1 USE_HERMES=0)
(cd ios && env "${POD_ENV[@]+"${POD_ENV[@]}"}" pod install) >>"$GEN_LOG" 2>&1
log "README ios: pod install"
if node "$HERE/lib/workaround-fmt.js" ios | tee -a "$GEN_LOG" | grep -q NEEDS_POD_INSTALL; then
  (cd ios && env "${POD_ENV[@]+"${POD_ENV[@]}"}" pod install) >>"$GEN_LOG" 2>&1
  log "WORKAROUND W-3 fmt 11.x built as C++17 (React Native + Xcode 26.4+), pod install again"
fi

# 9. Consumer type-check (API-48/49): the app, plus campaign-consumer-check.ts
#    (every public export, and every removed 6.x API a compile error), with
#    the template's TypeScript and with TypeScript 6.
cp "$HERE/template/campaign-consumer-check.ts" .
TS_VERSION="$(node -p "require('typescript/package.json').version")"
# A failure is reported and the generator exits 3, but only after the app is
# complete: the type errors are the finding, the app still builds.
TSC_RC=0
npx tsc --noEmit >>"$GEN_LOG" 2>&1 && log "tsc $TS_VERSION --noEmit: clean" || { log "tsc $TS_VERSION --noEmit: FAILED (see $GEN_LOG)"; TSC_RC=3; }
npx --yes -p typescript@6 tsc --noEmit >>"$GEN_LOG" 2>&1 && log "tsc 6 --noEmit: clean" || { log "tsc 6 --noEmit: FAILED (see $GEN_LOG)"; TSC_RC=3; }

log "== done: $DIR"
return "$TSC_RC"
}

main "$@"
