#!/usr/bin/env bash
# dispatch.sh tests: demo seeding, part a: demo seed, advance and reset (no harness is ever reached).
# Run: bash demo-seeding-a.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- demo seeding -----------------------------------------------------------------------------
# The demo exists so a reader can see the dashboard populated without spending a token, so the
# thing worth guarding is that it never reaches a harness and that reset removes exactly what
# seed created.
demo=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo 2>&1); rc=$?
expect_exit "demo with no verb exits 2" 2 "$rc"
expect_match "demo with no verb prints its grammar" 'demo seed' "$out"

# The default state dir is the user's real one; seeding fake runs into it takes --force.
out=$(env -u HARNESS_ORCH_HOME bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed refuses the default home" 2 "$rc"
expect_match "demo seed names the scratch-dir escape" 'HARNESS_ORCH_HOME' "$out"

seed_home "$demo"
# No harness CLI on PATH at all: if seeding tried to dispatch, it would fail loudly here.
out=$(env HARNESS_ORCH_HOME="$demo" PATH="$(path_without claude cursor-agent opencode)" \
  bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed exits 0 with no harness CLI present" 0 "$rc"
expect_match "demo seed reports what it seeded" 'seeded 4 runs' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo seeds a run in flight" 'running.*Ship the payments service' "$out"
expect_match "demo seeds a failed run" 'error.*Migrate the llm-hub profiles' "$out"
expect_match "demo seeds a finished run" 'done.*Nightly benchmark sweep' "$out"

state=$(cat "$demo"/runs/*/state.json | jq -s '.')
statuses=$(printf '%s' "$state" | jq -r '[.[].nodes[].status] | unique | join(",")')
expect_match "demo covers every node status" '^done,error,running,skipped,waiting$' "$statuses"
adapters=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select(.adapter != null) | .adapter] | unique | join(",")')
expect_match "demo covers more than one harness" 'claude,cursor-agent' "$adapters"
tails=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select((.log_tail | length) > 0)] | length')
expect_match "demo nodes carry a log tail" '^[1-9]' "$tails"

# Every job dir a real dispatch would write, so the transcript view and `tail` work on demo data.
job_dir=$(ls -d "$demo"/jobs/demo-*/ 2>/dev/null | head -1)
expect_file "demo job has a full log" "$job_dir/log"
expect_file "demo job records its adapter" "$job_dir/adapter"
expect_file "demo job records a session id" "$job_dir/session"
session=$(cat "$job_dir/session" 2>/dev/null)
expect_match "demo session id is a uuid" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$session"

# A run the demo did not create must survive reset.
env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run start "a real run" --id 20260101-000000-keep >/dev/null 2>&1
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo advance 2>&1); rc=$?
expect_exit "demo advance exits 0" 0 "$rc"
expect_match "demo advance reports the node it moved" '	(done|running)$' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset removes the seeded runs" 'removed 4 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset is idempotent" 'removed 0 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo reset leaves a non-demo run alone" '20260101-000000-keep' "$out"
expect_missing "demo reset clears the demo job dirs" "$job_dir"
cleanup_dir "$demo"

finish
