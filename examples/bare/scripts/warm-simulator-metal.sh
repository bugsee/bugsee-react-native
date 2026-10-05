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
# The same app, the same dead endpoint as the e2e (bundles.ts DEAD_ENDPOINT),
# so it contacts no server and leaves no stopped flag. Its nonce is not one a
# test waits for.
#
# Usage: warm-simulator-metal.sh <simulator udid>
set -euo pipefail

udid="${1:?usage: warm-simulator-metal.sh <simulator udid>}"
bundle_id=org.reactjs.native.example.BareExample
dead_endpoint=https://127.0.0.1:9
# The walk ends with this line (App.tsx), after relaunch, so capture has been
# started twice by the time it prints.
done_marker='BUGSEE_E2E post-relaunch status='
budget_s=120

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

xcrun simctl launch --console-pty --terminate-running-process "$udid" "$bundle_id" \
  -bugseeE2eScenario launch -bugseeE2eNonce warmup \
  -bugseeE2eEndpoint "$dead_endpoint" >"$log" 2>&1 &
console=$!

started=$SECONDS
while ! grep -q "$done_marker" "$log"; do
  if (( SECONDS - started >= budget_s )) || ! kill -0 "$console" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
elapsed=$(( SECONDS - started ))

kill "$console" 2>/dev/null || true
wait "$console" 2>/dev/null || true
xcrun simctl terminate "$udid" "$bundle_id" 2>/dev/null || true

if grep -q "$done_marker" "$log"; then
  echo "warm-simulator-metal: the launch walk finished in ${elapsed}s"
else
  # Not fatal: the e2e that follows reports the real failure with its own log.
  echo "::warning title=Metal warm-up::the warm-up launch did not finish its walk in ${budget_s}s"
  cat "$log"
fi
