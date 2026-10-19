#!/usr/bin/env bash
#
# Archives the example and exports a development IPA, the way a release build
# is made, so the scheme's Archive post-action uploads the dSYMs (app, Bugsee
# and React) to Bugsee. A plain `xcodebuild build` (run-ios.sh) never runs that
# post-action, so its native crashes stay unsymbolicated.
#
#   BUGSEE_TOKEN_IOS        required, and a real one: the post-action stops, exit 0, without it
#   BUGSEE_ENDPOINT         optional; your staging endpoint (set BUGSEE_STAGING_ENDPOINT)
#   IOS_DEVELOPMENT_TEAM    required: your Apple Developer team id
#   ARCHIVE_DIR             where the .xcarchive and the IPA go (default: ios/build/archive)
#
# Prints the IPA path. To install it on the allowlisted iPhone and run the
# staging lane:
#
#   IOS_IPA=<printed path> IOS_CONFIGURATION=Release IOS_TARGET=device scripts/run-ios.sh
#   E2E_PLATFORM=ios E2E_IOS_TARGET=device E2E_STAGING=1 E2E_RELEASE=1 yarn e2e staging
#
# The React Native frames need the React dSYMs, which RN downloads with the
# prebuilt React pod when `pod install` runs with
# RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1; a pod that is already installed is
# not fetched again, so this script removes it first.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${BUGSEE_TOKEN_IOS:?set BUGSEE_TOKEN_IOS to a real app token}"
# The post-action stops, exit 0, for the placeholder token and nothing would upload:
# fail here instead. Same rule as isPlaceholderToken (endpoint.ts): dashes and
# whitespace go first, the character lists are spelled out.
case "$(printf '%s' "$BUGSEE_TOKEN_IOS" | tr -d ' \t\r\n-')" in
  000000000000[0123456789abcdefABCDEF]000[0123456789abcdefABCDEF]000000000000000)
    echo "set BUGSEE_TOKEN_IOS to a real app token, not the placeholder" >&2
    exit 1
    ;;
esac
: "${IOS_DEVELOPMENT_TEAM:?set IOS_DEVELOPMENT_TEAM to your Apple Developer team id}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$PWD/ios/build/archive}"

BUGSEE_TOKEN_ANDROID="${BUGSEE_TOKEN_ANDROID:-$BUGSEE_TOKEN_IOS}" node scripts/write-credentials.mjs

rm -rf ios/Pods/React-Core-prebuilt
pod cache clean React-Core-prebuilt --all >/dev/null 2>&1 || true
(cd ios && RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1 pod install)

# The scheme's post-action reads BUGSEE_APP_TOKEN before BUGSEE_TOKEN_IOS and
# credentials.json, so a BUGSEE_APP_TOKEN left in the environment would send the
# dSYMs to another app: pin it to the token this script was given.
export BUGSEE_APP_TOKEN="$BUGSEE_TOKEN_IOS"

rm -rf "$ARCHIVE_DIR" && mkdir -p "$ARCHIVE_DIR"
xcodebuild archive -workspace ios/BareExample.xcworkspace -scheme BareExample \
  -configuration Release -destination generic/platform=iOS \
  -archivePath "$ARCHIVE_DIR/BareExample.xcarchive" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic BUGSEE_APP_TOKEN="$BUGSEE_TOKEN_IOS"

for dsym in BareExample.app Bugsee.framework React.framework; do
  [[ -d "$ARCHIVE_DIR/BareExample.xcarchive/dSYMs/$dsym.dSYM" ]] ||
    echo "warning: the archive has no $dsym.dSYM, so its frames will stay raw addresses" >&2
done

cat > "$ARCHIVE_DIR/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>debugging</string>
  <key>teamID</key><string>$IOS_DEVELOPMENT_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE_DIR/BareExample.xcarchive" \
  -exportOptionsPlist "$ARCHIVE_DIR/export.plist" -exportPath "$ARCHIVE_DIR/ipa" -allowProvisioningUpdates

ls "$ARCHIVE_DIR"/ipa/*.ipa
