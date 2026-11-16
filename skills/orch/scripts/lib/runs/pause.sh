# shellcheck shell=bash
# Run pause and resume. Sourced by dispatch.sh; defines functions only.
#
# `run pause <run>` sets `.paused = true` in state.json (through state_write, so under the run
# lock). While a run is paused, `run sync` and `node dispatch` start nothing and print "run paused"
# (the guard sits in dispatch.sh main, so resume's own dispatches are not blocked).
# `run resume <run>` clears the flag, then re-dispatches each `running` node whose job process is
# gone (for example after a PC restart), with ORCH_RESUME_SESSION set to the node's recorded
# session. A node whose job is still alive is left alone. The flag is on disk, so it survives a
# restart. Pause also sets `.auto_resume = true`: the dashboard server runs `run resume` for each
# such run when it boots, so a paused run resumes by itself after a PC restart. Resume clears both.
#
# `run stop <run>` kills the live job of every `running` node (SIGTERM to the job's process group,
# then a check, SIGKILL after RUN_STOP_GRACE seconds), marks those nodes `stopped` (not error) and
# sets `.stopped = true` (and `.auto_resume = false`). A stopped run never resumes at boot, and
# `run sync` / `node dispatch` start nothing for it. Only `run resume <run> --stopped` (the user path:
# the run page Resume button) resumes it; it re-dispatches the stopped nodes with their sessions.

RUN_PAUSE_USAGE="dispatch.sh run pause <run-id>"
RUN_RESUME_USAGE="dispatch.sh run resume <run-id> [--stopped]"
RUN_STOP_GRACE="${RUN_STOP_GRACE:-5}"

# run_is_paused <run-id>: exit 0 when the run's state.json has `.paused == true`.
run_is_paused() {
  local file
  file=$(run_state_file "$1" 2>/dev/null) || return 1
  [ -f "$file" ] || return 1
  [ "$(jq -r '.paused // false' "$file" 2>/dev/null)" = true ]
}

# run_is_stopped <run-id>: exit 0 when the run's state.json has `.stopped == true`.
run_is_stopped() {
  local file
  file=$(run_state_file "$1" 2>/dev/null) || return 1
  [ -f "$file" ] || return 1
  [ "$(jq -r '.stopped // false' "$file" 2>/dev/null)" = true ]
}

# pause_guard <run-id>: prints "run stopped" or "run paused" and returns 3 when the run is either.
pause_guard() {
  [ -n "${1:-}" ] || return 0
  if run_is_stopped "$1"; then
    printf 'run stopped: %s (dispatch.sh run resume %s --stopped)\n' "$1" "$1"
    return 3
  fi
  if run_is_paused "$1"; then
    printf 'run paused: %s (dispatch.sh run resume %s)\n' "$1" "$1"
    return 3
  fi
  return 0
}

cmd_run_pause() {
  local run_id="${1:-}"
  [ -n "$run_id" ] && [ $# -eq 1 ] || { printf 'usage: %s\n' "$RUN_PAUSE_USAGE" >&2; return 2; }
  require_jq "run pause"
  run_require "$run_id" >/dev/null || return $?
  state_write "$run_id" '.paused = true | .auto_resume = true | .paused_at = $ts' --arg ts "$(now_iso)" || return 1
  run_event "$run_id" note "" "" "" "run paused" 2>/dev/null || true
  printf 'paused: %s\n' "$run_id"
}

RUN_SET_USAGE="dispatch.sh run set <run-id> auto_dispatch true|false"

# run set <run> <key> <value>: sets one run-level flag. Only auto_dispatch exists: when true, the
# dashboard server starts each ready node of the run itself (src/server/runs/auto-dispatch.ts).
# A run without the key counts as false, so nothing starts by surprise.
cmd_run_set() {
  local run_id="${1:-}" key="${2:-}" value="${3:-}"
  [ -n "$run_id" ] && [ -n "$key" ] || { printf 'usage: %s\n  or: %s\n' "$RUN_SET_USAGE" "$COORD_USAGE" >&2; return 2; }
  if [ "$key" = coordinator ] && [ $# -eq 2 ]; then
    require_jq "run set"
    run_require "$run_id" >/dev/null || return $?
    coordinator_record "$run_id"
    return $?
  fi
  [ $# -eq 3 ] && [ "$key" = auto_dispatch ] || { printf 'run set: unknown key %s\n  usage: %s\n' "$key" "$RUN_SET_USAGE" >&2; return 2; }
  case "$value" in true|false) ;; *) printf 'run set: auto_dispatch must be true or false\n' >&2; return 2 ;; esac
  require_jq "run set"
  run_require "$run_id" >/dev/null || return $?
  state_write "$run_id" '.auto_dispatch = $v' --argjson v "$value" || return 1
  run_event "$run_id" note "" "" "" "auto_dispatch $value" 2>/dev/null || true
  printf 'auto_dispatch: %s %s\n' "$run_id" "$value"
}

# pause_job_alive <job-id>: exit 0 when the job's recorded pid is a live process.
pause_job_alive() {
  local job_id="$1" pid
  [ -n "$job_id" ] || return 1
  pid=$(tr -d ' \n' < "$JOBS_HOME/$job_id/pid" 2>/dev/null || printf '')
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# pause_redispatch <run-id> <node-id>: puts a dead `running` node back to waiting and dispatches it
# again with its recorded profile/adapter, prompt and pass-through args, resuming its session.
pause_redispatch() {
  local run_id="$1" node_id="$2" file prompt profile adapter session job_id arg
  local -a target extra
  file=$(run_state_file "$run_id")
  prompt=$(node_field "$file" "$node_id" prompt)
  profile=$(node_field "$file" "$node_id" profile)
  adapter=$(node_field "$file" "$node_id" adapter)
  session=$(node_field "$file" "$node_id" session)
  [ -n "$prompt" ] || { printf 'resume: %s has no recorded prompt, left as running\n' "$node_id" >&2; return 1; }
  target=()
  while IFS= read -r arg; do [ -n "$arg" ] && target+=("$arg"); done <<EOF
$(node_retry_target_args "" "$profile" "$adapter")
EOF
  [ "${#target[@]}" -gt 0 ] || { printf 'resume: %s has no profile or adapter, left as running\n' "$node_id" >&2; return 1; }
  extra=()
  while IFS= read -r arg; do [ -n "$arg" ] && extra+=("$arg"); done <<EOF
$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | (.dispatch_args // [])[]' "$file")
EOF
  node_patch "$run_id" "$node_id" '.status = "waiting"' || return 1
  if [ "${#extra[@]}" -eq 0 ]; then
    job_id=$(ORCH_RESUME_SESSION="$session" cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$prompt") || return $?
  else
    job_id=$(ORCH_RESUME_SESSION="$session" cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$prompt" "${extra[@]}") || return $?
  fi
  printf 'redispatched: %s %s\n' "$node_id" "$job_id"
}

# stop_kill_job <job-id>: SIGTERMs a live job's process group, checks it for up to RUN_STOP_GRACE
# seconds, then SIGKILLs it. Prints `killed` when the job was alive, nothing when it was gone.
stop_kill_job() {
  local job_id="$1" pid i=0
  pid=$(tr -d ' \n' < "$JOBS_HOME/$job_id/pid" 2>/dev/null || printf '')
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt $((RUN_STOP_GRACE * 10)) ]; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  herdr_close_job_tab "$JOBS_HOME/$job_id"
  printf 'killed\n'
}

cmd_run_stop() {
  local run_id="${1:-}" file node job killed=0
  [ -n "$run_id" ] && [ $# -eq 1 ] || { printf 'usage: %s\n' "$RUN_STOP_USAGE" >&2; return 2; }
  require_jq "run stop"
  file=$(run_require "$run_id") || return $?
  # Set the flag first, so a sync that races the kills starts nothing new.
  state_write "$run_id" '.stopped = true | .auto_resume = false | .stopped_at = $ts' --arg ts "$(now_iso)" || return 1
  while IFS=$'\t' read -r node job; do
    [ -n "$node" ] && [ -n "$job" ] || continue
    [ -z "$(stop_kill_job "$job")" ] || killed=$((killed + 1))
  done <<EOF
$(jq -r '.nodes[] | select(.status == "running") | "\(.id)\t\(.job_id // "")"' "$file")
EOF
  state_write "$run_id" "$TIMING_JQ_DEFS"'.nodes |= map(if .status == "running" then seg_close($ts) | .finished_at = $ts | .status = "stopped" | .stopped_at = $ts | .next_retry_at = null else . end)' \
    --arg ts "$(now_iso)" || return 1
  run_event "$run_id" note "" "" "" "run stopped" 2>/dev/null || true
  printf 'stopped: %s (killed %s job(s))\n' "$run_id" "$killed"
}

cmd_run_resume() {
  local run_id="${1:-}" file node job rc=0 force=0
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_RESUME_USAGE" >&2; return 2; }
  shift
  case "$#:${1:-}" in
    0:) ;;
    1:--stopped) force=1 ;;
    *) printf 'usage: %s\n' "$RUN_RESUME_USAGE" >&2; return 2 ;;
  esac
  require_jq "run resume"
  file=$(run_require "$run_id") || return $?
  if run_is_stopped "$run_id" && [ "$force" = 0 ]; then
    printf 'run resume: %s was stopped by a user; resume it with --stopped (the run page Resume button)\n' "$run_id" >&2
    return 3
  fi
  # The paused or stopped stretch is recorded in .pauses so durations leave it out.
  state_write "$run_id" '((.paused_at // .stopped_at) as $from
     | if $from != null and $from < $ts then .pauses = ((.pauses // []) + [{from: $from, to: $ts}]) else . end)
     | .paused = false | .auto_resume = false | .paused_at = null | .stopped = false | .stopped_at = null' \
    --arg ts "$(now_iso)" || return 1
  run_event "$run_id" note "" "" "" "run resumed" 2>/dev/null || true
  printf 'resumed: %s\n' "$run_id"
  while IFS=$'\t' read -r node job; do
    [ -n "$node" ] || continue
    if pause_job_alive "$job"; then
      printf 'alive: %s %s\n' "$node" "$job"
      continue
    fi
    pause_redispatch "$run_id" "$node" || rc=1
  done <<EOF
$(jq -r '.nodes[] | select(.status == "running" or .status == "stopped") | "\(.id)\t\(.job_id // "")"' "$file")
EOF
  return $rc
}

NODE_CANCEL_USAGE="dispatch.sh node cancel <run-id> <node-id>"

# cmd_node_cancel <run-id> <node-id>: kills the live job of one running node and marks only that node
# `stopped`. Other nodes and the run flags are not touched. The node resumes only through
# `node retry` (the run page Restart button) or `run resume`.
cmd_node_cancel() {
  local run_id="${1:-}" node_id="${2:-}" file job status killed
  [ -n "$run_id" ] && [ -n "$node_id" ] && [ $# -eq 2 ] || { printf 'usage: %s\n' "$NODE_CANCEL_USAGE" >&2; return 2; }
  require_jq "node cancel"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  status=$(node_field "$file" "$node_id" status)
  [ "$status" = running ] || { printf 'node cancel: %s is %s, not running\n' "$node_id" "$status" >&2; return 3; }
  job=$(node_field "$file" "$node_id" job_id)
  killed=$(stop_kill_job "$job")
  node_set_status "$run_id" "$node_id" stopped || return 1
  if [ -n "$killed" ]; then printf 'cancelled: %s (job killed)\n' "$node_id"; else printf 'cancelled: %s (no live job)\n' "$node_id"; fi
}
