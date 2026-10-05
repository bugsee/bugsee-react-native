#!/usr/bin/env bash
# Launches the installed example app once on a simulator, through the whole
# launch walk, and stops it: the simulator's Metal compiler is then warm and
# the app's shader cache populated before an e2e times a launch.
#
# Why: Bugsee.launch() brings video capture up on the MAIN thread, and that
# compiles the SDK's Metal shaders from source (InitMetalDevice ->
# -[MTLDevice newLibraryWithSource:], a synchronous XPC to MTLCompilerService).
# On a freshly erased simulator nothing is cached and the compiler is cold. On
# the CI runner that costs about 2 s, and now and then more than the 10 s
# launch.test.ts allows Status.Launched: main is blocked, so neither the
# status poll (it reads on main) nor the Launched completion (posted to main)
# runs, and the console goes quiet after `status=1 (Launching)`.
#
# The bundle comes from a Metro of its own, on its own port, stopped before
# this returns. The e2e's Metro must not have built a bundle before the e2e
# writes e2e-scenario.json: on the CI runner it then keeps serving the old
# file, and awaitMetroServes (e2e/scenario.ts) times out.
#
# The launch is steered by launch arguments (App.tsx launchArguments), to the
# e2e's dead endpoint (e2e/bundles.ts DEAD_ENDPOINT), so it contacts no
# server and leaves no stopped flag. App.tsx ignores the arguments unless the
# nonce is hex, and then falls back to the JSON and the configured endpoint:
# the scenario line is checked, and a launch that did not take them is
# stopped and fails the script.
#
# Usage: warm-simulator-metal.sh <simulator udid> [metro port, default 8098]
set -euo pipefail

udid="${1:?usage: warm-simulator-metal.sh <simulator udid> [metro port]}"
port="${2:-8098}"
bundle_id=org.reactjs.native.example.BareExample
dead_endpoint=https://127.0.0.1:9
nonce=00000000a11e # hex, as App.tsx requires; no test waits for it
# The walk ends with this line (App.tsx), after relaunch, so capture has been
# started twice by the time it prints.
done_marker='BUGSEE_E2E post-relaunch status='
budget_s=180

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
metro=""
console=""

stop_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    stop_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  [[ -n "$console" ]] && stop_tree "$console"
  xcrun simctl terminate "$udid" "$bundle_id" 2>/dev/null || true
  [[ -n "$metro" ]] && stop_tree "$metro"
  # Whatever still listens on the port is this script's Metro.
  lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

(cd "$app_dir" && exec yarn start --port "$port") >"$work/metro.log" 2>&1 &
metro=$!
for _ in $(seq 1 120); do
  curl -sf "http://localhost:${port}/status" >/dev/null && break
  sleep 1
done
if ! curl -sf "http://localhost:${port}/status" >/dev/null; then
  echo "::warning title=Metal warm-up::its Metro on port ${port} did not start; skipped"
  cat "$work/metro.log"
  exit 0
fi

xcrun simctl launch --console-pty --terminate-running-process "$udid" "$bundle_id" \
  -RCT_jsLocation "localhost:${port}" \
  -bugseeE2eScenario launch -bugseeE2eNonce "$nonce" \
  -bugseeE2eEndpoint "$dead_endpoint" >"$work/console.log" 2>&1 &
console=$!

started=$SECONDS
checked=no
while ! grep -q "$done_marker" "$work/console.log"; do
  if [[ $checked == no ]] && grep -q 'BUGSEE_E2E scenario=' "$work/console.log"; then
    if ! grep -q "BUGSEE_E2E scenario=launch nonce=${nonce} source=args .*endpoint=${dead_endpoint}" \
      "$work/console.log"; then
      xcrun simctl terminate "$udid" "$bundle_id" 2>/dev/null || true
      echo "::error title=Metal warm-up::the app did not take the warm-up's launch arguments"
      grep 'BUGSEE_E2E' "$work/console.log" || true
      exit 1
    fi
    checked=yes
  fi
  if (( SECONDS - started >= budget_s )) || ! kill -0 "$console" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if grep -q "$done_marker" "$work/console.log"; then
  echo "warm-simulator-metal: the launch walk finished in $(( SECONDS - started ))s"
else
  # Not fatal: the e2e that follows reports the real failure with its own log.
  echo "::warning title=Metal warm-up::the warm-up launch did not finish its walk in ${budget_s}s"
  cat "$work/console.log"
fi
