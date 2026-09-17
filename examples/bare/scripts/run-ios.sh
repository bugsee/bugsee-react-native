#!/usr/bin/env bash
#
# Builds and installs the example on a real iPhone over the CocoaPods delivery
# path, asserting on the way that Bugsee.framework is embedded and linked.
#
#   BUGSEE_TOKEN_IOS        required
#   BUGSEE_ENDPOINT         optional; the bridge wants the /v2 suffix, which
#                           App.tsx appends
#   IOS_DEVICE_ID           defaults to the iPhone XS Phase 1 was verified on
#   IOS_DEVELOPMENT_TEAM    required for a device build; no default, because a
#                           team id is per-developer
#
# The SwiftPM delivery path is the other configuration; see README.md.
set -euo pipefail

cd "$(dirname "$0")/.."

DEVICE="${IOS_DEVICE_ID:-345BA7FE-2C29-5722-892A-BFCB1FD34D0C}"
: "${IOS_DEVELOPMENT_TEAM:?set IOS_DEVELOPMENT_TEAM to your Apple Developer team id}"
APP="ios/build/Build/Products/Debug-iphoneos/BareExample.app"

node scripts/write-credentials.mjs

(cd ios && pod install)

xcodebuild \
  -workspace ios/BareExample.xcworkspace \
  -scheme BareExample \
  -configuration Debug \
  -destination "id=$DEVICE" \
  -derivedDataPath ios/build \
  DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
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
node ../../scripts/cli-assert-framework-embedded.ts "$APP"

xcrun devicectl device install app --device "$DEVICE" "$APP"

echo
echo "Installed on $DEVICE. Now: E2E_PLATFORM=ios yarn e2e"
