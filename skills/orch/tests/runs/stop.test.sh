#!/usr/bin/env bash
# dispatch.sh tests: run stop / run resume --stopped (lib/pause.sh)
# Run: bash stop.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

home=$(new_tmp)
shims=$(new_tmp)
# A claude shim that runs long, so the node's job is alive when the run is stopped.
printf '#!/usr/bin/env bash\nsleep 60\n' > "$shims/claude"
chmod +x "$shims/claude"
orch() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 bash "$SCRIPT" "$@"; }
seed_home "$home"
state="$home/runs/stop-1/state.json"
node_get() { jq -r --arg n "$1" ".nodes[] | select(.id == \$n) | $2" "$state"; }

orch run start "Stop test" --id stop-1 >/dev/null 2>&1
orch node add stop-1 live "runs long" >/dev/null 2>&1
orch node add stop-1 later "not started yet" >/dev/null 2>&1
live_job=$(orch node dispatch stop-1 live claude "do live" 2>/dev/null)
live_pid=$(tr -d ' \n' < "$home/jobs/$live_job/pid")
expect_match "the live job has a pid" '^[0-9]+$' "$live_pid"

# stop
out=$(orch run stop stop-1 2>&1); rc=$?
expect_exit "run stop exits 0" 0 "$rc"
expect_match "run stop reports the killed job" '^stopped: stop-1 \(killed 1 job\(s\)\)$' "$out"
if kill -0 "$live_pid" 2>/dev/null; then alive=yes; else alive=no; fi
expect_match "run stop kills the job process" '^no$' "$alive"
expect_match "run stop sets stopped in state.json" '^true$' "$(jq -r '.stopped' "$state")"
expect_match "run stop clears auto_resume" '^false$' "$(jq -r '.auto_resume' "$state")"
expect_match "run stop marks the running node stopped (not error)" '^stopped$' "$(node_get live .status)"
expect_match "run stop leaves the waiting node waiting" '^waiting$' "$(node_get later .status)"
expect_no_match "run stop does not cancel the run" '^cancelled$' "$(jq -r '.status' "$state")"
out=$(orch run status stop-1 2>&1)
expect_match "run status shows stopped" '^stopped: true$' "$out"

# while stopped: sync and dispatch start nothing, plain resume refuses
out=$(orch run sync stop-1 2>&1); rc=$?
expect_match "run sync prints run stopped" 'run stopped' "$out"
expect_exit "run sync while stopped exits 0" 0 "$rc"
expect_match "sync while stopped leaves the node stopped" '^stopped$' "$(node_get live .status)"
out=$(orch node dispatch stop-1 later claude "go" 2>&1); rc=$?
expect_exit "node dispatch while stopped exits 3" 3 "$rc"
expect_match "stopped dispatch starts nothing" '^waiting$' "$(node_get later .status)"
out=$(orch run resume stop-1 2>&1); rc=$?
expect_exit "run resume without --stopped exits 3" 3 "$rc"
expect_match "run resume without --stopped names the flag" '\-\-stopped' "$out"
expect_match "refused resume keeps the run stopped" '^true$' "$(jq -r '.stopped' "$state")"
out=$(orch run resume stop-1 --bogus 2>&1); rc=$?
expect_exit "run resume with an unknown flag exits 2" 2 "$rc"

# boot resume (src/server/runs/boot-resume.ts) only picks auto_resume runs: pause after stop
# must not make a stopped run auto-resume either.
expect_no_match "a stopped run is not an auto-resume candidate" '^true true$' \
  "$(jq -r '"\(.paused // false) \(.auto_resume // false)"' "$state")"

# resume --stopped (the user path)
out=$(orch run resume stop-1 --stopped 2>&1); rc=$?
expect_exit "run resume --stopped exits 0" 0 "$rc"
expect_match "run resume --stopped clears stopped" '^false$' "$(jq -r '.stopped' "$state")"
expect_match "run resume --stopped re-dispatches the stopped node" '^redispatched: live ' "$out"
new_job=$(node_get live .job_id)
expect_no_match "the stopped node has a new job" "^$live_job$" "$new_job"
expect_match "the stopped node is running again" '^running$' "$(node_get live .status)"
expect_no_match "run status no longer shows stopped" '^stopped: true$' "$(orch run status stop-1 2>&1)"

# usage errors
out=$(orch run stop 2>&1); rc=$?
expect_exit "run stop without a run id exits 2" 2 "$rc"
out=$(orch run stop no-such-run 2>&1); rc=$?
expect_exit "run stop on an unknown run exits 2" 2 "$rc"

orch run stop stop-1 >/dev/null 2>&1
cleanup_dir "$shims"
cleanup_dir "$home"

finish
