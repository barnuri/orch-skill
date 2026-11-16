#!/usr/bin/env bash
# dispatch.sh tests: node retry (split from run-lifecycle.test.sh)
# Run: bash run-lifecycle-c.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# node/run retry: failed attempts are archived, runs reopen, prompts are reused, and the
# scheduler never retries forever.
home=$(new_tmp)
shims=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

retry_state="$home/runs/retry-1/state.json"
orch run start "Retry test" --id retry-1 >/dev/null 2>&1
orch node add retry-1 a "retry me" >/dev/null 2>&1
job=$(orch node dispatch retry-1 a claude-native "again" --same args 2>/dev/null)
orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
orch run sync retry-1 >/dev/null 2>&1
orch node update retry-1 a error --force --job "$job" --error "exit=1" >/dev/null 2>&1
orch run finish retry-1 >/dev/null 2>&1
out=$(orch node retry retry-1 a 2>&1); rc=$?
expect_exit "node retry exits 0" 0 "$rc"
expect_match "node retry prints a new job id" '^[0-9]' "$out"
expect_match "node retry reopens a finished run" '^running$' "$(jq -r '.status' "$retry_state")"
expect_match "node retry clears finished time" '^null$' "$(jq -r '.finished | tostring' "$retry_state")"
expect_match "node retry marks the node running" '^running$' "$(jq -r '.nodes[0].status' "$retry_state")"
expect_match "node retry archives the failed job" "^$job$" "$(jq -r '.nodes[0].attempts[0].job_id' "$retry_state")"
expect_match "node retry records restarted mode for non-resumable harnesses" '^restarted$' "$(jq -r '.nodes[0].attempts[0].retry_mode' "$retry_state")"
expect_match "node retry preserves pass-through args" '^\["--same","args"\]$' "$(jq -c '.nodes[0].dispatch_args' "$retry_state")"

orch wait "$out" --timeout 60 --interval 1 >/dev/null 2>&1
orch run sync retry-1 >/dev/null 2>&1
out=$(orch node retry retry-1 a 2>&1); rc=$?
expect_exit "node retry wrong state exits 2" 2 "$rc"
expect_match "node retry wrong state is clear" 'not error or skipped' "$out"
cleanup_dir "$home"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
orch run start "Old retry" --id retry-old >/dev/null 2>&1
orch node add retry-old a "a" >/dev/null 2>&1
edit_json "$home/runs/retry-old/state.json" '.nodes[0] += {status:"error", adapter:"claude-native", job_id:"old", error:"exit=1", finished:"2026-09-01T00:00:00Z"}'
out=$(orch node retry retry-old a --no-dispatch "@/tmp/old-prompt.md" 2>&1); rc=$?
expect_exit "node retry old node accepts prompt with no dispatch" 0 "$rc"
expect_match "node retry old node becomes waiting" '^waiting$' "$(jq -r '.nodes[0].status' "$home/runs/retry-old/state.json")"
expect_match "node retry old node stores supplied prompt" '^@/tmp/old-prompt.md$' "$(jq -r '.nodes[0].prompt' "$home/runs/retry-old/state.json")"
cleanup_dir "$home"

finish
