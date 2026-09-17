#!/usr/bin/env bash
#
# Asserts that Bugsee.framework is actually inside the built .app and actually
# linked by it.
#
# This exists because a build can succeed with neither. A pod that links the
# product without embedding it produces an app that passes CI and dyld-crashes
# on the device; an embedded framework nothing links against is dead weight and
# the SDK never loads. Both were observed during the spike, so both are checked.
#
# Usage: assert-ios-embed.sh /path/to/Built.app
set -euo pipefail

APP="${1:?usage: assert-ios-embed.sh <path to .app>}"

if [ ! -d "$APP" ]; then
  echo "assert-ios-embed: no such app bundle: $APP" >&2
  exit 1
fi

embedded="$(find "$APP" -name Bugsee.framework -maxdepth 3)"
if [ -z "$embedded" ]; then
  echo "assert-ios-embed: FAIL — Bugsee.framework is not embedded in $APP" >&2
  exit 1
fi
echo "assert-ios-embed: embedded at ${embedded#"$APP"/}"

# Which Mach-O carries the load command depends on the configuration, not on
# whether the link worked: React Native 0.87 Debug builds put the app's own code
# in <Name>.debug.dylib and leaves the main executable a thin launcher, so
# checking only the executable reports a false failure. Accept any Mach-O at the
# bundle root.
linked=""
for macho in "$APP"/*; do
  [ -f "$macho" ] || continue
  if otool -L "$macho" 2>/dev/null | grep -q "@rpath/Bugsee.framework/Bugsee"; then
    linked="$macho"
    break
  fi
done

if [ -z "$linked" ]; then
  echo "assert-ios-embed: FAIL — nothing at the bundle root links @rpath/Bugsee.framework/Bugsee" >&2
  for macho in "$APP"/*; do
    [ -f "$macho" ] || continue
    echo "  --- $(basename "$macho")" >&2
    otool -L "$macho" 2>/dev/null | sed 's/^/    /' >&2 || true
  done
  exit 1
fi

echo "assert-ios-embed: $(basename "$linked") links @rpath/Bugsee.framework/Bugsee"
echo "assert-ios-embed: PASS"
