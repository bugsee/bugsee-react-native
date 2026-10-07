#!/usr/bin/env bash
#
# N-24 / MX-16KB: Android 16 KB page-size readiness of a release APK or AAB.
#
#   check-16kb.sh <app.apk|app.aab>
#
# Two checks, both required by Google Play for targetSdk 35+ apps on
# 16 KB devices:
#   1. zip alignment: every uncompressed .so starts on a 16 KB boundary
#      (`zipalign -c -P 16 -v 4`; APK only, bundletool aligns an AAB's splits);
#   2. ELF alignment: every PT_LOAD segment of every .so in lib/arm64-v8a and
#      lib/x86_64 has p_align >= 2**14 (16384).
# Prints one line per .so (Bugsee's own marked with *). Exit 1 when zipalign
# or a Bugsee library (libbugsee*, crashpad) fails; exit 4 when only another
# vendor's library fails (reported, not ours to fix). 32-bit ABIs are listed
# but not judged: 16 KB pages are a 64-bit-only requirement.
set -euo pipefail

ARTIFACT="$(cd "$(dirname "${1:?usage: check-16kb.sh <apk|aab>}")" && pwd)/$(basename "$1")"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"

BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | grep -v rc | sort -V | tail -1)"
NDK="$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)"
READELF="$(ls "$NDK"/toolchains/llvm/prebuilt/*/bin/llvm-readelf | head -1)"
[[ -x "$READELF" ]] || { echo "llvm-readelf not found under $NDK"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$ARTIFACT" '*.so' -d "$WORK" 2>/dev/null || true

failures=0
others=0
echo "--- 16 KB check: $(basename "$ARTIFACT")"
if [[ "$ARTIFACT" == *.apk ]]; then
  if "$BUILD_TOOLS/zipalign" -c -P 16 -v 4 "$ARTIFACT" >"$WORK/zipalign.txt" 2>&1; then
    echo "zipalign -P 16: PASS ($(basename "$BUILD_TOOLS"))"
  else
    echo "zipalign -P 16: FAIL"
    grep -v "(OK" "$WORK/zipalign.txt" | grep "\.so" | head -20
    failures=$((failures + 1))
  fi
fi

while IFS= read -r so; do
  rel="${so#$WORK/}"
  abi="$(basename "$(dirname "$so")")"
  # Smallest PT_LOAD alignment in the file.
  min_align="$("$READELF" -lW "$so" | awk '$1=="LOAD"{print $NF}' | while read -r a; do printf '%d\n' "$a"; done | sort -n | head -1)"
  mark=" "
  case "$(basename "$so")" in libbugsee*|*crashpad*) mark="*" ;; esac
  verdict=PASS
  case "$abi" in
    arm64-v8a|x86_64)
      if [[ -z "$min_align" || "$min_align" -lt 16384 ]]; then
        verdict=FAIL
        if [[ "$mark" == "*" ]]; then failures=$((failures + 1)); else others=$((others + 1)); fi
      fi ;;
    *) verdict=n/a ;;
  esac
  printf '%s %-5s align=%-6s %s\n' "$mark" "$verdict" "${min_align:-?}" "$rel"
done < <(find "$WORK" -name '*.so' | sort)

if [[ "$failures" -gt 0 ]]; then
  echo "16 KB check: FAIL ($failures Bugsee/zip, $others other)"
  exit 1
fi
if [[ "$others" -gt 0 ]]; then
  echo "16 KB check: Bugsee PASS, $others non-Bugsee librar$( [[ $others -eq 1 ]] && echo y || echo ies) FAIL"
  exit 4
fi
echo "16 KB check: PASS"
