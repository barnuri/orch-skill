# shellcheck shell=bash
# Node timing: dispatched_at / started_at / finished_at, the open run segment and run_segments.
# A node is "starting" while status == running, seg_open == true and started_at == null: dispatched,
# but no real activity yet. started_at is stamped once, at the first real activity (owner event,
# node ping, job-log growth, session activity). Sourced by dispatch.sh, never executed.

# seg_close($at): closes the open segment into run_segments. Prepended to jq programs that need it.
# A segment that never started and ends at its own dispatch time (two dispatches racing) is dropped.
TIMING_JQ_DEFS='def seg_close($at):
  if (.seg_open // false) then
    (if .started_at == null and (.dispatched_at // $at) >= $at then .
     else .run_segments = ((.run_segments // []) + [{dispatched: .dispatched_at, start: .started_at, end: $at}]) end)
    | .seg_open = false
  else . end;'

# Temporary shim for the bash libs that are not ported yet (runs.sh, visibility.sh, pause.sh).
# `node started`, `run backfill-timing` and the rest of this file now live in core/commands/timing.ts.
# Delete this file when runs.sh, visibility.sh and pause.sh are ported.
node_mark_started() {
  local run_id="$1" node_id="$2" at="${3:-}" source="${4:-activity}"
  "${ORCH_BUN:-bun}" "$SCRIPT_DIR/../bin/orch" node started "$run_id" "$node_id" ${at:+--at "$at"} --source "$source" >/dev/null 2>&1
}

# timing_log_mtime <job-id> - ISO time of the job log's last write (the first growth `run sync` sees).
timing_log_mtime() {
  local epoch
  epoch=$(stat -f %m "$JOBS_HOME/$1/log" 2>/dev/null) || epoch=$(stat -c %Y "$JOBS_HOME/$1/log" 2>/dev/null) || return 0
  epoch_to_iso "$epoch"
}
