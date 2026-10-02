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

cp "$js" "${js}.bugsee-js-source"

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
printf '%s\n' "$real" > "${js}.bugsee-hermesc"
exec "$real" "$@"
