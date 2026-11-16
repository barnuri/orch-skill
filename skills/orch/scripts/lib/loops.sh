#!/usr/bin/env bash
# Loops (`loop`), monitors (`watch`) and the `active` summary — sourced by dispatch.sh, never executed.
# Each loop and watch is a detached process with its own state dir under <home>/loops and
# <home>/watches. Every state write goes through loop_patch / watch_patch below, never a raw
# redirect, so a reader never sees a half-written file.

LOOPS_HOME="$ORCH_HOME/loops"
WATCHES_HOME="$ORCH_HOME/watches"
LOOP_MAX_FAILURES=5
LOOP_BACKOFF_CAP_SECS=3600
LOOP_RUN_NODES_KEEP=50
IDLE_POLL_SECS=5
LOOP_UNTIL_TIMEOUT_SECS=30
WATCH_MAX_LINES_DEFAULT=20
WATCH_MAX_ACTIVE=10
WATCH_ON_MATCH_GAP_SECS=60
WATCH_CMD_TIMEOUT_SECS=300
WATCH_WAIT_POLL_SECS=2
MAX_RUNTIME_DEFAULT_SECS=86400
WATCH_MAX_BYTES=10485760
WATCH_EVENT_MAX_CHARS=2000
WATCH_EVENTS_KEEP=500
WATCH_READ_TICK_SECS=5
WATCH_START_GRACE_SECS=30
LOOP_USAGE='dispatch.sh loop start --every <dur> [--max N] [--until CMD] [--max-runtime <dur>] [--session fresh|resume|<id>] [--when-idle|--no-when-idle] (--profile P | <adapter>) <prompt|@file> [args...] | list | stop <id> | resume <id> | tail <id> [-n N]'
WATCH_USAGE='dispatch.sh watch start --name N "<cmd>" [--match RE] [--ignore RE] [--until RE] [--every DUR] [--max-runtime DUR] [--on-match PROMPT --profile P] | wait <id> [--timeout S] [--max-lines N] | events <id> [--since N] | list | stop <id>'
ACTIVE_USAGE='dispatch.sh active [--json]'

# parse_duration <10s|5m|2h|1d|N> -> seconds
parse_duration() {
  local spec="$1" num unit
  case "$spec" in
    *s) num="${spec%s}"; unit=1 ;;
    *m) num="${spec%m}"; unit=60 ;;
    *h) num="${spec%h}"; unit=3600 ;;
    *d) num="${spec%d}"; unit=86400 ;;
    *) num="$spec"; unit=1 ;;
  esac
  is_uint "$num" || return 1
  printf '%s\n' $((num * unit))
}

epoch_clock() { date -r "$1" +%H:%M 2>/dev/null || date -d "@$1" +%H:%M; }

# Runs a command with a time limit when perl is present (macOS has no timeout binary).
run_limited() {
  local secs="$1"; shift
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$secs" "$@"
  else
    "$@"
  fi
}

# loop_patch <id> <jq-filter> [jq args]: atomic rewrite of a loop's state.json.
loop_patch() {
  local id="$1" filter="$2" file tmp
  shift 2
  file="$LOOPS_HOME/$id/state.json"
  tmp="$file.tmp.$$"
  jq "$@" "$filter" "$file" > "$tmp" && mv -f "$tmp" "$file"
}

watch_patch() {
  local id="$1" filter="$2" file tmp
  shift 2
  file="$WATCHES_HOME/$id/state.json"
  tmp="$file.tmp.$$"
  jq "$@" "$filter" "$file" > "$tmp" && mv -f "$tmp" "$file"
}

# spawn_detached <dir> <fn> [args…]: runs <fn> from this file in a new session, log in <dir>/log.
# Prints the pid. The child re-sources dispatch.sh by its real path, as `start` jobs do.
spawn_detached() {
  local dir="$1" fn="$2" pid
  shift 2
  run_detached bash -c 'self="$1"; shift; . "$self"; "$@"' _ "$SELF_REAL" "$fn" "$@" \
    >"$dir/log" 2>&1 </dev/null &
  pid=$!
  disown "$pid" 2>/dev/null || true
  printf '%s\n' "$pid"
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# stop_group <pid>: SIGTERM to the process group (the child leads it after setsid).
stop_group() {
  local pid="$1"
  pid_alive "$pid" || return 1
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
}

# ---- loops -------------------------------------------------------------------

# opencode_session_state <session-id>: idle | busy | unknown, from the newest message of the
# session. A finished assistant message has time.completed; one still streaming does not, and a
# newest user message means a turn is about to start. No message at all is idle.
opencode_session_state() {
  local bin out
  bin=$(harness_find_binary opencode 2>/dev/null) || { printf 'unknown\n'; return 0; }
  out=$("$bin" api GET "/api/session/$1/message" --param limit=1 --param order=desc 2>/dev/null) \
    || { printf 'unknown\n'; return 0; }
  printf '%s' "$out" | jq -r '
    if (.data | type) != "array" then "unknown"
    elif (.data | length) == 0 then "idle"
    elif (.data[0].type == "assistant" and (.data[0].time.completed != null)) then "idle"
    else "busy" end' 2>/dev/null || printf 'unknown\n'
}

# Every loop is also an orch run with the loop's id, and every tick a node of it, so the run list,
# the run graph and `msg` show loops like any other work. All writes go through the run
# subcommands; a failure here never stops the loop.
loop_run_open() {
  local id="$1" label="$2"
  cmd_run_start "↻ loop · $label" --id "$id" >/dev/null 2>&1 || true
}

loop_run_tick_start() {
  local id="$1" iter="$2"
  cmd_node_add "$id" "i$iter" "Tick $iter" >/dev/null 2>&1 || return 0
  cmd_node_update "$id" "i$iter" running >/dev/null 2>&1 || true
  # Older ticks fall off, so a loop that runs for a day does not grow state.json without limit.
  state_write "$id" '.nodes |= (if length > $keep then .[length - $keep:] else . end)' --argjson keep "$LOOP_RUN_NODES_KEEP" >/dev/null 2>&1 || true
}

# loop_run_tick_end <id> <iter> <rc> <log>: the tick's output goes to the node's handoff dir.
loop_run_tick_end() {
  local id="$1" iter="$2" rc="$3" log="$4" out
  out=$(node_out_dir "$id" "i$iter")
  mkdir -p "$out" 2>/dev/null && cp "$log" "$out/output.txt" 2>/dev/null || true
  if [ "$rc" -eq 0 ]; then
    cmd_node_update "$id" "i$iter" done >/dev/null 2>&1 || true
  else
    cmd_node_update "$id" "i$iter" error --error "exit=$rc" >/dev/null 2>&1 || true
  fi
}

# loop_run_close <id> <status>: done | error | cancelled. cancelled goes through run_cancel.
loop_run_close() {
  local id="$1" status="$2"
  [ -f "$(run_state_file "$id")" ] || return 0
  if [ "$status" = cancelled ]; then
    run_cancel "$id" >/dev/null 2>&1 || true
  else
    cmd_run_finish "$id" --status "$status" >/dev/null 2>&1 || true
  fi
}

# loop start: one target per tick, fixed-rate schedule anchored at start, overrun skips missed ticks.
cmd_loop_start() {
  local every="" max=0 until_cmd="" interval id dir pid now max_runtime="" runtime session_mode=fresh session_id="" harness when_idle=""
  local -a target_args=()
  require_jq "loop start"
  while [ $# -gt 0 ]; do
    case "$1" in
      --every) shift; every="${1:-}" ;;
      --max) shift; max="${1:-}" ;;
      --until) shift; until_cmd="${1:-}" ;;
      --max-runtime) shift; max_runtime="${1:-}" ;;
      --session) shift; session_mode="${1:-}" ;;
      --when-idle) when_idle=true ;;
      --no-when-idle) when_idle=false ;;
      --profile) break ;;
      *) if in_list "$1" "$ADAPTER_NAMES"; then break; fi
         printf 'loop start: unknown argument %s\n  usage: %s\n' "$1" "$LOOP_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  [ -n "$every" ] || { printf 'loop start: --every is required\n  usage: %s\n' "$LOOP_USAGE" >&2; return 2; }
  interval=$(parse_duration "$every") && [ "$interval" -ge 10 ] \
    || { printf 'loop start: --every must be a duration of at least 10s (e.g. 10m)\n' >&2; return 2; }
  is_uint "$max" || { printf 'loop start: --max must be a whole number\n' >&2; return 2; }
  parse_target "loop start" "$@" || return $?
  shift "$TARGET_ARGC"
  target_args=("$@")
  runtime=$(parse_duration "${max_runtime:-24h}") \
    || { printf 'loop start: --max-runtime must be a duration (e.g. 6h)\n' >&2; return 2; }

  harness="$TARGET_NAME"
  [ "$TARGET_KIND" != profile ] || harness=$(profile_harness "$TARGET_NAME")
  case "$session_mode" in
    fresh) ;;
    resume)
      case "$harness" in
        claude|copilot) session_id=$(new_uuid) ;;
        *) printf 'loop start: --session resume needs a claude or copilot target (got %s); pass --session <id> to resume an existing session\n' "${harness:-unknown}" >&2; return 2 ;;
      esac
      ;;
    *)
      adapter_supports_resume "$harness" "$session_mode" \
        || { printf 'loop start: %s cannot resume a session by id\n' "${harness:-this target}" >&2; return 2; }
      session_id="$session_mode"
      session_mode=id
      ;;
  esac
  # Sending prompts into a session someone may be typing in: wait for it to be idle by default.
  if [ "$session_mode" = id ] && [ "$harness" = opencode ]; then
    [ -n "$when_idle" ] || when_idle=true
    printf 'loop start: warning: ticks send prompts into the existing opencode session %s%s\n' "$session_id" \
      "$([ "$when_idle" = true ] && printf ' (each waits for it to be idle, up to one interval)')" >&2
  fi
  [ -n "$when_idle" ] || when_idle=false
  if [ "$when_idle" = true ] && { [ "$session_mode" != id ] || [ "$harness" != opencode ]; }; then
    printf 'loop start: --when-idle needs --session <id> on an opencode target\n' >&2
    return 2
  fi

  ensure_home || return 1
  id="loop-$(date -u +%Y%m%d-%H%M%S)-$(printf '%04x' $((RANDOM % 65536)))"
  dir="$LOOPS_HOME/$id"
  mkdir -p "$dir" || return 1
  printf '%s' "$TARGET_PROMPT" > "$dir/prompt.txt"
  now=$(date +%s)
  jq -n --arg id "$id" --arg kind "$TARGET_KIND" --arg name "$TARGET_NAME" \
    --argjson interval "$interval" --argjson max "$max" --arg until "$until_cmd" \
    --argjson now "$now" --arg started "$(now_iso)" --argjson deadline "$((now + runtime))" \
    --arg session_mode "$session_mode" --arg session "$session_id" --argjson when_idle "$when_idle" \
    --argjson args "$(printf '%s\n' ${target_args[@]+"${target_args[@]}"} | jq -R -s 'split("\n")[:-1]')" \
    '{id: $id, kind: $kind, name: $name, interval: $interval, max: $max, until: $until,
      args: $args, t0: $now, started: $started, deadline: $deadline,
      session_mode: $session_mode, session: $session, when_idle: $when_idle}' > "$dir/spec.json"
  jq -n --arg id "$id" --argjson now "$now" '{id: $id, status: "running", iteration: 0, failures: 0, next_tick: $now,
    last_exit: null, last_ts: null, pid: null, ended: null, reason: null, in_flight: null, interrupted: null, skipped: 0}' > "$dir/state.json"
  loop_run_open "$id" "$(printf '%s' "$TARGET_PROMPT" | tr '\n' ' ' | cut -c1-50)"
  pid=$(spawn_detached "$dir" loop_run "$id") || return 1
  loop_patch "$id" '.pid = $pid' --argjson pid "$pid"
  printf '%s\n' "$id"
}

# The loop's own process. Runs in the background; never called by a user.
loop_run() {
  local id="$1" dir="$LOOPS_HOME/$1" kind name interval max until_cmd prompt t0 iter fails next_tick
  local now end rc status reason control line deadline session_mode session_id when_idle waited
  local -a args=()
  spec_read() { jq -r "$1" "$dir/spec.json"; }
  kind=$(spec_read .kind); name=$(spec_read .name); interval=$(spec_read .interval)
  max=$(spec_read .max); until_cmd=$(spec_read .until); t0=$(spec_read .t0)
  deadline=$(spec_read .deadline); session_mode=$(spec_read .session_mode); session_id=$(spec_read .session)
  when_idle=$(spec_read '.when_idle // false')
  while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done <<EOF
$(spec_read '.args[]?')
EOF
  control="$dir/control"
  : > "$control"
  export ORCH_LOOP_CONTROL="$control" ORCH_LOOP_ID="$id"
  iter=$(jq -r .iteration "$dir/state.json"); fails=$(jq -r .failures "$dir/state.json")
  next_tick=$(jq -r .next_tick "$dir/state.json")
  while :; do
    now=$(date +%s)
    if [ "$next_tick" -ge "$deadline" ] || [ "$now" -ge "$deadline" ]; then
      loop_patch "$id" '.status = "done" | .reason = "max-runtime" | .ended = $ts | .pid = null' --arg ts "$(now_iso)"
      loop_run_close "$id" done
      return 0
    fi
    if [ "$next_tick" -gt "$now" ]; then sleep $((next_tick - now)); fi
    [ "$(jq -r .status "$dir/state.json")" = "running" ] || return 0

    # A live session that is mid-turn: wait for it, up to one interval, then skip this tick.
    if [ "$when_idle" = true ]; then
      waited=0
      while [ "$(opencode_session_state "$session_id")" = busy ]; do
        if [ "$waited" -ge $((interval - 1)) ]; then break; fi
        sleep "$IDLE_POLL_SECS"
        waited=$((waited + IDLE_POLL_SECS))
      done
      if [ "$(opencode_session_state "$session_id")" = busy ]; then
        now=$(date +%s)
        next_tick=$((t0 + (((now - t0) / interval) + 1) * interval))
        loop_patch "$id" '.skipped += 1 | .next_tick = $nt' --argjson nt "$next_tick"
        continue
      fi
    fi

    unset ORCH_SESSION_ID ORCH_RESUME_SESSION
    case "$session_mode" in
      id) export ORCH_RESUME_SESSION="$session_id" ;;
      resume)
        if [ "$iter" -ge 1 ]; then export ORCH_RESUME_SESSION="$session_id"; else export ORCH_SESSION_ID="$session_id"; fi
        ;;
    esac
    iter=$((iter + 1))
    loop_patch "$id" '.in_flight = $i' --argjson i "$iter"
    loop_run_tick_start "$id" "$iter"
    prompt=$(cat "$dir/prompt.txt")
    prompt="$prompt

To end this loop, write STOP to the file at $control."
    target_dispatch "$kind" "$name" "$prompt" ${args[@]+"${args[@]}"} > "$dir/iter-$iter.log" 2>&1 </dev/null
    rc=$?
    end=$(date +%s)
    loop_run_tick_end "$id" "$iter" "$rc" "$dir/iter-$iter.log"
    if [ "$rc" -eq 0 ]; then fails=0; else fails=$((fails + 1)); fi

    if [ "$fails" -ge "$LOOP_MAX_FAILURES" ]; then
      loop_patch "$id" '.status = "failed" | .reason = "failures" | .in_flight = null | .iteration = $i | .last_exit = $rc | .last_ts = $ts | .ended = $ts | .pid = null' \
        --argjson i "$iter" --argjson rc "$rc" --arg ts "$(now_iso)"
      loop_run_close "$id" error
      return 1
    fi
    if [ "$fails" -gt 0 ]; then
      next_tick=$((end + interval * (1 << (fails > 10 ? 10 : fails))))
      [ $((next_tick - end)) -le "$LOOP_BACKOFF_CAP_SECS" ] || next_tick=$((end + LOOP_BACKOFF_CAP_SECS))
    else
      # Fixed rate: the next tick after `end`, so a long iteration skips the ticks it covered.
      next_tick=$((t0 + (((end - t0) / interval) + 1) * interval))
    fi

    status=running; reason=""
    if [ -n "$until_cmd" ] && run_limited "$LOOP_UNTIL_TIMEOUT_SECS" sh -c "$until_cmd" >/dev/null 2>&1; then
      status=done; reason=until
    fi
    if [ "$status" = running ] && [ "$(head -n 1 "$control" 2>/dev/null)" = "STOP" ]; then
      status=stopped; reason=agent
    fi
    if [ "$status" = running ] && [ "$max" -gt 0 ] && [ "$iter" -ge "$max" ]; then
      status=done; reason=max
    fi
    loop_patch "$id" '.iteration = $i | .failures = $f | .next_tick = $nt | .last_exit = $rc
      | .last_ts = $ts | .in_flight = null | .status = (if $s == "running" then .status else $s end)
      | .reason = (if $r == "" then .reason else $r end) | .ended = (if $s == "running" then null else $ts end)' \
      --argjson i "$iter" --argjson f "$fails" --argjson nt "$next_tick" --argjson rc "$rc" \
      --arg ts "$(now_iso)" --arg s "$status" --arg r "$reason"
    if [ "$status" != running ]; then
      case "$reason" in agent) loop_run_close "$id" cancelled ;; *) loop_run_close "$id" done ;; esac
      return 0
    fi
  done
}

loop_alive_status() {
  local id="$1" file="$LOOPS_HOME/$1/state.json" status pid
  status=$(jq -r .status "$file")
  pid=$(jq -r '.pid // empty' "$file")
  if [ "$status" = running ] && ! pid_alive "$pid" && [ "$(jq -r '.demo // false' "$file")" != true ]; then
    printf 'lost\n'
    return 0
  fi
  printf '%s\n' "$status"
}

cmd_loop_list() {
  local dir id status
  [ -d "$LOOPS_HOME" ] || { printf 'no loops\n'; return 0; }
  for dir in "$LOOPS_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    status=$(loop_alive_status "$id")
    jq -r --arg st "$status" --slurpfile p "$dir/spec.json" \
      '[.id, $st, "iter \(.iteration)", "every \($p[0].interval)s", (if $p[0].max > 0 then "max \($p[0].max)" else "no max" end), $p[0].name] | join("\t")' \
      "$dir/state.json"
  done | sort -r
}

cmd_loop_stop() {
  local id="${1:-}" pid
  [ -n "$id" ] || { printf 'usage: dispatch.sh loop stop <loop-id>\n' >&2; return 2; }
  [ -f "$LOOPS_HOME/$id/state.json" ] || { printf 'unknown loop: %s\n' "$id" >&2; return 2; }
  pid=$(jq -r '.pid // empty' "$LOOPS_HOME/$id/state.json")
  stop_group "$pid" >/dev/null 2>&1 || true
  loop_patch "$id" '.status = "stopped" | .reason = "stopped" | .ended = $ts | .pid = null' --arg ts "$(now_iso)"
  loop_run_close "$id" cancelled
  printf 'stopped: %s\n' "$id"
}

# Restarts a loop process that is not running. A call that was mid-flight when the process died is
# counted and marked interrupted.
loop_respawn() {
  local id="$1" dir="$LOOPS_HOME/$1" pid
  local cut
  cut=$(jq -r '.in_flight // empty' "$dir/state.json")
  [ -z "$cut" ] || cmd_node_update "$id" "i$cut" error --error interrupted >/dev/null 2>&1 || true
  node_reopen_run "$id" >/dev/null 2>&1 || true
  loop_patch "$id" '.status = "running" | .reason = null | .ended = null | .failures = 0 | .next_tick = $now
    | .interrupted = .in_flight | .iteration = (if .in_flight != null then .in_flight else .iteration end) | .in_flight = null' \
    --argjson now "$(date +%s)" || return 1
  pid=$(spawn_detached "$dir" loop_run "$id") || return 1
  loop_patch "$id" '.pid = $pid' --argjson pid "$pid"
}

cmd_loop_resume() {
  local id="${1:-}" status dir="$LOOPS_HOME/${1:-}"
  [ -n "$id" ] || { printf 'usage: dispatch.sh loop resume <loop-id>\n' >&2; return 2; }
  [ -f "$dir/state.json" ] || { printf 'unknown loop: %s\n' "$id" >&2; return 2; }
  status=$(loop_alive_status "$id")
  case "$status" in
    running) printf 'loop %s is already running\n' "$id" >&2; return 2 ;;
    done) printf 'loop %s is done (%s); start a new loop\n' "$id" "$(jq -r .reason "$dir/state.json")" >&2; return 2 ;;
  esac
  jq --argjson d "$(( $(date +%s) + MAX_RUNTIME_DEFAULT_SECS ))" '.deadline = $d' "$dir/spec.json" > "$dir/spec.json.tmp.$$" \
    && mv -f "$dir/spec.json.tmp.$$" "$dir/spec.json"
  loop_respawn "$id" || return 1
  printf 'resumed: %s\n' "$id"
}

# Called by `sync`: loops whose process vanished (reboot, kill) restart on the next tick. Ticks
# missed while down are skipped, not replayed. A watch whose process vanished is first reconciled
# to `dead` (watch_alive_status); a scheduled one that is still wanted then restarts (watch_respawn).
# A health:<run> monitor is left to `run health --ensure-monitors`, which owns its single-flight start.
loops_recover() {
  local dir id recovered=0
  for dir in "$LOOPS_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    [ "$(loop_alive_status "$id")" = lost ] || continue
    loop_respawn "$id" && recovered=$((recovered + 1))
  done
  for dir in "$WATCHES_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    watch_alive_status "$id" >/dev/null
    watch_restart_wanted "$id" || continue
    watch_respawn "$id" && recovered=$((recovered + 1))
  done
  [ "$recovered" -eq 0 ] || printf 'recovered %s loop(s)/watch(es)\n' "$recovered" >&2
}

# The runs a watch belongs to: health:<run> by name, and any run id in its command that exists.
watch_tied_runs() {
  local dir="$WATCHES_HOME/$1" name run
  name=$(jq -r '.name // empty' "$dir/spec.json" 2>/dev/null)
  case "$name" in health:?*) printf '%s\n' "${name#health:}" ;; esac
  jq -r '.cmd // empty' "$dir/spec.json" 2>/dev/null | grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{4}' | sort -u \
    | while IFS= read -r run; do [ -f "$(run_state_file "$run")" ] && printf '%s\n' "$run"; done
}

# watch_restart_wanted <id>: a scheduled watch that ended without anyone ending it on purpose —
# `dead` (SIGKILL, crash, host restart) or `stopped` by a signal (a shutdown TERMs every process).
# Never one a user stopped, one past its --max-runtime, a health monitor, or one whose run is over.
watch_restart_wanted() {
  local id="$1" dir="$WATCHES_HOME/$1" status reason run
  status=$(jq -r .status "$dir/state.json" 2>/dev/null)
  reason=$(jq -r '.reason // ""' "$dir/state.json" 2>/dev/null)
  case "$status:$reason" in dead:*|"stopped:signal "*) ;; *) return 1 ;; esac
  [ "$(jq -r '.interval // 0' "$dir/spec.json" 2>/dev/null)" -gt 0 ] || return 1
  [ "$(jq -r '.deadline // 0' "$dir/spec.json" 2>/dev/null)" -gt "$(date +%s)" ] || return 1
  case "$(jq -r '.name // ""' "$dir/spec.json" 2>/dev/null)" in health:*) return 1 ;; esac
  while IFS= read -r run; do
    [ -n "$run" ] || continue
    [ "$(jq -r .status "$(run_state_file "$run")" 2>/dev/null)" = running ] || return 1
  done <<EOF
$(watch_tied_runs "$id")
EOF
  return 0
}

# Restarts a watch's process, single-flight per watch, with a `restarted` event naming why it died.
watch_respawn() {
  local id="$1" dir="$WATCHES_HOME/$1" lock="watch-respawn-$1" why pid rc=1
  orch_lock_acquire "$lock" || return 1
  if watch_restart_wanted "$id"; then
    why=$(jq -r '"\(.status): \(.reason // "unknown")"' "$dir/state.json")
    # restart_epoch opens the start grace in watch_dead_reason until the new pid is recorded.
    # The event goes in before the spawn, so it never races the new process's own events.
    watch_patch "$id" '.status = "running" | .reason = null | .ended = null | .pid = null | .restart_epoch = $now' \
      --argjson now "$(date +%s)" \
      && watch_lifecycle_event "$id" "restarted (was $why)" \
      && pid=$(spawn_detached "$dir" watch_run "$id") \
      && watch_patch "$id" '.pid = $pid | .restarts = ((.restarts // 0) + 1)' --argjson pid "$pid" && rc=0
  fi
  orch_lock_release "$lock"
  return $rc
}

# Recoverably removes ended loops and watches older than the cutoff (epoch seconds).
loops_prune() {
  local cutoff="$1" dry="$2" dir ended epoch
  for dir in "$LOOPS_HOME"/*/ "$WATCHES_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    ended=$(jq -r '.ended // empty' "$dir/state.json")
    [ -n "$ended" ] || continue
    epoch=$(to_epoch_iso "$ended") || continue
    [ "$epoch" -lt "$cutoff" ] || continue
    prune_path "$dir" "$dry"
  done
}

cmd_loop_tail() {
  local id="${1:-}" n=20 iter dir
  [ -n "$id" ] || { printf 'usage: dispatch.sh loop tail <loop-id> [-n N]\n' >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) shift; n="${1:-20}" ;;
    esac
    shift
  done
  dir="$LOOPS_HOME/$id"
  [ -f "$dir/state.json" ] || { printf 'unknown loop: %s\n' "$id" >&2; return 2; }
  iter=$(jq -r .iteration "$dir/state.json")
  [ "$iter" -gt 0 ] || { printf 'loop %s has no iterations yet\n' "$id"; return 0; }
  printf '── iter %s ──\n' "$iter"
  tail -n "$n" "$dir/iter-$iter.log"
}

# ---- watches -----------------------------------------------------------------

# watch start: a long-running command (streamed) or one rerun on a schedule (--every). Each matching
# line, or each changed run, is an event in events.jsonl. The agent reads events, not the log.
cmd_watch_start() {
  local name="" cmd="" match="" ignore="" until_re="" every="" on_match="" profile="" id dir pid interval max_runtime="" runtime
  require_jq "watch start"
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) shift; name="${1:-}" ;;
      --match) shift; match="${1:-}" ;;
      --ignore) shift; ignore="${1:-}" ;;
      --until) shift; until_re="${1:-}" ;;
      --every) shift; every="${1:-}" ;;
      --on-match) shift; on_match="${1:-}" ;;
      --profile) shift; profile="${1:-}" ;;
      --max-runtime) shift; max_runtime="${1:-}" ;;
      *)
        if [ -z "$cmd" ]; then cmd="$1"; else printf 'watch start: unexpected argument %s\n  usage: %s\n' "$1" "$WATCH_USAGE" >&2; return 2; fi
        ;;
    esac
    shift
  done
  [ -n "$cmd" ] || { printf 'usage: %s\n' "$WATCH_USAGE" >&2; return 2; }
  [ -n "$name" ] || name="watch"
  if [ -n "$every" ]; then
    interval=$(parse_duration "$every") && [ "$interval" -ge 10 ] \
      || { printf 'watch start: --every must be a duration of at least 10s\n' >&2; return 2; }
  else
    interval=0
  fi
  runtime=$(parse_duration "${max_runtime:-24h}") \
    || { printf 'watch start: --max-runtime must be a duration (e.g. 6h)\n' >&2; return 2; }
  [ -z "$on_match" ] || [ -n "$profile" ] || { printf 'watch start: --on-match needs --profile\n' >&2; return 2; }
  [ "$(watch_active_count)" -lt "$WATCH_MAX_ACTIVE" ] \
    || { printf 'watch start: %s watches already active (limit %s)\n' "$(watch_active_count)" "$WATCH_MAX_ACTIVE" >&2; return 1; }

  ensure_home || return 1
  id="watch-$(date -u +%Y%m%d-%H%M%S)-$(printf '%04x' $((RANDOM % 65536)))"
  dir="$WATCHES_HOME/$id"
  mkdir -p "$dir" || return 1
  : > "$dir/events.jsonl"
  jq -n --arg id "$id" --arg name "$name" --arg cmd "$cmd" --arg match "$match" --arg ignore "$ignore" \
    --arg until "$until_re" --argjson interval "$interval" --arg on_match "$on_match" --arg profile "$profile" \
    --arg started "$(now_iso)" --argjson deadline "$(( $(date +%s) + runtime ))" \
    '{id: $id, name: $name, cmd: $cmd, match: $match, ignore: $ignore, until: $until, interval: $interval,
      on_match: $on_match, profile: $profile, started: $started, deadline: $deadline}' > "$dir/spec.json"
  jq -n --arg id "$id" '{id: $id, status: "running", events: 0, cursor: 0, last_event: null, last_dispatch_epoch: 0,
    pid: null, ended: null, reason: null}' > "$dir/state.json"
  pid=$(spawn_detached "$dir" watch_run "$id") || return 1
  watch_patch "$id" '.pid = $pid' --argjson pid "$pid"
  printf '%s\n' "$id"
}

watch_active_count() {
  local dir count=0
  for dir in "$WATCHES_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    [ "$(watch_alive_status "$(basename "$dir")")" = running ] && count=$((count + 1))
  done
  printf '%s\n' "$count"
}

# watch_pid_is <pid> <id>: the pid answers AND its command line names this watch (`watch_run <id>`),
# so a pid the OS handed to another process after the watch died does not count as the watch.
watch_pid_is() {
  local pid="$1" id="$2" cmd
  pid_alive "$pid" || return 1
  command -v ps >/dev/null 2>&1 || return 0
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  case "$cmd" in *"watch_run $id"*) return 0 ;; esac
  return 1
}

# watch_dead_reason <id>: empty while a running watch's process is alive; otherwise why it is not.
# A record without a pid is "starting" for WATCH_START_GRACE_SECS (watch start patches it in).
watch_dead_reason() {
  local id="$1" dir="$WATCHES_HOME/$1" pid started restarted
  pid=$(jq -r '.pid // empty' "$dir/state.json" 2>/dev/null)
  if [ -z "$pid" ]; then
    started=$(to_epoch_iso "$(jq -r '.started // empty' "$dir/spec.json" 2>/dev/null)" 2>/dev/null) || started=0
    restarted=$(jq -r '.restart_epoch // 0' "$dir/state.json" 2>/dev/null) || restarted=0
    [ "${restarted:-0}" -le "$started" ] || started=$restarted
    [ $(( $(date +%s) - started )) -lt "$WATCH_START_GRACE_SECS" ] && return 0
    printf 'no process recorded\n'
    return 0
  fi
  watch_pid_is "$pid" "$id" && return 0
  if pid_alive "$pid"; then
    printf 'pid %s now belongs to another process\n' "$pid"
  else
    printf 'process %s gone (killed or host restarted)\n' "$pid"
  fi
}

# watch_lifecycle_event <id> <text>: an event in the watch's own stream, without the --on-match dispatch.
watch_lifecycle_event() {
  local id="$1" text="$2" dir="$WATCHES_HOME/$1" n
  n=$(( $(jq -r '.events // 0' "$dir/state.json") + 1 ))
  jq -cn --argjson n "$n" --arg ts "$(now_iso)" --arg text "$text" '{n: $n, ts: $ts, text: $text, kind: "lifecycle"}' >> "$dir/events.jsonl"
  watch_patch "$id" '.events = $n' --argjson n "$n"
}

# Persists the end of a watch whose process is gone, so every reader (CLI, dashboard, health) agrees.
# A dead health:<run> monitor is also a health event on that run.
watch_mark_dead() {
  local id="$1" why="$2" name
  watch_end "$id" dead "$why"
  watch_lifecycle_event "$id" "dead: $why"
  name=$(jq -r '.name // empty' "$WATCHES_HOME/$id/spec.json" 2>/dev/null)
  case "$name" in health:?*) run_event "${name#health:}" health "" "" "" "monitor $id dead: $why" ;; esac
}

# The watch process's exit trap: a signal or an unexpected exit records `stopped` with the cause,
# unless the watch already recorded its own end.
watch_on_exit() {
  local id="$1" why="$2"
  [ "$(jq -r .status "$WATCHES_HOME/$id/state.json" 2>/dev/null)" = running ] || return 0
  watch_end "$id" stopped "$why"
  watch_lifecycle_event "$id" "stopped: $why"
}

# watch_on_signal <id> <SIG> <code>: records the end, stops the rest of the watch's process group
# (the body and its command), then exits.
watch_on_signal() {
  trap '' TERM INT HUP
  watch_on_exit "$1" "signal $2"
  # Only when the watch leads its own process group (run_detached's setsid), never the caller's.
  if [ "$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')" = "$$" ]; then kill -TERM -- "-$$" 2>/dev/null || true; fi
  exit "$3"
}

# Prints the watch's status. A `running` record whose process is gone (or whose pid now belongs to
# another process) is reconciled to `dead` with the reason and an event, and reads as dead.
watch_alive_status() {
  local id="$1" file="$WATCHES_HOME/$1/state.json" status why
  status=$(jq -r .status "$file")
  if [ "$status" = running ]; then
    why=$(watch_dead_reason "$id")
    if [ -n "$why" ]; then
      watch_mark_dead "$id" "$why"
      status=dead
    fi
  fi
  printf '%s\n' "$status"
}

# watch_emit <id> <text>: appends one event and dispatches --on-match when the gap has passed.
watch_emit() {
  local id="$1" text="$2" dir="$WATCHES_HOME/$1" n now last_dispatch prompt_file job
  now=$(date +%s)
  [ "${#text}" -le "$WATCH_EVENT_MAX_CHARS" ] || text="${text:0:$WATCH_EVENT_MAX_CHARS}…"
  n=$(( $(jq -r .events "$dir/state.json") + 1 ))
  jq -cn --argjson n "$n" --arg ts "$(now_iso)" --arg text "$text" '{n: $n, ts: $ts, text: $text}' >> "$dir/events.jsonl"
  watch_patch "$id" '.events = $n | .last_event = $ts' --argjson n "$n" --arg ts "$(now_iso)"
  if [ $((n % 50)) -eq 0 ] && [ "$(wc -l < "$dir/events.jsonl")" -gt "$WATCH_EVENTS_KEEP" ]; then
    tail -n "$WATCH_EVENTS_KEEP" "$dir/events.jsonl" > "$dir/events.jsonl.tmp.$$" && mv -f "$dir/events.jsonl.tmp.$$" "$dir/events.jsonl"
  fi
  local on_match profile
  on_match=$(jq -r .on_match "$dir/spec.json")
  profile=$(jq -r .profile "$dir/spec.json")
  [ -n "$on_match" ] || return 0
  last_dispatch=$(jq -r .last_dispatch_epoch "$dir/state.json")
  [ $((now - last_dispatch)) -ge "$WATCH_ON_MATCH_GAP_SECS" ] || return 0
  prompt_file="$dir/on-match-$n.md"
  printf '%s\n\nMatched output:\n%s\n' "$on_match" "$text" > "$prompt_file"
  job=$(cmd_start --profile "$profile" "@$prompt_file" 2>/dev/null) || return 0
  watch_patch "$id" '.last_dispatch_epoch = $now | .last_job = $job' --argjson now "$now" --arg job "$job"
}

# Keeps the watch's exit code and the reason it ended, so `wait` can tell "ended" from "still running".
watch_end() {
  watch_patch "$1" '.status = $s | .reason = $r | .ended = $ts | .pid = null' \
    --arg s "$2" --arg r "$3" --arg ts "$(now_iso)"
}

# Streams one command through a fifo: each line is filtered by --match/--ignore; --until ends the
# watch. The read wakes every few seconds so the runtime limit is enforced on a quiet stream, and
# the source command is stopped whichever way the watch ends.
watch_stream() {
  local id="$1" cmd="$2" match="$3" ignore="$4" until_re="$5" deadline="$6" line ended="" fifo src rc
  fifo="$WATCHES_HOME/$id/stream.fifo"
  mkfifo "$fifo" || return 1
  sh -c "$cmd" > "$fifo" 2>&1 </dev/null &
  src=$!
  exec 3< "$fifo"
  while :; do
    # Checked first on every pass: a stream of non-matching lines must not skip the runtime limit.
    if [ "$(date +%s)" -ge "$deadline" ]; then ended=max-runtime; break; fi
    if IFS= read -r -t "$WATCH_READ_TICK_SECS" line <&3; then
      if [ -n "$match" ] && ! [[ $line =~ $match ]]; then continue; fi
      if [ -n "$ignore" ] && [[ $line =~ $ignore ]]; then continue; fi
      watch_emit "$id" "$line"
      if [ -n "$until_re" ] && [[ $line =~ $until_re ]]; then ended=until; break; fi
    else
      rc=$?
      if [ "$rc" -le 128 ]; then break; fi
    fi
  done
  exec 3<&-
  pkill -P "$src" 2>/dev/null || true
  kill "$src" 2>/dev/null || true
  rm -f "$fifo"
  printf '%s' "$ended"
}

# Scheduled: reruns the command; an event fires when the filtered output changes (dedupe run).
watch_scheduled() {
  local id="$1" cmd="$2" match="$3" ignore="$4" until_re="$5" interval="$6" deadline="$7" out line last="" text hit
  local -a lines
  while :; do
    [ "$(jq -r .status "$WATCHES_HOME/$id/state.json")" = running ] || return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then printf max-runtime; return 0; fi
    out=$(run_limited "$WATCH_CMD_TIMEOUT_SECS" sh -c "$cmd" 2>&1 </dev/null | head -c "$WATCH_MAX_BYTES")
    text=""
    while IFS= read -r line; do
      if [ -n "$match" ] && ! [[ $line =~ $match ]]; then continue; fi
      if [ -n "$ignore" ] && [[ $line =~ $ignore ]]; then continue; fi
      text="$text$line
"
    done <<EOF
$out
EOF
    if [ -n "$text" ] && [ "$text" != "$last" ]; then
      watch_emit "$id" "${text%$'\n'}"
      last="$text"
      hit=""
      if [ -n "$until_re" ] && [[ $text =~ $until_re ]]; then hit=until; fi
      [ -z "$hit" ] || { printf '%s' "$hit"; return 0; }
    fi
    sleep "$interval"
  done
}

watch_run() {
  local id="$1" dir="$WATCHES_HOME/$1" cmd match ignore until_re interval ended deadline
  cmd=$(jq -r .cmd "$dir/spec.json")
  match=$(jq -r .match "$dir/spec.json")
  ignore=$(jq -r .ignore "$dir/spec.json")
  until_re=$(jq -r .until "$dir/spec.json")
  interval=$(jq -r .interval "$dir/spec.json")
  deadline=$(jq -r .deadline "$dir/spec.json")
  # A signal or an unexpected exit still records an end; only SIGKILL or a host restart skips this,
  # and watch_alive_status reconciles those. The body runs as a background child so `wait` lets a
  # trap fire at once (a command substitution would defer it until the body ended).
  trap "watch_on_signal '$id' TERM 143" TERM
  trap "watch_on_signal '$id' INT 130" INT
  trap "watch_on_signal '$id' HUP 129" HUP
  trap "watch_on_exit '$id' 'exited without recording an end'" EXIT
  : > "$dir/ended"
  if [ "$interval" -gt 0 ]; then
    watch_scheduled "$id" "$cmd" "$match" "$ignore" "$until_re" "$interval" "$deadline" > "$dir/ended" &
  else
    watch_stream "$id" "$cmd" "$match" "$ignore" "$until_re" "$deadline" > "$dir/ended" &
  fi
  wait "$!"
  ended=$(cat "$dir/ended" 2>/dev/null)
  if [ -n "$ended" ]; then
    watch_end "$id" done "$ended"
  else
    watch_end "$id" done "source ended"
  fi
}

cmd_watch_stop() {
  local id="${1:-}" pid own
  [ -n "$id" ] || { printf 'usage: dispatch.sh watch stop <watch-id>\n' >&2; return 2; }
  [ -f "$WATCHES_HOME/$id/state.json" ] || { printf 'unknown watch: %s\n' "$id" >&2; return 2; }
  pid=$(jq -r '.pid // empty' "$WATCHES_HOME/$id/state.json")
  # The end is recorded first, so the watch's own signal trap sees it ended and keeps this reason.
  # Only signal the group when the pid is still this watch: a reused pid belongs to someone else.
  own=0
  watch_pid_is "$pid" "$id" && own=1
  watch_end "$id" stopped stopped
  [ "$own" -eq 0 ] || stop_group "$pid" >/dev/null 2>&1 || true
  printf 'stopped: %s\n' "$id"
}

# watch wait: blocks until a new event (exit 0), the watch ends with no new event (exit 3), or the
# timeout (exit 124). Prints the new events, capped at --max-lines, and the total count.
cmd_watch_wait() {
  local id="${1:-}" timeout=300 max_lines=$WATCH_MAX_LINES_DEFAULT since="" elapsed=0 dir status count
  [ -n "$id" ] || { printf 'usage: dispatch.sh watch wait <watch-id> [--timeout S] [--max-lines N] [--since N]\n' >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) shift; timeout="${1:-300}" ;;
      --max-lines) shift; max_lines="${1:-$WATCH_MAX_LINES_DEFAULT}" ;;
      --since) shift; since="${1:-}" ;;
    esac
    shift
  done
  dir="$WATCHES_HOME/$id"
  [ -f "$dir/state.json" ] || { printf 'unknown watch: %s\n' "$id" >&2; return 2; }
  [ -n "$since" ] || since=$(jq -r .cursor "$dir/state.json")
  while :; do
    count=$(jq -r .events "$dir/state.json")
    if [ "$count" -gt "$since" ]; then
      watch_print_events "$id" "$since" "$max_lines"
      total=$(jq -r .events "$dir/state.json")
      watch_patch "$id" '.cursor = $c' --argjson c "$(( since + max_lines < total ? since + max_lines : total ))"
      return 0
    fi
    status=$(watch_alive_status "$id")
    if [ "$status" != running ]; then
      printf 'watch %s ended (%s) with no new events\n' "$id" "$status"
      return 3
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      printf 'wait: timed out after %ss (no new events)\n' "$timeout" >&2
      return 124
    fi
    sleep "$WATCH_WAIT_POLL_SECS"
    elapsed=$((elapsed + WATCH_WAIT_POLL_SECS))
  done
}

watch_print_events() {
  local id="$1" since="$2" max_lines="$3" total
  total=$(jq -r .events "$WATCHES_HOME/$id/state.json")
  printf 'watch %s: %s new event(s), %s total\n' "$id" "$((total - since))" "$total"
  jq -r --argjson s "$since" 'select(.n > $s) | "\(.n)\t\(.ts)\t\(.text | gsub("\n"; " | "))"' "$WATCHES_HOME/$id/events.jsonl" \
    | head -n "$max_lines"
}

cmd_watch_events() {
  local id="${1:-}" since=0 limit=50
  [ -n "$id" ] || { printf 'usage: dispatch.sh watch events <watch-id> [--since N] [--limit N]\n' >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --since) shift; since="${1:-0}" ;;
      --limit) shift; limit="${1:-50}" ;;
    esac
    shift
  done
  [ -f "$WATCHES_HOME/$id/events.jsonl" ] || { printf 'unknown watch: %s\n' "$id" >&2; return 2; }
  jq -r --argjson s "$since" 'select(.n > $s) | "\(.n)\t\(.ts)\t\(.text | gsub("\n"; " | "))"' "$WATCHES_HOME/$id/events.jsonl" | tail -n "$limit"
}

cmd_watch_list() {
  local dir id status
  [ -d "$WATCHES_HOME" ] || { printf 'no watches\n'; return 0; }
  for dir in "$WATCHES_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    status=$(watch_alive_status "$id")
    jq -r --arg st "$status" --slurpfile p "$dir/spec.json" \
      '[.id, $st, "\(.events) events", $p[0].name] | join("\t")' "$dir/state.json"
  done | sort -r
}

cmd_loop() {
  case "${1:-}" in
    start) shift; cmd_loop_start "$@" ;;
    list) cmd_loop_list ;;
    stop) shift; cmd_loop_stop "$@" ;;
    resume) shift; cmd_loop_resume "$@" ;;
    tail) shift; cmd_loop_tail "$@" ;;
    *) printf 'usage: %s\n' "$LOOP_USAGE" >&2; return 2 ;;
  esac
}

cmd_watch() {
  case "${1:-}" in
    start) shift; cmd_watch_start "$@" ;;
    wait) shift; cmd_watch_wait "$@" ;;
    events) shift; cmd_watch_events "$@" ;;
    list) cmd_watch_list ;;
    stop) shift; cmd_watch_stop "$@" ;;
    *) printf 'usage: %s\n' "$WATCH_USAGE" >&2; return 2 ;;
  esac
}

# active: one row per running loop or watch, plus any that failed or lost their process (those
# need attention). The summarized view for any harness, the dashboard and the sidebars.
cmd_active() {
  local as_json=0 dir id status rows=""
  [ "${1:-}" = "--json" ] && as_json=1
  for dir in "$LOOPS_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    status=$(loop_alive_status "$id")
    case "$status" in running|failed|lost) ;; *) continue ;; esac
    rows="$rows$(jq -c --arg st "$status" --slurpfile p "$dir/spec.json" '{kind: "loop", id: .id, name: $p[0].name,
      status: $st, reason: .reason, started: $p[0].started, interval: $p[0].interval, iteration: .iteration,
      max: $p[0].max, next: .next_tick, last_exit: .last_exit, session: $p[0].session_mode,
      deadline: $p[0].deadline, skipped: (.skipped // 0), when_idle: ($p[0].when_idle // false)}' "$dir/state.json")
"
  done
  for dir in "$WATCHES_HOME"/*/; do
    [ -f "$dir/state.json" ] || continue
    id=$(basename "$dir")
    status=$(watch_alive_status "$id")
    case "$status" in running|lost) ;; *) continue ;; esac
    rows="$rows$(jq -c --arg st "$status" --slurpfile p "$dir/spec.json" '{kind: "watch", id: .id, name: $p[0].name,
      status: $st, reason: .reason, started: $p[0].started, interval: $p[0].interval, events: .events,
      last_event: .last_event, cmd: $p[0].cmd, deadline: $p[0].deadline}' "$dir/state.json")
"
  done
  if [ "$as_json" -eq 1 ]; then
    printf '%s' "$rows" | jq -cs '.'
    return 0
  fi
  [ -n "$rows" ] || { printf 'no active loops or watches\n'; return 0; }
  printf '%s' "$rows" | jq -r '
    (if .status == "running" then "" else " [" + .status + "]" end) as $flag
    | if .kind == "loop" then
        "loop \(.name) · \(.id) · iter \(.iteration)\(if .max > 0 then "/\(.max)" else "" end) · next \(.next | strftime("%H:%M:%S")) UTC · last exit \(.last_exit // "-")\($flag)"
      else
        "watch \(.name) · \(.id) · \(.events) event(s)\(if .last_event then " · last " + .last_event else "" end)\($flag)"
      end'
}
