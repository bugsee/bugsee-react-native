#!/usr/bin/env bash
#
# Classifies the files a pull request changes (one path per line on stdin) so
# ci.yml can skip work the change cannot affect. Prints three lines for
# $GITHUB_OUTPUT:
#
#   app=<true|false>      anything that can change what the app/e2e/compat/pack
#                         jobs exercise. false only when EVERY changed file is
#                         docs or workflow/config the app jobs never read.
#   android=<true|false>  anything that can change an Android build or its
#                         Gradle tests (Gradle, Java, Android example, codegen).
#   ios=<true|false>      the same for the iOS builds (Xcode, Pods, podspecs,
#                         Support package, iOS example, codegen).
#
# Fail-safe by construction: a path matching no pattern below counts as both
# platforms, and an empty list (no diff, or a non-PR event) is all true.
# Self-test: scripts/ci-changes.sh --self-test
set -euo pipefail

classify() {
  local app=false android=false ios=false n=0 f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    n=$((n + 1))
    case "$f" in
      # Not read by any app job. The README in a package IS read (pack-install
      # typechecks its "## Use" block), so only the root README and docs/ count.
      docs/* | README.md | LICENSE | .github/dependabot.yml | \
      .github/workflows/release.yml | .github/workflows/claude-review.yml | \
      .github/workflows/bugseeai.yml | .github/workflows/playground.yml | \
      .github/workflows/campaign-windows-hermes.yml | examples/playground/*)
        ;;
      # TurboModule specs feed codegen on both platforms.
      packages/*/src/Native*.ts | packages/*/src/*NativeComponent*)
        app=true; android=true; ios=true ;;
      # One platform's native sources and its example project.
      packages/*/android/* | examples/bare/android/*)
        app=true; android=true ;;
      packages/*/ios/* | packages/*/*.podspec | examples/bare/ios/*)
        app=true; ios=true ;;
      # JS-only: library modules, tests, package READMEs, mutation configs.
      packages/*/src/* | packages/*/README.md | */__tests__/* | \
      stryker.*.json | tsconfig.mutation.json)
        app=true ;;
      *)
        app=true; android=true; ios=true ;;
    esac
  done
  if [[ "$n" -eq 0 ]]; then app=true; android=true; ios=true; fi
  echo "app=$app"
  echo "android=$android"
  echo "ios=$ios"
}

if [[ "${1:-}" == "--self-test" ]]; then
  fail=0
  check() { # <expected "app android ios"> <files...>
    local want="$1"; shift
    local got
    got="$(printf '%s\n' "$@" | classify | sed 's/^[a-z]*=//' | tr '\n' ' ' | sed 's/ $//')"
    if [[ "$got" != "$want" ]]; then echo "FAIL: [$*] -> '$got', want '$want'"; fail=1; fi
  }
  check "false false false" docs/ci/x.md
  check "false false false" README.md examples/playground/App.tsx .github/workflows/release.yml
  check "true false false" packages/react-native/src/logs/index.ts
  check "true false false" packages/react-native/src/__tests__/a.test.ts docs/a.md packages/react-native/README.md
  check "true true true" packages/react-native/src/NativeBugsee.ts
  check "true true true" packages/react-native-feedback/src/NativeBugseeFeedback.ts
  check "true true false" packages/react-native/android/src/main/java/a/B.java packages/react-native/src/index.ts
  check "true false true" packages/react-native/ios/BugseeModule.mm packages/react-native/BugseeReactNative.podspec
  check "true true true" packages/react-native/ios/BugseeModule.mm packages/react-native/android/build.gradle
  check "true false true" examples/bare/ios/Podfile.lock
  check "true true false" examples/bare/android/app/build.gradle
  check "true true true" yarn.lock
  check "true true true" .github/workflows/ci.yml
  check "true true true" scripts/check-pack-install.sh
  check "true true true" native-versions.json
  check "true true true" packages/react-native/plugin/index.js
  check "true true true" docs/a.md brand-new-top-level-file
  got="$(: | classify | tr '\n' ' ')"
  [[ "$got" == "app=true android=true ios=true " ]] || { echo "FAIL: empty list -> $got"; fail=1; }
  [[ "$fail" -eq 0 ]] && echo "ci-changes self-test passed"
  exit "$fail"
fi

classify
