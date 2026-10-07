#!/usr/bin/env bash
#
# Builds and installs the example on a real iPhone over the CocoaPods delivery
# path, asserting on the way that Bugsee.framework is embedded and linked.
#
#   BUGSEE_TOKEN_IOS        required
#   BUGSEE_ENDPOINT         optional; the bridge wants the /v2 suffix, which
#                           App.tsx appends
#   IOS_DEVICE_ID           defaults to the iPhone XS Phase 1 was verified on;
#                           only an e2e/device.ts allowlist entry is accepted
#   IOS_DEVELOPMENT_TEAM    required for a device build; no default, because a
#                           team id is per-developer
#   IOS_CONFIGURATION       Debug (default) or Release
#
# Campaign switches (N-27, MX-IOS-SPM), all optional:
#   IOS_DELIVERY            cocoapods (default) or spm. spm migrates ios/ with
#                           `npx react-native spm add --deintegrate --yes`
#                           (RN 0.87+ only), builds, asserts the embed,
#                           installs, then restores ios/ from git and re-runs
#                           pod install. IOS_SPM_KEEP=1 skips the restore.
#   IOS_TARGET              device (default) or simulator. simulator builds
#                           for iphonesimulator and installs on IOS_SIMULATOR_ID
#                           (default the campaign simulator 6FA9B3E8-...). The
#                           caller holds .device-lock (simulator) or
#                           .device-lock-xs (device), as for every device run.
#   IOS_APP_DIR             an app other than this example, e.g. a campaign
#                           app from scripts/campaign/gen-rn-app.sh. Its
#                           credentials are its own (campaign-config.json), so
#                           write-credentials is skipped and BUGSEE_TOKEN_IOS
#                           is not needed.
#   IOS_LAUNCH              1: after installing, launch the app with its
#                           console attached for IOS_LAUNCH_SECONDS (default
#                           40) and print the BUGSEE_E2E / Bugsee lines; exit
#                           non-zero unless IOS_LAUNCH_EXPECT (default
#                           "BUGSEE_E2E status=2", the contract of
#                           e2e/launch.test.ts) appears. The SDK banner is
#                           printed, never accepted: it comes before Launched.
#                           The device must already be held under its lock.
#
# The SwiftPM delivery path is the other configuration; see README.md.
set -euo pipefail

cd "$(dirname "$0")/.."
EXAMPLE_DIR="$(pwd)"
APP_DIR="${IOS_APP_DIR:-$EXAMPLE_DIR}"
APP_DIR="$(cd "$APP_DIR" && pwd)"
DELIVERY="${IOS_DELIVERY:-cocoapods}"
TARGET="${IOS_TARGET:-device}"
case "$DELIVERY" in cocoapods|spm) ;; *) echo "IOS_DELIVERY must be cocoapods or spm" >&2; exit 2 ;; esac
case "$TARGET" in device|simulator) ;; *) echo "IOS_TARGET must be device or simulator" >&2; exit 2 ;; esac

DEVICE="${IOS_DEVICE_ID:-345BA7FE-2C29-5722-892A-BFCB1FD34D0C}"
SIMULATOR="${IOS_SIMULATOR_ID:-6FA9B3E8-26C7-4232-AA2C-537D9DF32957}"
if [[ "$TARGET" == device ]]; then
  : "${IOS_DEVELOPMENT_TEAM:?set IOS_DEVELOPMENT_TEAM to your Apple Developer team id}"
  # The same fail-closed allowlist the e2e uses: never another iPhone.
  node -e '
    const id = process.argv[1].trim().toUpperCase();
    const src = require("fs").readFileSync(process.argv[2], "utf8");
    const allow = src.slice(src.indexOf("IOS_DEVICE_ALLOWLIST"), src.indexOf("IOS_DEVICE_REFUSED"));
    if (/^D027034D/i.test(id) || !allow.includes(`\x27${id}\x27`)) {
      console.error(`IOS_DEVICE_ID=${id} is not on the e2e/device.ts allowlist`);
      process.exit(1);
    }' "$DEVICE" "$EXAMPLE_DIR/e2e/device.ts"
fi
# Debug by default; Release for the gated E2E_RELEASE=1 device cases (Task 7.5b).
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
SCHEME="$(basename "$(ls -d "$APP_DIR"/ios/*.xcodeproj | head -1)" .xcodeproj)"
SDK=iphoneos
[[ "$TARGET" == simulator ]] && SDK=iphonesimulator
BUILD_DIR="ios/build"
[[ "$DELIVERY" == spm ]] && BUILD_DIR="ios/build-spm"
APP="$APP_DIR/$BUILD_DIR/Build/Products/${CONFIGURATION}-${SDK}/${SCHEME}.app"

if [[ "$APP_DIR" == "$EXAMPLE_DIR" ]]; then
  node scripts/write-credentials.mjs
fi

restore_cocoapods() {
  local status=$?
  set +e
  echo "--- restoring CocoaPods delivery in $APP_DIR/ios"
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$APP_DIR" checkout -- ios
    git -C "$APP_DIR" clean -fdq -- ios
  else
    rm -rf "$APP_DIR/ios"
    tar -xf "$SPM_BACKUP" -C "$APP_DIR"
  fi
  (cd "$APP_DIR/ios" && pod install >/dev/null) || { echo "restore: pod install failed"; exit 1; }
  # The SPM build leaves xcshareddata/swiftpm/Package.resolved behind.
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$APP_DIR" clean -fdq -- ios
  fi
  echo "--- restored"
  exit "$status"
}

if [[ "$DELIVERY" == spm ]]; then
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # The restore is a git checkout of ios/, so refuse to start over edits
    # it would throw away.
    git -C "$APP_DIR" diff --quiet -- ios \
      || { echo "ios/ has uncommitted changes; commit or stash them before IOS_DELIVERY=spm" >&2; exit 1; }
  else
    # A campaign app outside git: keep a copy of ios/ (without Pods/build).
    SPM_BACKUP="$(mktemp -t ios-cocoapods).tar"
    tar -cf "$SPM_BACKUP" -C "$APP_DIR" --exclude ios/Pods --exclude 'ios/build*' ios
  fi
  [[ "${IOS_SPM_KEEP:-0}" == 1 ]] || trap restore_cocoapods EXIT
  # --deintegrate leaves Podfile broken (README.md), hence the restore above.
  (cd "$APP_DIR" && npx react-native spm add --deintegrate --yes)
else
  (cd "$APP_DIR/ios" && pod install)
fi

PROJECT_ARGS=(-workspace "$APP_DIR/ios/$SCHEME.xcworkspace")
[[ -d "$APP_DIR/ios/$SCHEME.xcworkspace" ]] || PROJECT_ARGS=(-project "$APP_DIR/ios/$SCHEME.xcodeproj")
DESTINATION="id=$DEVICE"
SIGNING=(DEVELOPMENT_TEAM="${IOS_DEVELOPMENT_TEAM:-}" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
if [[ "$TARGET" == simulator ]]; then
  DESTINATION="id=$SIMULATOR"
  SIGNING=()
fi

xcodebuild \
  "${PROJECT_ARGS[@]}" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$APP_DIR/$BUILD_DIR" \
  ${SIGNING[@]+"${SIGNING[@]}"} \
  build

# Before installing, not after: an app that builds without the framework is the
# false pass this whole phase exists to rule out.
# One implementation of this check, in scripts/assert-framework-embedded.ts,
# where it is unit- and mutation-tested. It used to be a second shell copy.
#
# Invoked directly rather than through `yarn --cwd ../..`: --cwd runs the child
# with the repo root as its working directory, so "$APP" -- written relative to
# examples/bare -- would resolve against the wrong directory and report "no
# such app bundle" for every build, sound or not.
# Node strips types from a .ts entry point without a flag only from 22.18. On
# an older Node this dies with ERR_UNKNOWN_FILE_EXTENSION and exit 1 -- the
# same code a genuine embed failure uses -- so check first and say so plainly.
node -e 'const [maj,min]=process.versions.node.split(".").map(Number);
  if (maj<22 || (maj===22 && min<18)) {
    console.error(`Node ${process.versions.node} cannot run the embed check; 22.18+ required.`);
    process.exit(2);
  }'
node ../../scripts/cli-assert-framework-embedded.ts "$APP"

if [[ "$TARGET" == simulator ]]; then
  xcrun simctl install "$SIMULATOR" "$APP"
  echo
  echo "Installed on simulator $SIMULATOR ($DELIVERY). Now: E2E_PLATFORM=ios E2E_IOS_TARGET=simulator yarn e2e"
else
  xcrun devicectl device install app --device "$DEVICE" "$APP"
  echo
  echo "Installed on $DEVICE ($DELIVERY). Now: E2E_PLATFORM=ios E2E_IOS_TARGET=device yarn e2e"
fi

if [[ "${IOS_LAUNCH:-0}" == 1 ]]; then
  BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
  CONSOLE="$(mktemp -t run-ios-console)"
  if [[ "$TARGET" == simulator ]]; then
    xcrun simctl launch --console-pty --terminate-running-process "$SIMULATOR" "$BUNDLE_ID" >"$CONSOLE" 2>&1 </dev/null &
  else
    xcrun devicectl device process launch --device "$DEVICE" --terminate-existing --console "$BUNDLE_ID" >"$CONSOLE" 2>&1 </dev/null &
  fi
  LAUNCH_PID=$!
  sleep "${IOS_LAUNCH_SECONDS:-40}"
  kill "$LAUNCH_PID" 2>/dev/null || true
  wait "$LAUNCH_PID" 2>/dev/null || true
  echo "--- console of $BUNDLE_ID ($CONFIGURATION, $DELIVERY, $TARGET)"
  grep -E "BUGSEE_E2E|Bugsee|BugseeRN" "$CONSOLE" | cut -c1-240 | head -40
  if grep -qE "${IOS_LAUNCH_EXPECT:-BUGSEE_E2E status=2}" "$CONSOLE"; then
    echo "launch: PASS"
  else
    echo "launch: FAIL (no match for ${IOS_LAUNCH_EXPECT:-BUGSEE_E2E status=2}; console kept at $CONSOLE)"
    exit 1
  fi
fi
