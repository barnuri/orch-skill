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

NODE_STARTED_USAGE="node started <run-id> <node-id> [--at ISO] [--source S]"
RUN_BACKFILL_TIMING_USAGE="run backfill-timing [<run-id>]"

# node_mark_started <run> <node> <at> <source> - idempotent: stamps started_at only on a running node
# with an open segment and no start yet. Clamps to dispatched_at. Prints nothing; returns 0 always
# unless the write fails.
node_mark_started() {
  local run_id="$1" node_id="$2" at="${3:-}" source="${4:-activity}" file hit
  [ -n "$at" ] || at=$(now_iso)
  file=$(run_state_file "$run_id")
  [ -f "$file" ] || return 0
  hit=$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n)
    | if .status == "running" and (.seg_open // false) and .started_at == null then "y" else "n" end' "$file" 2>/dev/null)
  [ "$hit" = y ] || return 0
  node_patch "$run_id" "$node_id" \
    'if .status == "running" and (.seg_open // false) and .started_at == null
     then .started_at = (if .dispatched_at != null and $at < .dispatched_at then .dispatched_at else $at end)
     else . end' \
    --arg at "$at" || return 1
  run_event "$run_id" started "$node_id" "starting" "running" "$source" || true
}

cmd_node_started() {
  local run_id="${1:-}" node_id="${2:-}" at="" source="cli" file
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_STARTED_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --at) at="${2:-}"; shift 2 ;;
      --source) source="${2:-}"; shift 2 ;;
      *) printf 'usage: %s\n' "$NODE_STARTED_USAGE" >&2; return 2 ;;
    esac
  done
  require_jq "node started"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  node_mark_started "$run_id" "$node_id" "$at" "$source"
}

# timing_job_log_start <job-id> - ISO time of the job log's first write, best effort: the log's
# birth time when it has content, else nothing.
timing_job_log_start() {
  local job="$1" log epoch
  [ -n "$job" ] || return 0
  log="$JOBS_HOME/$job/log"
  [ -s "$log" ] || return 0
  epoch=$(stat -f %B "$log" 2>/dev/null) || epoch=$(stat -c %W "$log" 2>/dev/null) || return 0
  { [ -n "$epoch" ] && [ "$epoch" -gt 0 ] 2>/dev/null; } || return 0
  epoch_to_iso "$epoch"
}

# timing_log_mtime <job-id> - ISO time of the job log's last write (the first growth `run sync` sees).
timing_log_mtime() {
  local epoch
  epoch=$(stat -f %m "$JOBS_HOME/$1/log" 2>/dev/null) || epoch=$(stat -c %Y "$JOBS_HOME/$1/log" 2>/dev/null) || return 0
  epoch_to_iso "$epoch"
}

# run backfill-timing [<run>] - fills dispatched_at/started_at/finished_at/run_segments on nodes
# written before these fields existed. Legacy `started` is the dispatch time; started_at comes from
# the dispatch itself for an inline node (no job), else the earliest of the session's created time, the first owner event, or the job log; else null.
cmd_run_backfill_timing() {
  local run_id="${1:-}" file ids id job log_start ev_file n=0
  require_jq "run backfill-timing"
  if [ -z "$run_id" ]; then
    for file in "$RUNS_HOME"/*/state.json; do
      [ -f "$file" ] || continue
      cmd_run_backfill_timing "$(basename "$(dirname "$file")")" || true
    done
    return 0
  fi
  file=$(run_require "$run_id") || return $?
  ev_file=$(run_events_file "$run_id")
  [ -s "$ev_file" ] || ev_file=/dev/null
  ids=$(jq -r '.nodes[] | select(.dispatched_at == null and .run_segments == null and .started != null) | .id' "$file")
  for id in $ids; do
    job=$(node_field "$file" "$id" job_id)
    log_start=$(timing_job_log_start "$job")
    node_patch "$run_id" "$id" '
      .dispatched_at = .started
      | .started as $d
      | ([ (if .job_id == null then $d else null end),
         (if (.session_stats.created // "") >= $d then .session_stats.created else null end),
           ($ev | map(select(.node == $n and .kind == "owner" and ((.to // "") | IN("started", "alive", "idle", "finished"))
                         and (.at // "") >= $d)) | first | .at // null),
           (if $log == "" then null else $log end) ]
         | map(select(. != null and (type == "string"))) | sort | first) as $s
      | .started_at = (if $s == null then null elif $s < .dispatched_at then .dispatched_at else $s end)
      | if .status == "running" then .seg_open = true | .finished_at = null
        elif .finished != null then
          .finished_at = .finished | .seg_open = false
          | .run_segments = [{dispatched: .dispatched_at, start: .started_at, end: .finished}]
        else .seg_open = false | .run_segments = [] end' \
      --arg log "$log_start" --slurpfile ev "$ev_file" || return 1
    n=$((n + 1))
  done
  printf 'backfill-timing: %s %s node(s)\n' "$run_id" "$n"
}
