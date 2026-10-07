#!/usr/bin/env bash
#
# Minimal launch check for a campaign app until the N-01 smoke harness runs
# against it: install the build, launch it, and wait for the app's own
# markers in the device log:
#
#   BUGSEE_E2E launching on <os> rn=<x.y.z> engine=<hermes|jsc>
#   BUGSEE_E2E status=2 (Launched)          within 10 s of "launching"
#
#   launch-check.sh <app dir> android <debug|release> [serial]
#   launch-check.sh <app dir> ios-sim <debug|release>
#
# android defaults to the WOD_LX1 (AMRJCP4718402860); pass an emulator serial
# (emulators.sh boot) for the sweep. ios-sim is the campaign simulator
# 6FA9B3E8-26C7-4232-AA2C-537D9DF32957. The iPhone XS is never driven from
# here: use examples/bare/scripts/run-ios.sh (IOS_APP_DIR, IOS_LAUNCH=1).
#
# Takes .device-lock (blocking, no timeout) for the whole install+launch and
# releases it on every exit. CAMPAIGN_LOCK_HELD=1 means the caller already
# holds .device-lock (emulators.sh sweep: the emulator is up for several
# launches) and this script neither takes nor releases it. A Debug build loads JS from this app's own Metro
# port (campaign.port), never 8081, so another lane's Metro is never used and
# the 8081 reverse another lane may hold is left alone.
#
# Exit 0 = PASS. One result line goes to <campaign-apps>/logs/launch-results.tsv.
set -uo pipefail

APP_DIR="$(cd "${1:?usage: launch-check.sh <app dir> android|ios-sim debug|release [serial]}" && pwd)"
TARGET="${2:?target android|ios-sim}"
CONFIG="${3:?debug|release}"
SERIAL="${4:-AMRJCP4718402860}"
SIMULATOR=6FA9B3E8-26C7-4232-AA2C-537D9DF32957
# The campaign's shared device lock (campaign-rules.md); CAMPAIGN_DEVICE_LOCK
# overrides it on another machine.
LOCK="${CAMPAIGN_DEVICE_LOCK:-/Volumes/External2TB/Projects/Bugsee/cross/bugsee-react-native/.device-lock}"
APP="$(basename "$APP_DIR")"
LOGS="$(dirname "$APP_DIR")/logs"
mkdir -p "$LOGS"
OUT="$LOGS/$APP-launch-$TARGET-$CONFIG.log"
PORT="$(cat "$APP_DIR/campaign.port" 2>/dev/null || echo 8081)"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
BUDGET="${LAUNCH_BUDGET:-180}"
[[ "$TARGET" == android && "$SERIAL" == emulator-* ]] && BUDGET="${LAUNCH_BUDGET:-300}"

# A missing parent would make the mkdir below fail forever, like a held lock.
[[ -d "$(dirname "$LOCK")" ]] || { echo "lock directory $(dirname "$LOCK") does not exist; set CAMPAIGN_DEVICE_LOCK" >&2; exit 2; }
case "$TARGET" in android|ios-sim) ;; *) echo "target android|ios-sim" >&2; exit 2 ;; esac
case "$CONFIG" in debug|release) ;; *) echo "debug|release" >&2; exit 2 ;; esac
[[ "$SERIAL" == 00008140* || "$SERIAL" == D027034D* ]] && { echo "refused: never this device" >&2; exit 2; }

android_id() {
  node -e '
    const s=require("fs").readFileSync(process.argv[1],"utf8");
    const m=/applicationId\s*=?\s*["\x27]([^"\x27]+)["\x27]/.exec(s); console.log(m?m[1]:"");' "$APP_DIR/android/app/build.gradle"
}
ios_app() {
  local cfg="Debug"; [[ "$CONFIG" == release ]] && cfg="Release"
  ls -d "$APP_DIR"/ios/build/Build/Products/"$cfg"-iphonesimulator/*.app 2>/dev/null | head -1
}

METRO_PID=""
LOG_PID=""
RECORDED=0
record_row() { # result
  local engine rn
  engine="$(grep -o 'engine=[a-z]*' "$OUT" 2>/dev/null | head -1)"
  rn="$(grep -o 'rn=[0-9.]*' "$OUT" 2>/dev/null | head -1)"
  printf '%s\t%s\t%s\t%s\t%s\t%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP" \
    "$TARGET:$( [[ $TARGET == android ]] && echo "$SERIAL" || echo sim)" "$CONFIG" "$1" "$rn" "$engine" \
    >>"$LOGS/launch-results.tsv"
  RECORDED=1
}
cleanup() {
  # Every exit leaves a row: an install or Metro failure is a FAIL, not a gap.
  [[ "$RECORDED" == 1 ]] || { record_row FAIL; echo "$APP $TARGET $CONFIG: FAIL (before launch, see $OUT)"; }
  if [[ -n "$LOG_PID" ]]; then
    kill "$LOG_PID" 2>/dev/null
    wait "$LOG_PID" 2>/dev/null
  fi
  if [[ -n "$METRO_PID" ]]; then
    pkill -P "$METRO_PID" 2>/dev/null
    kill "$METRO_PID" 2>/dev/null
    # npx's node children: whatever still listens on this app's port.
    lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
  fi
  if [[ "$TARGET" == android && "$CONFIG" == debug ]]; then
    "$ADB" -s "$SERIAL" reverse --remove "tcp:$PORT" 2>/dev/null
  fi
  [[ "${CAMPAIGN_LOCK_HELD:-0}" == 1 ]] || rmdir "$LOCK" 2>/dev/null
}

start_metro() {
  if [[ -f "$APP_DIR/app.json" ]] && grep -q '"expo"' "$APP_DIR/app.json"; then
    (cd "$APP_DIR" && CI=1 exec npx expo start --port "$PORT") >"$OUT.metro" 2>&1 </dev/null &
  else
    (cd "$APP_DIR" && exec npx react-native start --port "$PORT") >"$OUT.metro" 2>&1 </dev/null &
  fi
  METRO_PID=$!
  local i
  for i in $(seq 1 90); do
    curl -sf "http://localhost:$PORT/status" | grep -q running && return 0
    sleep 1
  done
  echo "Metro did not come up on $PORT" >>"$OUT"
  return 1
}

: >"$OUT"
echo "== $APP $TARGET $CONFIG $( [[ $TARGET == android ]] && echo "$SERIAL" || echo "$SIMULATOR") port $PORT" | tee -a "$OUT"

if [[ "${CAMPAIGN_LOCK_HELD:-0}" != 1 ]]; then
  until mkdir "$LOCK" 2>/dev/null; do sleep 30; done
fi
trap cleanup EXIT

result=FAIL
if [[ "$TARGET" == android ]]; then
  ID="$(android_id)"
  [[ -n "$ID" ]] || { echo "no applicationId in android/app/build.gradle" | tee -a "$OUT"; exit 1; }
  APK="$APP_DIR/android/app/build/outputs/apk/$CONFIG/app-$CONFIG.apk"
  echo "adb reverse before: $("$ADB" -s "$SERIAL" reverse --list | tr '\n' ' ')" >>"$OUT"
  "$ADB" -s "$SERIAL" install -r "$APK" >>"$OUT" 2>&1 || { echo "install failed" | tee -a "$OUT"; exit 1; }
  if [[ "$CONFIG" == debug ]]; then
    start_metro || exit 1
    "$ADB" -s "$SERIAL" reverse "tcp:$PORT" "tcp:$PORT" >>"$OUT"
  fi
  "$ADB" -s "$SERIAL" shell am force-stop "$ID"
  "$ADB" -s "$SERIAL" logcat -c || { echo "logcat -c failed" | tee -a "$OUT"; exit 1; }
  # Straight to a file, detached from this script's stdout: a reader holding
  # the caller's pipe open would keep the caller waiting after we exit.
  "$ADB" -s "$SERIAL" logcat -v time "ReactNativeJS:V" "Bugsee:V" "BugseeRN:V" "AndroidRuntime:E" "*:S" \
    >>"$OUT" 2>&1 </dev/null &
  LOG_PID=$!
  sleep 2
  "$ADB" -s "$SERIAL" shell monkey -p "$ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
else
  APP_PATH="$(ios_app)"
  [[ -n "$APP_PATH" ]] || { echo "no simulator build" | tee -a "$OUT"; exit 1; }
  ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Info.plist")"
  xcrun simctl bootstatus "$SIMULATOR" -b >/dev/null 2>&1
  xcrun simctl install "$SIMULATOR" "$APP_PATH" >>"$OUT" 2>&1 || { echo "install failed" | tee -a "$OUT"; exit 1; }
  [[ "$CONFIG" == debug ]] && { start_metro || exit 1; }
  xcrun simctl terminate "$SIMULATOR" "$ID" >/dev/null 2>&1
  xcrun simctl spawn "$SIMULATOR" log stream --style compact \
    --predicate 'eventMessage CONTAINS "BUGSEE_E2E" OR eventMessage CONTAINS "Bugsee"' >>"$OUT" 2>&1 </dev/null &
  LOG_PID=$!
  sleep 2
  # Debug: point the bundle URL at this app's Metro through the launch
  # arguments (NSUserDefaults RCT_jsLocation). The RCT_METRO_PORT define from
  # the Podfile does not reach a prebuilt React Native core (0.84+).
  JS_LOCATION=()
  [[ "$CONFIG" == debug ]] && JS_LOCATION=(-RCT_jsLocation "localhost:$PORT")
  xcrun simctl launch "$SIMULATOR" "$ID" ${JS_LOCATION[@]+"${JS_LOCATION[@]}"} >>"$OUT" 2>&1
fi

launched_this_run() {
  awk '
    /BUGSEE_E2E launching on/ { pid = ""; if (match($0, /\( *[0-9]+\)|\[[0-9]+:/)) pid = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", pid); seen = 1; next }
    seen && /BUGSEE_E2E status=2/ {
      p = ""; if (match($0, /\( *[0-9]+\)|\[[0-9]+:/)) p = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", p)
      if (pid == "" || p == pid) { found = 1 }
    }
    END { exit found ? 0 : 1 }
  ' "$OUT"
}

deadline=$((SECONDS + BUDGET))
while [[ $SECONDS -lt $deadline ]]; do
  # Only this launch counts: status=2 after this launch's own
  # "BUGSEE_E2E launching" line, from the same process (Android: logcat's
  # "(pid)"; iOS: log stream's "[pid:").
  if launched_this_run; then result=PASS; break; fi
  if grep -qE "FATAL EXCEPTION|launch\(\) rejected" "$OUT"; then break; fi
  sleep 2
done
sleep 2
record_row "$result"
echo "$APP $TARGET $CONFIG: $result $(grep -o 'rn=[0-9.]*' "$OUT" | head -1) $(grep -o 'engine=[a-z]*' "$OUT" | head -1)"
grep -E "BUGSEE_E2E" "$OUT" | head -8
[[ "$result" == PASS ]]
