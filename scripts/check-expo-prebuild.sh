#!/bin/bash
# Spec §13: `expo prebuild --clean` must leave the config plugin's edits in
# the regenerated projects. Runs the prebuild in examples/expo (no pod or
# npm install) and checks each edit. Then a second prebuild with `--no-clean`
# runs the plugin over its own output, which must change no file (SDK 57
# prebuilds clean by default, which would only prove determinism). Removes
# ios/ and android/ afterwards. Builds nothing.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$repo/examples/expo"
cd "$app"
trap 'rm -rf "$app/ios" "$app/android" "$app/.expo"' EXIT

failures=0
expect() {
  local file="$1" needle="$2"
  if ! grep -qF -- "$needle" "$file"; then
    echo "::error file=examples/expo/$file::expected: $needle"
    failures=$((failures + 1))
  fi
}

CI=1 yarn expo prebuild --clean --no-install

plugin_version="$(node -p "require('$repo/native-versions.json').android.gradlePlugin")"
sdk_version="$(node -p "require('$repo/native-versions.json').android.sdk")"

expect android/settings.gradle 'mavenCentral()'
expect android/build.gradle "id 'com.bugsee.android.gradle' version '$plugin_version' apply false"
expect android/app/build.gradle 'apply plugin: "com.bugsee.android.gradle"'
expect android/app/build.gradle "implementation \"com.bugsee:bugsee-android-ndk:$sdk_version\""
expect android/app/build.gradle 'scripts/hermesc-preserve-js.sh'
expect android/app/build.gradle 'scripts/bugsee-sourcemaps.gradle")'
expect android/app/build.gradle "debugSymbolLevel 'SYMBOL_TABLE'"
expect android/bugsee.properties 'No app token configured.'
expect ios/BugseeExpo.xcodeproj/project.pbxproj 'scripts/bugsee-xcode.sh'
expect ios/BugseeExpo.xcodeproj/xcshareddata/xcschemes/BugseeExpo.xcscheme 'xcode post-action'

snapshot() {
  find android ios -type f -not -path '*/.gradle/*' -print0 | sort -z | xargs -0 shasum
}
before="$(snapshot)"
CI=1 yarn expo prebuild --no-clean --no-install
after="$(snapshot)"
if [[ "$before" != "$after" ]]; then
  echo "::error::a --no-clean prebuild over the plugin's own output changed generated files"
  diff <(echo "$before") <(echo "$after") || true
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "expo prebuild check: $failures failure(s)"
  exit 1
fi
echo "expo prebuild check: ok"
