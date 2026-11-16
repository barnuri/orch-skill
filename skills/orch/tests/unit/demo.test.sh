#!/usr/bin/env bash
# Fast-tier unit tests for lib/dashboard/demo.sh: the home guard, adapter mapping, mock job dirs and
# the seeded-run lookup, called in-process. Nothing is seeded and the real state dir is never written.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

expect_match "adapter mapping follows the profile prefix" '^cursor-agent opencode local-llm claude$' \
  "$(printf '%s ' "$(demo_adapter_for_profile cursor-default)" "$(demo_adapter_for_profile opencode-x)" \
    "$(demo_adapter_for_profile local-qwen)" "$(demo_adapter_for_profile claude-opus)" | sed 's/ $//')"

demo_guard_home 0; rc=$?
expect_exit "a scratch home needs no --force" 0 "$rc"
out=$( (ORCH_HOME="$DEMO_DEFAULT_HOME"; demo_guard_home 0) 2>&1); rc=$?
expect_exit "the real state dir is refused" 2 "$rc"
expect_match "  ... with a hint to pass --force" 'pass --force' "$out"
( ORCH_HOME="$DEMO_DEFAULT_HOME"; demo_guard_home 1 ); rc=$?
expect_exit "  ... unless forced" 0 "$rc"

job=$(demo_job_create opencode opencode-x "Write docs" 0)
expect_match "job create prints a demo job id" '^demo-[0-9]{6}-[0-9]+$' "$job"
expect_match "  ... and writes adapter, profile and exit code" '^opencode opencode-x 0$' \
  "$(printf '%s %s %s' "$(cat "$JOBS_HOME/$job/adapter")" "$(cat "$JOBS_HOME/$job/profile")" "$(cat "$JOBS_HOME/$job/exit_code")")"
session=$(cat "$JOBS_HOME/$job/session")
expect_match "  ... and a log that ends with the adapter, profile and session" \
  "^\[opencode · profile opencode-x · session $session\]$" "$(tail -n 1 "$JOBS_HOME/$job/log")"
expect_match "  ... and opens with the label as the prompt" '^\$ opencode -p "Write docs"' "$(head -n 1 "$JOBS_HOME/$job/log")"
job2=$(demo_job_create claude claude-opus "Run" -)
expect_missing "a running job (-) has no exit_code" "$JOBS_HOME/$job2/exit_code"

out=$(demo_first_seeded_run 2>&1); rc=$?
expect_exit "no seeded run returns 2" 2 "$rc"
mkdir -p "$RUNS_HOME/real" "$RUNS_HOME/seeded"
: > "$RUNS_HOME/seeded/$DEMO_MARKER_FILE"
demo_is_seeded_run real; rc=$?
expect_exit "a run without the marker is not seeded" 1 "$rc"
expect_match "the seeded run is found as a fallback" '^seeded$' "$(demo_first_seeded_run)"

out=$(cmd_demo bogus 2>&1); rc=$?
expect_exit "an unknown demo verb is a usage error" 2 "$rc"
out=$(cmd_demo 2>&1); rc=$?
expect_exit "no verb is a usage error" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
