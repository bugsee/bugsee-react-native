#!/usr/bin/env bash
#
# Builds and installs the example on a real Android device, ready for the e2e.
#
# Credentials come from the environment and are written to two gitignored files
# by write-credentials.mjs; nothing here is ever committed.
#
#   BUGSEE_TOKEN_ANDROID   required
#   BUGSEE_ENDPOINT        optional, e.g. https://apidev.bugsee.com
#   ANDROID_SERIAL         defaults to the WOD_LX1 Phase 1 was verified on
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
ADB="$ANDROID_HOME/platform-tools/adb"
SERIAL="${ANDROID_SERIAL:-AMRJCP4718402860}"

node scripts/write-credentials.mjs

# One ABI on purpose: the device is arm64 and building the other three triples
# the NDK step for nothing.
(cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a)

"$ADB" -s "$SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
# Debug builds load JS from Metro; over USB that needs a reverse tunnel.
"$ADB" -s "$SERIAL" reverse tcp:8081 tcp:8081

echo
echo "Installed on $SERIAL. With \`yarn start\` running, now: E2E_PLATFORM=android yarn e2e"
