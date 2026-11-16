#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/pause.sh: pause/resume/stop flags, the pause guard, run set
# validation and usage errors, called in-process on a hand-built run with no running nodes.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'EOF'
{"run_id":"r1","title":"t","status":"running","edges":[],
 "nodes":[{"id":"a","status":"waiting"},{"id":"b","status":"done"}]}
EOF
st() { jq -c "$1" "$H/runs/r1/state.json"; }

run_is_paused r1; rc=$?
expect_exit "a fresh run is not paused" 1 "$rc"
run_is_paused nope; rc=$?
expect_exit "an unknown run is not paused" 1 "$rc"
out=$(pause_guard r1); rc=$?
expect_exit "the guard lets a live run through" 0 "$rc"
expect_empty "the guard prints nothing for a live run" "$out"

out=$(cmd_run_pause r1 2>&1); rc=$?
expect_exit "pause succeeds" 0 "$rc"
expect_match "pause reports the run" '^paused: r1$' "$out"
expect_match "pause sets paused and auto_resume" '^\[true,true,true\]$' "$(st '[.paused, .auto_resume, (.paused_at != null)]')"
out=$(pause_guard r1); rc=$?
expect_exit "the guard stops a paused run" 3 "$rc"
expect_match "the guard says how to resume" 'run paused: r1 \(dispatch.sh run resume r1\)' "$out"

out=$(cmd_run_resume r1 2>&1); rc=$?
expect_exit "resume of a run with no running nodes succeeds" 0 "$rc"
expect_match "resume reports the run" '^resumed: r1$' "$out"
expect_match "resume clears every flag" '^\[false,false,null,false\]$' "$(st '[.paused, .auto_resume, .paused_at, .stopped]')"

out=$(cmd_run_stop r1 2>&1); rc=$?
expect_exit "stop of a run with no running nodes succeeds" 0 "$rc"
expect_match "stop kills no job" 'killed 0 job' "$out"
expect_match "stop sets stopped and drops auto_resume" '^\[true,false\]$' "$(st '[.stopped, .auto_resume]')"
expect_match "the guard names a stopped run first" '^run stopped: r1' "$(pause_guard r1)"
out=$(cmd_run_resume r1 2>&1); rc=$?
expect_exit "a stopped run needs --stopped" 3 "$rc"
out=$(cmd_run_resume r1 --stopped 2>&1); rc=$?
expect_exit "resume --stopped resumes a stopped run" 0 "$rc"
expect_match "resume --stopped clears stopped" '^false$' "$(st .stopped)"

out=$(cmd_run_pause 2>&1); rc=$?
expect_exit "pause with no run is a usage error" 2 "$rc"
out=$(cmd_run_pause r1 extra 2>&1); rc=$?
expect_exit "pause with two args is a usage error" 2 "$rc"
out=$(cmd_run_resume r1 --bogus 2>&1); rc=$?
expect_exit "resume with an unknown flag is a usage error" 2 "$rc"
out=$(cmd_run_pause nope 2>&1); rc=$?
expect_exit "pause of an unknown run fails" 2 "$rc"

out=$(cmd_run_set r1 colour red 2>&1); rc=$?
expect_exit "run set rejects an unknown key" 2 "$rc"
out=$(cmd_run_set r1 auto_dispatch maybe 2>&1); rc=$?
expect_exit "run set rejects a non-boolean" 2 "$rc"
cmd_run_set r1 auto_dispatch true >/dev/null 2>&1
expect_match "run set stores auto_dispatch as a boolean" '^true$' "$(st .auto_dispatch)"

out=$(cmd_node_cancel r1 a 2>&1); rc=$?
expect_exit "cancel refuses a node that is not running" 3 "$rc"

mkdir -p "$H/jobs/j1" "$H/jobs/j2"
printf '%s\n' "$$" > "$H/jobs/j1/pid"
pause_job_alive j1; rc=$?
expect_exit "a job with a live pid is alive" 0 "$rc"
pause_job_alive j2 2>/dev/null; rc=$?
expect_exit "a job with no pid file is not alive" 1 "$rc"

cleanup_dir "$(dirname "$H")"
finish
