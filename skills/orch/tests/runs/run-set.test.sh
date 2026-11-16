#!/usr/bin/env bash
# dispatch.sh tests: run set <run> auto_dispatch true|false (lib/runs/pause.sh)
# Run: bash run-set.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 bash "$SCRIPT" "$@"; }
seed_home "$home"
state="$home/runs/set-1/state.json"

orch run start "Set test" --id set-1 >/dev/null 2>&1
expect_match "a new run has no auto_dispatch (off)" '^null$' "$(jq -r '.auto_dispatch' "$state")"

out=$(orch run set set-1 auto_dispatch true 2>&1); rc=$?
expect_exit "run set true exits 0" 0 "$rc"
expect_match "run set true prints the value" '^auto_dispatch: set-1 true$' "$out"
expect_match "auto_dispatch is true in state.json" '^true$' "$(jq -r '.auto_dispatch' "$state")"

orch run set set-1 auto_dispatch false >/dev/null 2>&1
expect_match "auto_dispatch is false in state.json" '^false$' "$(jq -r '.auto_dispatch' "$state")"

out=$(orch run set set-1 auto_dispatch maybe 2>&1); rc=$?
expect_exit "a bad value exits 2" 2 "$rc"
out=$(orch run set set-1 colour blue 2>&1); rc=$?
expect_exit "an unknown key exits 2" 2 "$rc"
out=$(orch run set no-such-run auto_dispatch true 2>&1); rc=$?
expect_no_match "an unknown run does not exit 0" '^0$' "$rc"

cleanup_dir "$home"

finish
