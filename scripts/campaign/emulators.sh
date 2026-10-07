#!/usr/bin/env bash
#
# Android emulator sweep (campaign-rules: the SDK's minimum API, a mid
# version and API 36): creates the three AVDs and boots/stops them.
#
#   emulators.sh create          install the system images (if missing) and
#                                create the AVDs (idempotent)
#   emulators.sh boot <avd>      boot headless, wait for sys.boot_completed,
#                                print the serial. The caller holds
#                                .device-lock for as long as it is up.
#   emulators.sh stop <serial>   kill that emulator
#   emulators.sh list            the campaign AVDs and their images
#   emulators.sh sweep <app dir>... for each AVD: take .device-lock, boot it,
#                                launch-check.sh each app (debug and release),
#                                stop it, release the lock
#
# The floor: the Bugsee Android SDK and the wrapper declare minSdk 21, but
# every React Native 0.81+ template sets minSdkVersion 24, so an RN app cannot
# be installed below API 24. API 24 is the lowest a campaign app runs on, and
# the sweep's "minimum".
#
# AVDs (all arm64-v8a, Google APIs, 4 GB RAM, cold boot, no snapshot):
#   bugsee_api24   system-images;android-24;google_apis;arm64-v8a   (floor)
#   bugsee_api30   system-images;android-30;google_apis;arm64-v8a   (mid)
#   bugsee_api36   system-images;android-36;default;arm64-v8a       (latest)
set -euo pipefail

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

AVDS="bugsee_api24 bugsee_api30 bugsee_api36"
image_of() {
  case "$1" in
    bugsee_api24) echo "system-images;android-24;google_apis;arm64-v8a" ;;
    bugsee_api30) echo "system-images;android-30;google_apis;arm64-v8a" ;;
    bugsee_api36) echo "system-images;android-36;default;arm64-v8a" ;;
    *) echo "unknown AVD $1" >&2; exit 2 ;;
  esac
}
port_of() {
  case "$1" in
    bugsee_api24) echo 5580 ;;
    bugsee_api30) echo 5582 ;;
    bugsee_api36) echo 5584 ;;
  esac
}

case "${1:-}" in
  create)
    for avd in $AVDS; do
      image="$(image_of "$avd")"
      dir="$ANDROID_HOME/$(echo "$image" | tr ';' '/')"
      if [[ ! -f "$dir/system.img" ]]; then
        yes | "$SDKMANAGER" "$image" >/dev/null
      fi
      if "$EMULATOR" -list-avds | grep -qx "$avd"; then
        echo "$avd: exists"
        continue
      fi
      echo no | "$AVDMANAGER" create avd -n "$avd" -k "$image" -d pixel_6 >/dev/null
      cfg="$HOME/.android/avd/$avd.avd/config.ini"
      {
        echo "hw.ramSize=4096"
        echo "hw.keyboard=yes"
        echo "disk.dataPartition.size=6G"
      } >>"$cfg"
      echo "$avd: created ($image)"
    done
    ;;
  boot)
    avd="${2:?emulators.sh boot <avd>}"
    image_of "$avd" >/dev/null
    port="$(port_of "$avd")"
    serial="emulator-$port"
    nohup "$EMULATOR" -avd "$avd" -port "$port" -no-window -no-audio -no-snapshot \
      -no-boot-anim -gpu swiftshader_indirect >"/tmp/$avd.emulator.log" 2>&1 &
    "$ADB" -s "$serial" wait-for-device
    until [[ "$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
      sleep 3
    done
    "$ADB" -s "$serial" shell settings put global window_animation_scale 0 || true
    "$ADB" -s "$serial" shell settings put global transition_animation_scale 0 || true
    "$ADB" -s "$serial" shell settings put global animator_duration_scale 0 || true
    echo "$serial"
    ;;
  stop)
    "$ADB" -s "${2:?emulators.sh stop <serial>}" emu kill
    ;;
  list)
    for avd in $AVDS; do
      printf '%s\t%s\t%s\n' "$avd" "$(image_of "$avd")" \
        "$("$EMULATOR" -list-avds | grep -qx "$avd" && echo created || echo missing)"
    done
    ;;
  sweep)
    shift
    LOCK="${CAMPAIGN_DEVICE_LOCK:-/Volumes/External2TB/Projects/Bugsee/cross/bugsee-react-native/.device-lock}"
    [[ -d "$(dirname "$LOCK")" ]] || { echo "lock directory $(dirname "$LOCK") does not exist; set CAMPAIGN_DEVICE_LOCK" >&2; exit 2; }
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    for avd in $AVDS; do
      until mkdir "$LOCK" 2>/dev/null; do sleep 30; done
      serial="emulator-$(port_of "$avd")"
      trap '"$ADB" -s "$serial" emu kill >/dev/null 2>&1; rmdir "$LOCK" 2>/dev/null' EXIT
      "$0" boot "$avd" >/dev/null
      echo "$avd ($serial): API $("$ADB" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r'), page size $("$ADB" -s "$serial" shell getconf PAGE_SIZE | tr -d '\r')"
      for app in "$@"; do
        for cfg in debug release; do
          CAMPAIGN_LOCK_HELD=1 "$HERE/launch-check.sh" "$app" android "$cfg" "$serial" 2>&1 | grep -E ": (PASS|FAIL)" || true
        done
      done
      "$ADB" -s "$serial" emu kill >/dev/null 2>&1 || true
      sleep 5
      rmdir "$LOCK"
      trap - EXIT
    done
    ;;
  *)
    sed -n '3,25p' "$0"
    exit 2
    ;;
esac
