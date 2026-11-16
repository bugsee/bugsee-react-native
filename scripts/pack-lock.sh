#!/usr/bin/env bash
#
# A mkdir lock (flock is not on macOS) that is only ever released by the process that took it.
# Sourced by check-pack-install.sh, whose parallel runs (scripts/ci-each-version.sh) share one lock
# around `npm pack`: prepack/postpack stage and unstage native-versions.json inside the package
# directory, so one run's postpack would delete the file under another's pack.
#
#   pack_lock_acquire <lock dir> [seconds]   waits (default 300 s); returns 1 on timeout
#   pack_lock_release                        idempotent; safe to call from an EXIT trap AND explicitly
#
# Why release checks ownership. The original release was a bare `rmdir "$lock"` under `set -e`. It
# removed whatever sat at that path, and failed the whole run with "rmdir: failed to remove ...: No
# such file or directory" when the directory was already gone, although the pack it guarded had
# finished. A holder now writes a token into the lock, and release removes the lock only if the
# token is still its own. A lock that is gone or has been taken by someone else is reported, not
# removed and not fatal: serialization already failed by then, and failing the run as well, or
# deleting another run's lock, only spreads it.
#
# PACK_LOCK_POLL is the wait between attempts, in seconds (default 1; tests use less).

PACK_LOCK_DIR=""
PACK_LOCK_TOKEN=""

pack_lock_acquire() {
  local lock="$1" seconds="${2:-300}" poll="${PACK_LOCK_POLL:-1}" waited=0
  # Attempts, not seconds, so a fractional poll still gives the caller's total wait.
  local attempts
  attempts=$(awk -v s="$seconds" -v p="$poll" 'BEGIN { n = int(s / p); print (n < 1 ? 1 : n) }')
  while [[ "$waited" -lt "$attempts" ]]; do
    if mkdir "$lock" 2>/dev/null; then
      PACK_LOCK_DIR="$lock"
      PACK_LOCK_TOKEN="$$.$RANDOM$RANDOM"
      printf '%s\n' "$PACK_LOCK_TOKEN" > "$lock/owner"
      return 0
    fi
    waited=$((waited + 1))
    sleep "$poll"
  done
  echo "FAIL: could not take $lock (stale lock? remove it)" >&2
  return 1
}

pack_lock_release() {
  [[ -n "$PACK_LOCK_TOKEN" ]] || return 0
  local lock="$PACK_LOCK_DIR" token="$PACK_LOCK_TOKEN" owner=""
  # Cleared first: a trap that fires while this runs must not release twice.
  PACK_LOCK_DIR=""
  PACK_LOCK_TOKEN=""
  owner="$(cat "$lock/owner" 2>/dev/null || true)"
  if [[ "$owner" == "$token" ]]; then
    rm -f "$lock/owner"
    rmdir "$lock" 2>/dev/null || true
    return 0
  fi
  if [[ -e "$lock" ]]; then
    echo "warning: $lock is held by another run now; left it alone" >&2
  else
    echo "warning: $lock was removed while it was held, so the pack was not serialized" >&2
  fi
  return 0
}
