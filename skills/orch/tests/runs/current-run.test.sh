#!/usr/bin/env bash
# `dispatch.sh use <run-id>` and the `.` run-id shortcut for node update|report|batch and run sync.
# Self-contained; run with: bash current-run.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

home=$(new_tmp)
seed_home "$home"
o() { HARNESS_ORCH_HOME="$home" ORCH_OWNER_FILL=0 bash "$SCRIPT" "$@"; }

out=$(o node update . a running 2>&1); rc=$?
expect_exit "'.' with no saved run fails" 1 "$rc"
expect_match "'.' with no saved run explains" 'no current run' "$out"

out=$(o use nope-run 2>&1); rc=$?
expect_exit "use rejects an unknown run" 1 "$rc"

R=$(o run start "current run")
o node add "$R" a "A" >/dev/null
expect_match "use prints the run id" "^$R\$" "$(o use "$R")"
expect_match "current-run file holds the run id" "^$R\$" "$(cat "$home/current-run")"
expect_match "use with no arg prints the saved run" "^$R\$" "$(o use)"

o node update . a running >/dev/null; rc=$?
expect_exit "node update . exits 0" 0 "$rc"
expect_match "node update . changed the saved run" '^running$' "$(jq -r '.nodes[] | select(.id=="a") | .status' "$home/runs/$R/state.json")"

printf '{"op":"add","id":"b","goal":"node b"}\n' | o node batch . >/dev/null; rc=$?
expect_exit "node batch . exits 0" 0 "$rc"
expect_match "node batch . added to the saved run" '^b$' "$(jq -r '.nodes[] | select(.id=="b") | .id' "$home/runs/$R/state.json")"

o run sync . >/dev/null 2>&1; rc=$?
expect_exit "run sync . exits 0" 0 "$rc"

finish
