#!/usr/bin/env bash
#
# Installs the PACKED packages into a fresh React Native app, the way a
# customer gets them from npm, and checks what only a real install shows:
#
#   --typecheck  the app's own `tsc` (the template's TypeScript and tsconfig)
#                over a file importing both packages and the README "Use"
#                snippets, verbatim from the packed READMEs (API-49, R-1).
#   --android    Gradle configures the app with both modules autolinked
#                (BLK-17: the wrapper's build.gradle reads native-versions.json).
#   --ios        `pod install` evaluates both podspecs and vendors the SDK
#                (BLK-17: the podspecs read native-versions.json).
#
# The repo's own checks cannot see these: inside the workspace every lookup
# finds the repo root, and the repo's tsconfig is not a consumer's.
#
# Usage: check-pack-install.sh <react-native minor, e.g. 0.81> [--typecheck] [--android] [--ios]
#   PACK_INSTALL_DIR  keep the app here instead of a temporary directory
#   RN_CLI_VERSION    @react-native-community/cli used for init (default 20.2.0)
set -euo pipefail

RN="${1:?usage: check-pack-install.sh <react-native minor> [--typecheck] [--android] [--ios]}"
shift
TYPECHECK=0
ANDROID=0
IOS=0
for arg in "$@"; do
  case "$arg" in
    --typecheck) TYPECHECK=1 ;;
    --android) ANDROID=1 ;;
    --ios) IOS=1 ;;
    *) echo "unknown argument $arg" >&2; exit 2 ;;
  esac
done
[[ "$RN" =~ ^0\.[0-9]+$ ]] || { echo "minor must look like 0.81" >&2; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${PACK_INSTALL_DIR:-}" ]]; then
  WORK="$PACK_INSTALL_DIR"
  rm -rf "$WORK"
  mkdir -p "$WORK"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi

echo "--- packing (npm pack, prepack/postpack as on publish)"
mkdir -p "$WORK/tarballs"
for pkg in react-native react-native-feedback; do
  (cd "$REPO/packages/$pkg" && npm pack --silent --pack-destination "$WORK/tarballs" >/dev/null)
done
CORE_TGZ="$(ls "$WORK"/tarballs/bugsee-react-native-[0-9]*.tgz)"
FEEDBACK_TGZ="$(ls "$WORK"/tarballs/bugsee-react-native-feedback-[0-9]*.tgz)"
echo "    $(basename "$CORE_TGZ") $(basename "$FEEDBACK_TGZ")"

VERSION="$(npm view "react-native@~${RN}.0" version --json \
  | node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(Array.isArray(v) ? v[v.length - 1] : v)')"
echo "--- react-native ${VERSION}: template app"
(cd "$WORK" && npx --yes "@react-native-community/cli@${RN_CLI_VERSION:-20.2.0}" init PackProbe \
  --version "$VERSION" --directory "$WORK/app" \
  --skip-install --skip-git-init --install-pods false >/dev/null)
cd "$WORK/app"
npm install --no-audit --no-fund --loglevel=error >/dev/null
echo "--- installing the tarballs"
npm install --no-audit --no-fund --loglevel=error "$CORE_TGZ" "$FEEDBACK_TGZ" >/dev/null

if [[ "$TYPECHECK" -eq 1 ]]; then
  echo "--- consumer typecheck (tsc $(node -p "require('typescript/package.json').version"), the template's tsconfig)"
  # Every public export of both packages, through the package entry points a
  # consumer imports, so the compiler checks all the shipped modules.
  cat > bugsee-consumer.ts <<'TS'
import Bugsee, * as core from '@bugsee/react-native';
import * as feedback from '@bugsee/react-native-feedback';

export const surface = [Bugsee, core, feedback] as const;
TS
  # The README "Use" snippets, verbatim from the packed READMEs: what a reader
  # pastes must compile.
  node -e '
    const fs = require("fs");
    for (const [pkg, out] of [
      ["@bugsee/react-native", "readme-use-core.ts"],
      ["@bugsee/react-native-feedback", "readme-use-feedback.ts"],
    ]) {
      const readme = fs.readFileSync(require.resolve(pkg + "/README.md"), "utf8");
      const use = readme.slice(readme.indexOf("\n## Use\n"));
      const block = /```ts\n([\s\S]*?)```/.exec(use);
      if (readme.indexOf("\n## Use\n") < 0 || !block) {
        console.error("FAIL: no ts block under \"## Use\" in " + pkg + "/README.md");
        process.exit(1);
      }
      fs.writeFileSync(out, block[1] + "\nexport {};\n");
    }
  '
  npx tsc --noEmit
  echo "    typecheck clean"
fi

if [[ "$ANDROID" -eq 1 ]]; then
  echo "--- Gradle configuration"
  # `projects` configures every project (no configure-on-demand in the
  # template), so each autolinked module's build.gradle is evaluated.
  (cd android && ./gradlew projects --no-daemon --console=plain) > "$WORK/gradle-projects.log" 2>&1 \
    || { tail -40 "$WORK/gradle-projects.log"; echo "FAIL: Gradle configuration"; exit 1; }
  for module in ':bugsee_react-native' ':bugsee_react-native-feedback'; do
    grep -q "Project '${module}'" "$WORK/gradle-projects.log" \
      || { cat "$WORK/gradle-projects.log"; echo "FAIL: ${module} is not an autolinked project"; exit 1; }
  done
  echo "    configured with :bugsee_react-native and :bugsee_react-native-feedback"
fi

if [[ "$IOS" -eq 1 ]]; then
  echo "--- pod install"
  (cd ios && pod install) > "$WORK/pod-install.log" 2>&1 \
    || { tail -40 "$WORK/pod-install.log"; echo "FAIL: pod install"; exit 1; }
  for pod in BugseeReactNative BugseeReactNativeFeedback; do
    grep -q "^  - ${pod} (" ios/Podfile.lock \
      || { echo "FAIL: ${pod} is not in Podfile.lock"; exit 1; }
  done
  PKG_DIR="node_modules/@bugsee/react-native"
  IOS_SDK="$(node -p "require('./${PKG_DIR}/native-versions.json').ios.sdk")"
  [[ -d "$PKG_DIR/Bugsee.xcframework" ]] \
    || { echo "FAIL: the podspec did not vendor Bugsee.xcframework"; exit 1; }
  [[ "$(cat "$PKG_DIR/.bugsee-xcframework-version")" == "$IOS_SDK" ]] \
    || { echo "FAIL: vendored xcframework is not ${IOS_SDK}"; exit 1; }
  [[ -d "node_modules/@bugsee/react-native-feedback/BugseeFeedbackSources" ]] \
    || { echo "FAIL: the feedback podspec did not fetch its sources"; exit 1; }
  echo "    both pods installed; Bugsee.xcframework ${IOS_SDK} vendored"
fi

echo "PASS pack-install react-native ${VERSION}"
