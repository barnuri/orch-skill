#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/timing.sh: seg_close, node started stamping and clamping, and
# the legacy timing backfill, called in-process on a fixture run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'EOF'
{"run_id":"r1","title":"Demo","status":"running","edges":[],"nodes":[
 {"id":"a","status":"running","seg_open":true,"dispatched_at":"2026-01-01T00:00:10Z","started_at":null},
 {"id":"w","status":"waiting","seg_open":false,"started_at":null},
 {"id":"old","status":"done","job_id":null,"started":"2026-01-01T00:00:00Z","finished":"2026-01-01T00:05:00Z"}]}
EOF
F="$H/runs/r1/state.json"

# --- seg_close (pure jq)
seg() { jq -c "$TIMING_JQ_DEFS"' seg_close($at) | {seg_open, run_segments}' --arg at "$1" <<<"$2"; }
expect_match "an open started segment is closed into run_segments" \
  '^\{"seg_open":false,"run_segments":\[\{"dispatched":"T1","start":"T2","end":"T3"\}\]\}$' \
  "$(seg T3 '{"seg_open":true,"dispatched_at":"T1","started_at":"T2"}')"
expect_match "a never-started segment ending at its dispatch time is dropped" \
  '^\{"seg_open":false,"run_segments":null\}$' "$(seg T1 '{"seg_open":true,"dispatched_at":"T1","started_at":null}')"

# --- arg errors
out=$(cmd_node_started r1 2>&1); rc=$?
expect_exit "node started with no node is a usage error" 2 "$rc"
out=$(cmd_node_started r1 a --bogus 2>&1); rc=$?
expect_exit "node started rejects an unknown flag" 2 "$rc"
out=$(cmd_node_started r1 ghost 2>&1); rc=$?
expect_exit "node started on an unknown node fails" 2 "$rc"

# --- node_mark_started: clamps to dispatch, stamps once, skips non-running nodes
node_mark_started r1 a 2026-01-01T00:00:05Z test
expect_match "a start before the dispatch is clamped to dispatched_at" '^2026-01-01T00:00:10Z$' \
  "$(jq -r '.nodes[0].started_at' "$F")"
node_mark_started r1 a 2026-01-01T00:09:00Z test
expect_match "a second start does not move started_at" '^2026-01-01T00:00:10Z$' "$(jq -r '.nodes[0].started_at' "$F")"
node_mark_started r1 w 2026-01-01T00:09:00Z test
expect_match "a waiting node is not stamped" '^null$' "$(jq -r '.nodes[1].started_at' "$F")"
expect_match "one started event is logged" '^1$' "$(grep -c '"kind":"started"' "$H/runs/r1/events.jsonl")"

# --- timing_job_log_start: nothing without a job or a log
expect_empty "no job gives no log start" "$(timing_job_log_start '')"
expect_empty "a job with no log gives no log start" "$(timing_job_log_start no-such-job)"

# --- backfill: a legacy inline done node gets dispatch, start, finish and one segment
out=$(cmd_run_backfill_timing r1); rc=$?
expect_exit "backfill succeeds" 0 "$rc"
expect_match "backfill counts the one legacy node" '^backfill-timing: r1 1 node' "$out"
expect_match "the legacy node is filled from started/finished" \
  '^2026-01-01T00:00:00Z 2026-01-01T00:00:00Z 2026-01-01T00:05:00Z false 1$' \
  "$(jq -r '.nodes[2] | "\(.dispatched_at) \(.started_at) \(.finished_at) \(.seg_open) \(.run_segments | length)"' "$F")"

cleanup_dir "$(dirname "$H")"
finish
