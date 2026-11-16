#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/current-run.sh: the saved current run and the `.` run id.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

out=$(cmd_use 2>&1); rc=$?
expect_exit "use with no saved run fails" 1 "$rc"
expect_match "use with no saved run says how to set one" 'no current run' "$out"

out=$(cmd_use ../x 2>&1); rc=$?
expect_exit "use rejects a path as run id" 2 "$rc"
out=$(cmd_use nope 2>&1); rc=$?
expect_exit "use rejects an unknown run" 1 "$rc"
expect_match "use names the unknown run" 'no such run: nope' "$out"

mkdir -p "$H/runs/r1" && printf '{}' > "$H/runs/r1/state.json"
out=$(cmd_use r1); rc=$?
expect_exit "use saves a known run" 0 "$rc"
expect_match "use prints the saved run" '^r1$' "$out"
expect_match "use alone prints the saved run" '^r1$' "$(cmd_use)"

expect_match "resolve passes a real id through" '^r9$' "$(current_run_resolve r9)"
expect_match "resolve maps . to the saved run" '^r1$' "$(current_run_resolve .)"
: > "$H/current-run"
out=$(current_run_resolve . 2>&1); rc=$?
expect_exit "resolve of . with no saved run fails" 1 "$rc"

cleanup_dir "$(dirname "$H")"
finish
