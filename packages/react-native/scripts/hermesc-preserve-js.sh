#!/bin/bash
# Android invokes this as `react.hermesCommand`. Copy the JS bundle aside
# before hermesc replaces it with bytecode, then run the real compiler.
# Injection happens later, on the composed map.

set -euo pipefail

out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-out" ]]; then
    out="$arg"
  fi
  prev="$arg"
done

js=""
for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    continue
  fi
  if [[ -n "$out" && "$arg" == "$out" ]]; then
    continue
  fi
  if [[ -f "$arg" ]]; then
    js="$arg"
    break
  fi
done

if [[ -z "$js" ]]; then
  echo "bugsee: hermesc wrapper could not find the JS bundle" >&2
  exit 1
fi

# jsBundleDir is packaged as assets. Preserve files beside the bundle would
# ship in the APK. Intermediates are not.
js_dir="$(dirname "$js")"
marker="/generated/assets/"
if [[ -n "${BUGSEE_PRESERVE_DIR:-}" ]]; then
  preserve_dir="$BUGSEE_PRESERVE_DIR"
elif [[ "$js_dir" == *"$marker"* ]]; then
  preserve_dir="${js_dir/$marker//intermediates/bugsee-sourcemaps/}"
else
  echo "bugsee: refusing to write preserve files beside the bundle ($js_dir)" >&2
  exit 1
fi
case "$preserve_dir" in
  "$js_dir"|"$js_dir"/*)
    echo "bugsee: refusing to write preserve files into the packaged asset directory" >&2
    exit 1
    ;;
esac
mkdir -p "$preserve_dir"
base="$(basename "$js")"
cp "$js" "${preserve_dir}/${base}.bugsee-js-source"

find_hermesc() {
  if [[ -n "${BUGSEE_REAL_HERMESC:-}" && -x "$BUGSEE_REAL_HERMESC" ]]; then
    echo "$BUGSEE_REAL_HERMESC"
    return
  fi
  local osbin="osx-bin"
  local bin="hermesc"
  case "$(uname -s)" in
    Linux) osbin="linux64-bin" ;;
    Darwin) osbin="osx-bin" ;;
    MINGW*|MSYS*|CYGWIN*) osbin="win64-bin"; bin="hermesc.exe" ;;
  esac
  # Expo SDK 57 resolves hermes-compiler from the react-native package, so a
  # pnpm or Yarn workspace install under node_modules/react-native/node_modules
  # is found. React Native 0.81 (Expo SDK 54) has no hermes-compiler package
  # and ships sdks/hermesc beside react-native/package.json. That path is next.
  local pkg=""
  if command -v node >/dev/null 2>&1; then
    pkg="$(node --print "require.resolve('hermes-compiler/package.json', { paths: [require.resolve('react-native/package.json')] })" 2>/dev/null)" || pkg=""
  fi
  if [[ -n "$pkg" ]]; then
    local resolved
    resolved="$(dirname "$pkg")/hermesc/${osbin}/${bin}"
    if [[ -x "$resolved" ]]; then
      echo "$resolved"
      return
    fi
  fi
  local rn_pkg=""
  if command -v node >/dev/null 2>&1; then
    rn_pkg="$(node --print "require.resolve('react-native/package.json')" 2>/dev/null)" || rn_pkg=""
  fi
  if [[ -n "$rn_pkg" ]]; then
    local shipped
    shipped="$(dirname "$rn_pkg")/sdks/hermesc/${osbin}/${bin}"
    if [[ -x "$shipped" ]]; then
      echo "$shipped"
      return
    fi
  fi
  local candidate
  for candidate in \
    "$PWD/node_modules/hermes-compiler/hermesc/${osbin}/${bin}" \
    "$PWD/node_modules/react-native/sdks/hermes/build/bin/${bin}"
  do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

real="$(find_hermesc)" || {
  echo "bugsee: hermesc binary not found" >&2
  exit 1
}
printf '%s\n' "$real" > "${preserve_dir}/${base}.bugsee-hermesc"
exec "$real" "$@"
