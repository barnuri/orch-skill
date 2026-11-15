#!/usr/bin/env bash
# Schedules (`schedule`) — sourced by dispatch.sh, never executed.
# A schedule fires a prompt (through a profile) or a shell command on a cron expression. Each one
# lives in <home>/schedules/<id>/schedule.json; every write goes through sched_patch, so a reader
# never sees a half-written file. `schedule tick` is the only thing that fires them: the dashboard
# server calls it every 30 s, and it is safe to call by hand or from cron.

SCHEDULES_HOME="$ORCH_HOME/schedules"
SCHED_RUNS_KEEP=30
SCHED_CMD_TIMEOUT_DEFAULT=3600
SCHED_NEXT_DAYS=366
SCHEDULE_USAGE='dispatch.sh schedule add --name N --cron "<m h dom mon dow>" (--prompt TEXT|@file --profile P | --command CMD [--workdir DIR] [--timeout DUR]) | edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--command CMD] [--workdir DIR] [--timeout DUR] | list [--json] | show <id> | enable|disable <id> | remove <id> | run <id> | log <id> [index] | tick | next "<cron>"'

# sched_cron_next <expr> <from-epoch>: the first matching minute after <from>, as epoch seconds
# (local time). Fields: * , - / lists, plus @hourly @daily @weekly @monthly. Exit 1 on a bad expression
# or when nothing matches within a year.
sched_cron_next() {
  command -v perl >/dev/null 2>&1 || { printf 'schedule: perl is required for cron\n' >&2; return 1; }
  perl -e '
    use strict; use warnings; use POSIX qw(mktime);
    my ($expr, $from, $days) = @ARGV;
    my %alias = ("\@hourly"=>"0 * * * *", "\@daily"=>"0 0 * * *", "\@weekly"=>"0 0 * * 0", "\@monthly"=>"0 0 1 * *");
    $expr = $alias{$expr} if exists $alias{$expr};
    my @f = split " ", $expr;
    exit 1 unless @f == 5;
    my @range = ([0,59],[0,23],[1,31],[1,12],[0,7]);
    my (@set, @star);
    for my $i (0..4) {
      my ($min, $max) = @{$range[$i]}; my %ok;
      $star[$i] = ($f[$i] =~ m{^\*(/1)?$}) ? 1 : 0;
      for my $part (split /,/, $f[$i]) {
        my ($r, $s) = split m{/}, $part, 2;
        $s = 1 unless defined $s;
        exit 1 unless $s =~ /^\d+$/ && $s >= 1;
        my ($lo, $hi);
        if ($r eq "*") { ($lo, $hi) = ($min, $max) }
        elsif ($r =~ /^(\d+)-(\d+)$/) { ($lo, $hi) = ($1, $2) }
        elsif ($r =~ /^\d+$/) { ($lo, $hi) = ($r, defined((split m{/}, $part, 2)[1]) ? $max : $r) }
        else { exit 1 }
        exit 1 if $lo < $min || $hi > $max || $lo > $hi;
        for (my $v = $lo; $v <= $hi; $v += $s) { $ok{$i == 4 && $v == 7 ? 0 : $v} = 1 }
      }
      $set[$i] = \%ok;
    }
    my $t = $from - ($from % 60) + 60;
    for (1 .. $days * 1440) {
      my @l = localtime($t);
      my ($mi, $h, $d, $mo, $w) = ($l[1], $l[2], $l[3], $l[4] + 1, $l[6]);
      my $day_ok = ($star[2] || $star[4]) ? ($set[2]{$d} && $set[4]{$w}) : ($set[2]{$d} || $set[4]{$w});
      if ($set[0]{$mi} && $set[1]{$h} && $set[3]{$mo} && $day_ok) { print "$t\n"; exit 0 }
      $t += 60;
    }
    exit 1;
  ' "$1" "$2" "$SCHED_NEXT_DAYS"
}

sched_file() { printf '%s/%s/schedule.json\n' "$SCHEDULES_HOME" "$1"; }

sched_exists() { [ -n "${1:-}" ] && [ -f "$(sched_file "$1")" ]; }

sched_patch() {
  local id="$1" filter="$2" file tmp
  shift 2
  file=$(sched_file "$id")
  tmp="$file.tmp.$$"
  jq "$@" "$filter" "$file" > "$tmp" && mv -f "$tmp" "$file"
}

sched_set_next() {
  local id="$1" cron next
  cron=$(jq -r '.cron' "$(sched_file "$id")")
  if next=$(sched_cron_next "$cron" "$(date +%s)"); then
    sched_patch "$id" '.next_at = $n' --argjson n "$next"
  else
    sched_patch "$id" '.next_at = null'
  fi
}

# sched_run_state <run-json>: running | ok | failed | lost, read from the run's own exit marker.
sched_run_state() {
  local run="$1" kind ref pid code
  kind=$(printf '%s' "$run" | jq -r '.kind')
  ref=$(printf '%s' "$run" | jq -r '.ref')
  if [ "$kind" = prompt ]; then
    local out
    out=$(job_status "$ref" 2>/dev/null) || { printf 'lost\n'; return 0; }
    case "$out" in
      running) printf 'running\n' ;;
      "done exit=0") printf 'ok\n' ;;
      done*) printf 'failed\n' ;;
      *) printf 'lost\n' ;;
    esac
    return 0
  fi
  if [ -f "$ref/exit" ]; then
    code=$(cat "$ref/exit")
    [ "$code" = 0 ] && printf 'ok\n' || printf 'failed\n'
    return 0
  fi
  pid=$(cat "$ref/pid" 2>/dev/null || printf '')
  if pid_alive "$pid"; then printf 'running\n'; else printf 'lost\n'; fi
}

# sched_run_end <run-json>: when a finished run actually ended, from its exit marker's mtime, so a
# slow poll does not stretch the recorded duration. Falls back to now.
sched_run_end() {
  local run="$1" marker mtime
  if [ "$(printf '%s' "$run" | jq -r '.kind')" = prompt ]; then
    marker="$JOBS_HOME/$(printf '%s' "$run" | jq -r '.ref')/exit_code"
  else
    marker="$(printf '%s' "$run" | jq -r '.ref')/exit"
  fi
  mtime=$(file_mtime "$marker" 2>/dev/null) || mtime=""
  if [ -n "$mtime" ]; then
    date -u -r "$mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$mtime" +%Y-%m-%dT%H:%M:%SZ
  else
    now_iso
  fi
}

# sched_reap <id>: moves every run still marked running to its final state.
sched_reap() {
  local id="$1" file idx run state code
  file=$(sched_file "$id")
  idx=0
  while [ "$idx" -lt "$(jq '.runs | length' "$file")" ]; do
    run=$(jq -c ".runs[$idx]" "$file")
    if [ "$(printf '%s' "$run" | jq -r '.status')" = running ]; then
      state=$(sched_run_state "$run")
      if [ "$state" != running ]; then
        code=""
        if [ "$(printf '%s' "$run" | jq -r '.kind')" = command ] && [ -f "$(printf '%s' "$run" | jq -r '.ref')/exit" ]; then
          code=$(cat "$(printf '%s' "$run" | jq -r '.ref')/exit")
        fi
        sched_patch "$id" ".runs[$idx].status = \$s | .runs[$idx].ended_at = \$t | .runs[$idx].exit = (if \$c == \"\" then null else (\$c | tonumber) end)" \
          --arg s "$state" --arg t "$(sched_run_end "$run")" --arg c "$code"
      fi
    fi
    idx=$((idx + 1))
  done
}

sched_running() {
  [ "$(jq '[.runs[] | select(.status == "running")] | length' "$(sched_file "$1")")" -gt 0 ]
}

# sched_fire <id>: starts one run now; records it. Prints the run's reference.
sched_fire() {
  local id="$1" file dir kind stamp rundir ref pid
  file=$(sched_file "$id")
  dir="$SCHEDULES_HOME/$id"
  kind=$(jq -r '.kind' "$file")
  stamp=$(date -u +%Y%m%d-%H%M%S)
  if [ "$kind" = prompt ]; then
    local profile
    profile=$(jq -r '.profile' "$file")
    jq -r '.prompt' "$file" > "$dir/prompt.md"
    ref=$(cmd_start --profile "$profile" "@$dir/prompt.md") || {
      sched_patch "$id" '.runs = ([{started_at: $t, ended_at: $t, kind: "prompt", ref: "", status: "failed", exit: null}] + .runs)[:$k]' \
        --arg t "$(now_iso)" --argjson k "$SCHED_RUNS_KEEP"
      return 1
    }
  else
    rundir="$dir/runs/$stamp-$RANDOM"
    mkdir -p "$rundir"
    jq -r '.command' "$file" > "$rundir/command"
    ref="$rundir"
    local workdir timeout
    workdir=$(jq -r '.workdir // ""' "$file")
    timeout=$(jq -r '.timeout // 0' "$file")
    [ "$timeout" -gt 0 ] || timeout="$SCHED_CMD_TIMEOUT_DEFAULT"
    run_detached bash -c '
      rundir="$1"; secs="$2"; workdir="$3"
      [ -z "$workdir" ] || cd "$workdir" || { printf "cannot cd to %s\n" "$workdir" > "$rundir/out"; printf 1 > "$rundir/exit"; exit 1; }
      if command -v perl >/dev/null 2>&1; then
        perl -e "alarm shift; exec @ARGV or die qq(exec: \$!\n)" "$secs" bash "$rundir/command" > "$rundir/out" 2>&1 < /dev/null
      else
        bash "$rundir/command" > "$rundir/out" 2>&1 < /dev/null
      fi
      rc=$?
      printf %s "$rc" > "$rundir/exit.tmp" && mv "$rundir/exit.tmp" "$rundir/exit"
    ' _ "$rundir" "$timeout" "$workdir" >/dev/null 2>&1 </dev/null &
    pid=$!
    disown "$pid" 2>/dev/null || true
    printf '%s\n' "$pid" > "$rundir/pid"
  fi
  sched_patch "$id" '.last_run_at = $t | .runs = ([{started_at: $t, ended_at: null, kind: $k, ref: $r, status: "running", exit: null}] + .runs)[:$keep]' \
    --arg t "$(now_iso)" --arg k "$kind" --arg r "$ref" --argjson keep "$SCHED_RUNS_KEEP"
  printf '%s\n' "$ref"
}

cmd_schedule_add() {
  local name="" cron="" prompt="" profile="" command="" workdir="" timeout="" id dir secs=0 kind
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="${2:-}"; shift 2 ;;
      --cron) cron="${2:-}"; shift 2 ;;
      --prompt) prompt="${2:-}"; shift 2 ;;
      --profile) profile="${2:-}"; shift 2 ;;
      --command) command="${2:-}"; shift 2 ;;
      --workdir) workdir="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      *) printf 'schedule add: unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  [ -n "$name" ] && [ -n "$cron" ] || { printf 'usage: %s\n' "$SCHEDULE_USAGE" >&2; return 2; }
  if [ -n "$prompt" ] && [ -n "$command" ]; then
    printf 'schedule add: give --prompt or --command, not both\n' >&2; return 2
  fi
  if [ -n "$prompt" ]; then
    kind=prompt
    [ -n "$profile" ] || { printf 'schedule add: --prompt needs --profile\n' >&2; return 2; }
    profile_load "$profile" || return $?
    case "$prompt" in
      @*) [ -f "${prompt#@}" ] || { printf 'schedule add: no such prompt file: %s\n' "${prompt#@}" >&2; return 2; }
          prompt=$(cat "${prompt#@}") ;;
    esac
  elif [ -n "$command" ]; then
    kind=command
    [ -z "$workdir" ] || [ -d "$workdir" ] || { printf 'schedule add: no such directory: %s\n' "$workdir" >&2; return 2; }
  else
    printf 'schedule add: give --prompt or --command\n' >&2; return 2
  fi
  [ -z "$timeout" ] || secs=$(parse_duration "$timeout") || { printf 'schedule add: bad --timeout: %s\n' "$timeout" >&2; return 2; }
  sched_cron_next "$cron" "$(date +%s)" >/dev/null || { printf 'schedule add: bad or never-matching cron: %s\n' "$cron" >&2; return 2; }
  id="sch-$(date -u +%Y%m%d-%H%M%S)-$(printf '%04x' $((RANDOM % 65536)))"
  dir="$SCHEDULES_HOME/$id"
  mkdir -p "$dir" || return 1
  jq -n --arg id "$id" --arg name "$name" --arg cron "$cron" --arg kind "$kind" --arg prompt "$prompt" \
    --arg profile "$profile" --arg command "$command" --arg workdir "$workdir" --argjson timeout "$secs" --arg t "$(now_iso)" \
    '{id: $id, name: $name, cron: $cron, kind: $kind, enabled: true, created_at: $t,
      prompt: (if $kind == "prompt" then $prompt else null end), profile: (if $kind == "prompt" then $profile else null end),
      command: (if $kind == "command" then $command else null end), workdir: (if $workdir == "" then null else $workdir end),
      timeout: $timeout, next_at: null, last_run_at: null, runs: []}' > "$dir/schedule.json"
  sched_set_next "$id"
  printf '%s\n' "$id"
}

# edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--command CMD] [--workdir DIR]
# [--timeout DUR]: changes the given fields and keeps id, created_at, enabled and the run history.
# Each value is checked as `add` checks it. --prompt makes it a prompt schedule and --command a
# command schedule; a kind switch clears the other kind's fields. --workdir "" and --timeout 0 clear
# those. No lock is needed against a run in progress: a run copies its prompt or command when it
# starts, and the server's claim files are keyed by next_at, so an edit cannot double-fire a time.
cmd_schedule_edit() {
  local id="${1:-}" file kind new_kind secs cur old_cron old_next
  local name="" cron="" prompt="" profile="" command="" workdir="" timeout=""
  local has_name=0 has_cron=0 has_prompt=0 has_profile=0 has_command=0 has_workdir=0 has_timeout=0
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "$id" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || { printf 'schedule edit: %s needs a value\n' "$1" >&2; return 2; }
    case "$1" in
      --name) name="$2"; has_name=1 ;;
      --cron) cron="$2"; has_cron=1 ;;
      --prompt) prompt="$2"; has_prompt=1 ;;
      --profile) profile="$2"; has_profile=1 ;;
      --command) command="$2"; has_command=1 ;;
      --workdir) workdir="$2"; has_workdir=1 ;;
      --timeout) timeout="$2"; has_timeout=1 ;;
      *) printf 'schedule edit: unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
    shift 2
  done
  [ $((has_name + has_cron + has_prompt + has_profile + has_command + has_workdir + has_timeout)) -gt 0 ] ||
    { printf 'schedule edit: nothing to change\n' >&2; return 2; }
  file=$(sched_file "$id")
  kind=$(jq -r '.kind' "$file")
  old_cron=$(jq -r '.cron // ""' "$file")
  old_next=$(jq -r '.next_at // ""' "$file")
  if [ "$has_prompt" -eq 1 ] && [ "$has_command" -eq 1 ]; then
    printf 'schedule edit: give --prompt or --command, not both\n' >&2; return 2
  fi
  new_kind="$kind"
  [ "$has_prompt" -eq 0 ] || new_kind=prompt
  [ "$has_command" -eq 0 ] || new_kind=command
  if [ "$has_name" -eq 1 ] && [ -z "$name" ]; then printf 'schedule edit: --name cannot be empty\n' >&2; return 2; fi
  if [ "$has_cron" -eq 1 ]; then
    sched_cron_next "$cron" "$(date +%s)" >/dev/null || { printf 'schedule edit: bad or never-matching cron: %s\n' "$cron" >&2; return 2; }
  fi
  if [ "$new_kind" = prompt ]; then
    if [ "$has_workdir" -eq 1 ] || [ "$has_timeout" -eq 1 ]; then
      printf 'schedule edit: --workdir and --timeout belong to a command schedule\n' >&2; return 2
    fi
    if [ "$has_prompt" -eq 1 ]; then
      case "$prompt" in
        @*) [ -f "${prompt#@}" ] || { printf 'schedule edit: no such prompt file: %s\n' "${prompt#@}" >&2; return 2; }
            prompt=$(cat "${prompt#@}") ;;
      esac
      [ -n "$prompt" ] || { printf 'schedule edit: --prompt cannot be empty\n' >&2; return 2; }
    fi
    if [ "$has_profile" -eq 0 ]; then
      cur=$(jq -r '.profile // ""' "$file")
      [ "$kind" = prompt ] && [ -n "$cur" ] || { printf 'schedule edit: --prompt needs --profile\n' >&2; return 2; }
    else
      [ -n "$profile" ] || { printf 'schedule edit: --profile cannot be empty\n' >&2; return 2; }
      profile_load "$profile" || return $?
    fi
  else
    if [ "$has_profile" -eq 1 ]; then
      printf 'schedule edit: --profile belongs to a prompt schedule\n' >&2; return 2
    fi
    if [ "$has_command" -eq 1 ] && [ -z "$command" ]; then printf 'schedule edit: --command cannot be empty\n' >&2; return 2; fi
    [ "$has_workdir" -eq 0 ] || [ -z "$workdir" ] || [ -d "$workdir" ] || { printf 'schedule edit: no such directory: %s\n' "$workdir" >&2; return 2; }
  fi
  secs=""
  if [ "$has_timeout" -eq 1 ]; then
    secs=$(parse_duration "$timeout") || { printf 'schedule edit: bad --timeout: %s\n' "$timeout" >&2; return 2; }
  fi
  # One jq pass, written through sched_patch's temp-file-and-rename, so a reader never sees half an edit.
  sched_patch "$id" '
    (if $hn == 1 then .name = $name else . end)
    | (if $hc == 1 then .cron = $cron else . end)
    | (if $kind == "prompt" then
         (if .kind != "prompt" then .kind = "prompt" | .command = null | .workdir = null | .timeout = 0 else . end)
         | (if $hp == 1 then .prompt = $prompt else . end)
         | (if $hpr == 1 then .profile = $profile else . end)
       else
         .kind = "command" | .prompt = null | .profile = null
         | (if $hcm == 1 then .command = $command else . end)
         | (if $hw == 1 then .workdir = (if $workdir == "" then null else $workdir end) else . end)
         | (if $ht == 1 then .timeout = ($secs | tonumber) else . end)
       end)
    | .updated_at = $t' \
    --arg kind "$new_kind" --arg name "$name" --arg cron "$cron" --arg prompt "$prompt" --arg profile "$profile" \
    --arg command "$command" --arg workdir "$workdir" --arg secs "${secs:-0}" --arg t "$(now_iso)" \
    --argjson hn "$has_name" --argjson hc "$has_cron" --argjson hp "$has_prompt" --argjson hpr "$has_profile" \
    --argjson hcm "$has_command" --argjson hw "$has_workdir" --argjson ht "$has_timeout" || return 1
  # Recompute next_at only when the timetable changed (or none is set): recomputing on a name or
  # prompt edit would move a due-but-not-yet-claimed next_at into the future and skip that run.
  if [ "$(jq -r '.enabled' "$file")" = true ] &&
     { { [ "$has_cron" -eq 1 ] && [ "$cron" != "$old_cron" ]; } || [ -z "$old_next" ]; }; then
    sched_set_next "$id"
  fi
  printf 'edited: %s\n' "$id"
}

sched_load_ids() {
  local d
  [ -d "$SCHEDULES_HOME" ] || return 0
  for d in "$SCHEDULES_HOME"/*/; do
    [ -f "$d/schedule.json" ] && basename "$d"
  done
}

cmd_schedule_list() {
  local as_json=0 id rows=""
  [ "${1:-}" = "--json" ] && as_json=1
  for id in $(sched_load_ids); do
    sched_reap "$id"
    rows="$rows$(jq -c '. + {last_status: (.runs[0].status // null)}' "$(sched_file "$id")")
"
  done
  if [ "$as_json" -eq 1 ]; then
    printf '%s' "$rows" | jq -cs 'sort_by(.created_at) | reverse'
    return 0
  fi
  [ -n "$rows" ] || { printf 'no schedules\n'; return 0; }
  printf '%s' "$rows" | jq -r '
    [.id, (if .enabled then "on" else "off" end), .cron, .kind, (.last_status // "never run"),
     (if .next_at then "next " + (.next_at | strflocaltime("%Y-%m-%d %H:%M")) else "no next run" end), .name] | join("\t")'
}

cmd_schedule_show() {
  local id="${1:-}"
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "${id:-}" >&2; return 2; }
  sched_reap "$id"
  jq . "$(sched_file "$id")"
}

cmd_schedule_set_enabled() {
  local id="${2:-}" value="$1"
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "$id" >&2; return 2; }
  sched_patch "$id" '.enabled = $v' --argjson v "$value"
  [ "$value" = false ] && sched_patch "$id" '.next_at = null' || sched_set_next "$id"
  printf '%s: %s\n' "$id" "$([ "$value" = true ] && printf enabled || printf disabled)"
}

cmd_schedule_remove() {
  local id="${1:-}" dir
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "${id:-}" >&2; return 2; }
  dir="$SCHEDULES_HOME/$id"
  if command -v trash >/dev/null 2>&1; then
    trash "$dir"
  else
    mkdir -p "$ORCH_HOME/.trash/$(date -u +%Y%m%d-%H%M%S)" && mv "$dir" "$ORCH_HOME/.trash/$(date -u +%Y%m%d-%H%M%S)/"
  fi
  printf 'removed: %s\n' "$id"
}

cmd_schedule_run() {
  local id="${1:-}"
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "${id:-}" >&2; return 2; }
  sched_fire "$id" >/dev/null || return 1
  printf 'started: %s\n' "$id"
}

# tick: for every enabled schedule that is due, start one run (a window missed while nothing was
# ticking fires once, not once per missed minute), then move its next time forward. A schedule whose
# previous run is still going skips the tick, so runs never overlap.
cmd_schedule_tick() {
  local id now fired=0 next
  now=$(date +%s)
  for id in $(sched_load_ids); do
    sched_reap "$id"
    [ "$(jq -r '.enabled' "$(sched_file "$id")")" = true ] || continue
    next=$(jq -r '.next_at // 0' "$(sched_file "$id")")
    [ "$next" -gt 0 ] && [ "$next" -le "$now" ] || continue
    sched_set_next "$id"
    if sched_running "$id"; then
      printf 'skipped (still running): %s\n' "$id"
      continue
    fi
    sched_fire "$id" >/dev/null && fired=$((fired + 1)) && printf 'fired: %s\n' "$id"
  done
  [ "$fired" -gt 0 ] || true
}

# log <id> [index]: the output of one run (0 = newest). A command run's output file, or a prompt
# run's job log.
cmd_schedule_log() {
  local id="${1:-}" idx="${2:-0}" run kind ref file
  sched_exists "$id" || { printf 'unknown schedule: %s\n' "${id:-}" >&2; return 2; }
  is_uint "$idx" || { printf 'schedule log: index must be a number\n' >&2; return 2; }
  run=$(jq -c ".runs[$idx] // empty" "$(sched_file "$id")")
  [ -n "$run" ] || { printf 'no such run\n' >&2; return 2; }
  kind=$(printf '%s' "$run" | jq -r '.kind')
  ref=$(printf '%s' "$run" | jq -r '.ref')
  if [ "$kind" = prompt ]; then file="$JOBS_HOME/$ref/log"; else file="$ref/out"; fi
  [ -n "$ref" ] && [ -f "$file" ] || { printf '(no output yet)\n'; return 0; }
  tail -c 65536 "$file"
}

cmd_schedule_next() {
  local cron="${1:-}" n
  [ -n "$cron" ] || { printf 'usage: %s\n' "$SCHEDULE_USAGE" >&2; return 2; }
  n=$(sched_cron_next "$cron" "$(date +%s)") || { printf 'bad or never-matching cron: %s\n' "$cron" >&2; return 2; }
  date -r "$n" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$n" '+%Y-%m-%d %H:%M'
}

cmd_schedule() {
  case "${1:-}" in
    add) shift; cmd_schedule_add "$@" ;;
    edit) shift; cmd_schedule_edit "$@" ;;
    list) shift; cmd_schedule_list "$@" ;;
    show) shift; cmd_schedule_show "$@" ;;
    enable) shift; cmd_schedule_set_enabled true "$@" ;;
    disable) shift; cmd_schedule_set_enabled false "$@" ;;
    remove) shift; cmd_schedule_remove "$@" ;;
    run) shift; cmd_schedule_run "$@" ;;
    log) shift; cmd_schedule_log "$@" ;;
    tick) shift; cmd_schedule_tick ;;
    next) shift; cmd_schedule_next "$@" ;;
    *) printf 'usage: %s\n' "$SCHEDULE_USAGE" >&2; return 2 ;;
  esac
}
