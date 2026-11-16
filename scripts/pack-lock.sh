#!/usr/bin/env bash
#
# A mkdir lock (flock is not on macOS) that is only ever released by the process that took it.
# Sourced by check-pack-install.sh, whose parallel runs (scripts/ci-each-version.sh) share one lock
# around `npm pack`: prepack/postpack stage and unstage native-versions.json inside the package
# directory, so one run's postpack would delete the file under another's pack.
#
#   pack_lock_acquire <lock dir> [seconds]   waits (default 300 s); returns 1 on timeout, or when the owner
#                                            cannot be recorded (the lock is then given back)
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
      # Called as `pack_lock_acquire ... || exit 1`, where set -e does not apply inside, so a failed write
      # must be handled here: a lock with no owner could never be released by its holder, and every later
      # run would wait the full time and fail with a message blaming someone else.
      if ! printf '%s\n' "$PACK_LOCK_TOKEN" > "$lock/owner"; then
        rm -f "$lock/owner" 2>/dev/null || true
        rmdir "$lock" 2>/dev/null || true
        PACK_LOCK_DIR=""
        PACK_LOCK_TOKEN=""
        echo "FAIL: could not record the owner in $lock" >&2
        return 1
      fi
      return 0
    fi
    waited=$((waited + 1))
    sleep "$poll"
  done
  echo "FAIL: could not take $lock (stale lock? remove it)" >&2
  return 1
}

# A warning that cannot be missed. ci-each-version.sh prints each run's log inside a collapsed group only
# after every run finished, and a run that warned still exits 0, so a plain line on stderr would sit
# unseen in a green job. On GitHub Actions it is also an annotation, which shows on the run's summary.
pack_lock_warn() {
  echo "warning: $1" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning title=pack-install lock::$1"
  fi
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
    pack_lock_warn "$lock is held by another run now; left it alone"
  else
    pack_lock_warn "$lock was removed while it was held, so the pack was not serialized. Nothing in this repository removes it: please report this run"
  fi
  return 0
}
