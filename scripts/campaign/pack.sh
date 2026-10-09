#!/usr/bin/env bash
#
# Packs @bugsee/react-native and @bugsee/react-native-feedback with `npm pack`
# into <campaign-apps>/tarballs, the input of gen-rn-app.sh, gen-expo-app.sh
# and pack-install.sh. `prepack` (the releasable-pins guard) runs as it would
# on publish. Prints each tarball's name and SHA-256.
#
# `npm pack`, not `yarn pack`: yarn 4 drops packages/react-native/plugin/build
# (the compiled Expo config plugin that app.plugin.js requires) from the
# tarball, because the repo's .gitignore ignores **/build/**; npm honours the
# package's `files` list. See W-2 in campaign-prep-build.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPS="${CAMPAIGN_APPS:-$(cd "$REPO/.." && pwd)/campaign-apps}"
OUT="$APPS/tarballs"
mkdir -p "$OUT"
rm -f "$OUT"/*.tgz

(cd "$REPO" && yarn workspace @bugsee/react-native build:plugin >/dev/null)
for pkg in react-native react-native-feedback; do
  (cd "$REPO/packages/$pkg" && npm pack --silent --pack-destination "$OUT" >/dev/null)
done
for tgz in "$OUT"/*.tgz; do
  echo "$(basename "$tgz") $(shasum -a 256 "$tgz" | cut -d' ' -f1)"
done
# The compiled plugin must be in the core tarball (app.plugin.js requires it).
tar tzf "$OUT"/bugsee-react-native-[0-9]*.tgz | grep -q '^package/plugin/build/index.js$' \
  || { echo "FAIL: plugin/build/index.js missing from the core tarball"; exit 1; }
