#!/usr/bin/env bash
# dispatch.sh tests: run pause / run resume (lib/pause.sh)
# Run: bash pause.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 bash "$SCRIPT" "$@"; }
seed_home "$home"
state="$home/runs/pause-1/state.json"
node_get() { jq -r --arg n "$1" ".nodes[] | select(.id == \$n) | $2" "$state"; }

orch run start "Pause test" --id pause-1 >/dev/null 2>&1
orch node add pause-1 dead "dies on restart" >/dev/null 2>&1
orch node add pause-1 live "keeps running" >/dev/null 2>&1
orch node add pause-1 later "not started yet" >/dev/null 2>&1

# Both nodes are dispatched (claude-native is the fake adapter: it exits at once).
dead_job=$(orch node dispatch pause-1 dead claude-native "do dead" --flag x 2>/dev/null)
live_job=$(orch node dispatch pause-1 live claude-native "do live" 2>/dev/null)
orch wait "$dead_job" --timeout 60 --interval 1 >/dev/null 2>&1
orch wait "$live_job" --timeout 60 --interval 1 >/dev/null 2>&1
dead_session=$(node_get dead .session)
expect_no_match "dead node has a recorded session" '^$|^null$' "$dead_session"

# The live node's job gets a live pid; the dead node's job pid is gone (as after a restart).
sleep 120 &
live_pid=$!
printf '%s\n' "$live_pid" > "$home/jobs/$live_job/pid"

# pause
out=$(orch run pause pause-1 2>&1); rc=$?
expect_exit "run pause exits 0" 0 "$rc"
expect_match "run pause sets paused in state.json" '^true$' "$(jq -r '.paused' "$state")"
expect_match "run pause sets auto_resume in state.json" '^true$' "$(jq -r '.auto_resume' "$state")"
out=$(orch run status pause-1 2>&1)
expect_match "run status shows paused" '^paused: true$' "$out"

# while paused: sync and dispatch start nothing
out=$(orch run sync pause-1 2>&1); rc=$?
expect_match "run sync prints run paused" 'run paused' "$out"
expect_exit "run sync while paused exits 0" 0 "$rc"
expect_match "sync while paused leaves the dead node running" '^running$' "$(node_get dead .status)"
out=$(orch node dispatch pause-1 later claude-native "go" 2>&1); rc=$?
expect_match "node dispatch prints run paused" 'run paused' "$out"
expect_exit "node dispatch while paused exits 3" 3 "$rc"
expect_match "paused dispatch starts nothing" '^waiting$' "$(node_get later .status)"
expect_match "pause survives on disk (fresh read)" '^true$' "$(jq -r '.paused' "$state")"

# resume
out=$(orch run resume pause-1 2>&1); rc=$?
expect_exit "run resume exits 0" 0 "$rc"
expect_match "run resume clears paused" '^false$' "$(jq -r '.paused' "$state")"
expect_match "run resume clears auto_resume" '^false$' "$(jq -r '.auto_resume' "$state")"
expect_no_match "run status no longer shows paused" '^paused: true$' "$(orch run status pause-1 2>&1)"
expect_match "resume reports the live node as alive" "^alive: live $live_job$" "$out"
expect_match "resume re-dispatches the dead node" '^redispatched: dead ' "$out"
new_job=$(node_get dead .job_id)
expect_no_match "dead node has a new job" "^$dead_job$" "$new_job"
expect_match "dead node is running again" '^running$' "$(node_get dead .status)"
expect_match "re-dispatch resumes the recorded session" "^$dead_session$" "$(tr -d '\n' < "$home/jobs/$new_job/session")"
expect_match "re-dispatch keeps the pass-through args" '^\["--flag","x"\]$' "$(node_get dead '.dispatch_args | tojson')"
expect_match "live node keeps its job" "^$live_job$" "$(node_get live .job_id)"
expect_match "live node is still running" '^running$' "$(node_get live .status)"

# after resume, dispatch works again
job=$(orch node dispatch pause-1 later claude-native "go" 2>/dev/null); rc=$?
expect_exit "node dispatch after resume exits 0" 0 "$rc"
expect_match "dispatch after resume starts the node" '^running$' "$(node_get later .status)"

# node cancel kills only the named running node's job and marks only that node stopped
sleep 300 &
cancel_pid=$!
mkdir -p "$home/jobs/cancel-job"
printf '%s\n' "$cancel_pid" > "$home/jobs/cancel-job/pid"
orch node add pause-1 cancel-me "to cancel" >/dev/null 2>&1
orch node update pause-1 cancel-me running --job cancel-job >/dev/null 2>&1
out=$(orch node cancel pause-1 cancel-me 2>&1); rc=$?
expect_exit "node cancel exits 0" 0 "$rc"
expect_match "node cancel reports the job kill" '^cancelled: cancel-me \(job killed\)$' "$out"
expect_match "cancelled node is stopped" '^stopped$' "$(node_get cancel-me .status)"
expect_match "cancelled job process is gone" '^gone$' "$(kill -0 "$cancel_pid" 2>/dev/null && echo alive || echo gone)"
expect_match "cancel leaves the live node running" '^running$' "$(node_get live .status)"
expect_match "cancel leaves the run unstopped" '^false$|^null$' "$(jq -r '.stopped // false' "$state")"
out=$(orch node retry pause-1 cancel-me --no-dispatch 2>&1); rc=$?
expect_exit "node retry restarts a cancelled node" 0 "$rc"
expect_match "restart puts the cancelled node back to waiting" '^waiting$' "$(node_get cancel-me .status)"
out=$(orch node cancel pause-1 cancel-me 2>&1); rc=$?
expect_exit "node cancel refuses a node that is not running" 3 "$rc"

kill "$live_pid" 2>/dev/null
orch wait "$new_job" --timeout 60 --interval 1 >/dev/null 2>&1
orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
cleanup_dir "$home"

finish
