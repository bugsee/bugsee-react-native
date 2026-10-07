#!/bin/sh
# react.hermesCommand on macOS and Linux. Windows runs the command through
# `cmd /c`, which cannot run this file: there it is hermesc-preserve-js.cmd.
# The work, and its non-zero exit when no bytecode came out, is in
# hermesc-preserve-js.js.
dir="$(cd "$(dirname "$0")" && pwd)" || exit 1
exec node "$dir/hermesc-preserve-js.js" "$@"
