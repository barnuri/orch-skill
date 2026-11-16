#!/usr/bin/env bash
# dispatch.sh tests: node timing (lib/runs/timing.sh): dispatched_at / started_at / finished_at,
# the `starting` phase, run_segments over retries, stop and resume pauses, and run backfill-timing.
# Run: bash timing.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 bash "$SCRIPT" "$@"; }
seed_home "$home"
state="$home/runs/time-1/state.json"
node_get() { jq -r --arg n "$1" ".nodes[] | select(.id == \$n) | $2" "$state"; }

orch run start "Timing test" --id time-1 >/dev/null 2>&1
orch node add time-1 a "timed node" >/dev/null 2>&1
orch node add time-1 b "stopped node" >/dev/null 2>&1

# dispatch: running, dispatched_at set, started_at null (the `starting` phase).
job=$(orch node dispatch time-1 a claude-native "do a" 2>/dev/null)
expect_match "dispatch sets running" '^running$' "$(node_get a .status)"
expect_no_match "dispatch stamps dispatched_at" '^null$' "$(node_get a .dispatched_at)"
expect_match "dispatch leaves started_at null (starting)" '^null$' "$(node_get a .started_at)"
expect_match "dispatch opens a segment" '^true$' "$(node_get a .seg_open)"
expect_match "legacy started stays readable" '^20' "$(node_get a .started)"

# first activity: node ping ends `starting`, once.
orch node ping time-1 a --progress 1/3 >/dev/null 2>&1
first=$(node_get a .started_at)
expect_match "first ping stamps started_at" '^20[0-9-]+T' "$first"
expect_match "first ping logs a started event" '"kind":"started"' "$(grep '"node":"a"' "$home/runs/time-1/events.jsonl")"
sleep 1
orch node ping time-1 a --progress 2/3 >/dev/null 2>&1
expect_match "a second ping keeps started_at" "^$first$" "$(node_get a .started_at)"
out=$(orch node started time-1 a --at 2000-01-01T00:00:00Z 2>&1); rc=$?
expect_exit "node started on a started node exits 0" 0 "$rc"
expect_match "node started never moves started_at" "^$first$" "$(node_get a .started_at)"

# finish: finished_at set, the segment closes into run_segments.
orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
orch node update time-1 a error --error "process died" >/dev/null 2>&1
expect_no_match "error stamps finished_at" '^null$' "$(node_get a .finished_at)"
expect_match "error closes the segment" '^false$' "$(node_get a .seg_open)"
expect_match "one segment recorded" '^1$' "$(node_get a '.run_segments | length')"
expect_match "segment keeps its start" "^$first$" "$(node_get a '.run_segments[0].start')"

# retry: a new segment, starting again, the old one kept.
orch node retry time-1 a --no-dispatch >/dev/null 2>&1
job2=$(orch node dispatch time-1 a claude-native "do a again" 2>/dev/null)
expect_match "retry dispatch is starting again" '^null$' "$(node_get a .started_at)"
expect_match "retry keeps the first segment" '^1$' "$(node_get a '.run_segments | length')"
orch owner event "$job2" started --harness test >/dev/null 2>&1
expect_match "owner start stamps started_at on the retry" '^20[0-9-]+T' "$(node_get a .started_at)"
orch wait "$job2" --timeout 60 --interval 1 >/dev/null 2>&1
orch node update time-1 a done >/dev/null 2>&1
expect_match "retry closes a second segment" '^2$' "$(node_get a '.run_segments | length')"

# stop and resume: the stop closes the segment, resume records the paused stretch.
job3=$(orch node dispatch time-1 b claude-native "do b" 2>/dev/null)
orch node started time-1 b --source test >/dev/null 2>&1
orch wait "$job3" --timeout 60 --interval 1 >/dev/null 2>&1
orch run stop time-1 >/dev/null 2>&1
expect_match "stop sets the node stopped" '^stopped$' "$(node_get b .status)"
expect_match "stop closes the segment" '^false$' "$(node_get b .seg_open)"
expect_match "stop records the segment" '^1$' "$(node_get b '.run_segments | length')"
sleep 1
orch run resume time-1 --stopped >/dev/null 2>&1
expect_match "resume records one pause" '^1$' "$(jq -r '.pauses | length' "$state")"
expect_match "the pause has from < to" '^true$' "$(jq -r '.pauses[0].from < .pauses[0].to' "$state")"

# backfill: a legacy node (only `started`) gets dispatched_at, started_at from the job log or null.
orch run start "Legacy" --id legacy-1 >/dev/null 2>&1
orch node add legacy-1 old "legacy node" >/dev/null 2>&1
orch node add legacy-1 nolog "legacy node without evidence" >/dev/null 2>&1
mkdir -p "$home/jobs/job-old"
printf 'hello\n' > "$home/jobs/job-old/log"
legacy="$home/runs/legacy-1/state.json"
edit_json "$legacy" '.nodes |= map(.status = "done" | .started = "2026-01-01T00:00:00Z" | .finished = "2030-01-01T00:00:00Z"
  | (if .id == "old" then .job_id = "job-old" else .job_id = "job-none" end)
  | del(.dispatched_at, .started_at, .finished_at, .run_segments, .seg_open))'
out=$(orch run backfill-timing legacy-1 2>&1); rc=$?
expect_exit "backfill-timing exits 0" 0 "$rc"
expect_match "backfill reports two nodes" 'legacy-1 2 node' "$out"
lget() { jq -r --arg n "$1" ".nodes[] | select(.id == \$n) | $2" "$legacy"; }
expect_match "backfill sets dispatched_at from started" '^2026-01-01T00:00:00Z$' "$(lget old .dispatched_at)"
expect_no_match "backfill takes started_at from the job log" '^null$' "$(lget old .started_at)"
expect_match "backfill leaves started_at null without evidence" '^null$' "$(lget nolog .started_at)"
expect_match "backfill sets finished_at" '^2030-01-01T00:00:00Z$' "$(lget nolog .finished_at)"
expect_match "backfill writes one segment" '^1$' "$(lget nolog '.run_segments | length')"
out=$(orch run backfill-timing legacy-1 2>&1)
expect_match "backfill is idempotent" 'legacy-1 0 node' "$out"

cleanup_dir "$home"
finish
