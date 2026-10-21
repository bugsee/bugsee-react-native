#!/usr/bin/env bash
#
# Runs one check script once per React Native minor, a few at a time inside a
# single job, instead of one runner per version. Each of these checks takes
# 20 to 60 s of work behind 10 to 20 s of runner start-up and, on a busy day,
# minutes in the queue, so seven jobs cost more wall-clock than one job that
# runs them side by side. Each run keeps its own mktemp dir (the checks do),
# so the runs share nothing but the npm cache.
#
# Usage: ci-each-version.sh <parallelism> <script> [script args...] -- <minor>...
#   -> <script> <minor> [script args...], for each minor
# Fails if any run failed; prints each run's log in its own group, in order.
set -uo pipefail

JOBS="${1:?usage: ci-each-version.sh <parallelism> <script> [args...] -- <minor>...}"
SCRIPT="${2:?missing script}"
shift 2
ARGS=()
while [[ $# -gt 0 && "$1" != "--" ]]; do ARGS+=("$1"); shift; done
[[ "${1:-}" == "--" ]] || { echo "missing -- before the versions" >&2; exit 2; }
shift
[[ $# -gt 0 ]] || { echo "no versions given" >&2; exit 2; }
VERSIONS=("$@")

LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT
export LOGS SCRIPT
export ARGS_JOINED="${ARGS[*]:-}"

printf '%s\n' "${VERSIONS[@]}" | xargs -P "$JOBS" -I{} bash -c '
  # shellcheck disable=SC2086
  "$SCRIPT" "$1" $ARGS_JOINED > "$LOGS/$1.log" 2>&1
  echo $? > "$LOGS/$1.rc"
' _ {}

status=0
for v in "${VERSIONS[@]}"; do
  rc="$(cat "$LOGS/$v.rc" 2>/dev/null || echo 1)"
  echo "::group::$v (exit $rc)"
  cat "$LOGS/$v.log" 2>/dev/null || true
  echo "::endgroup::"
  if [[ "$rc" != 0 ]]; then echo "::error::$SCRIPT $v failed (exit $rc)"; status=1; fi
done
exit "$status"
