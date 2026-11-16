# Coordinator wake-up: `run wait` blocks until the run needs its coordinator, then prints one line
# per event. Sourced by dispatch.sh after visibility.sh and health.sh; only defines functions.
#
# Events: a node status change (from -> to), nodes became ready, a node waits on the user
# (needs-user), a running node stalled / its owner died (dead) / its owner went idle without a
# report (no-report), the health:<run> monitor was dead (re-started here), the run ended, and
# "settled" (nothing running or ready while the run is still open).
#
# Nothing between two polls is missed: the run's events.jsonl is read from a cursor first, then the
# state is diffed against the snapshot kept in the same cursor (runs/<run>/wait.cursor, or
# wait.follow.cursor for --follow; written only here). The stall check is a read-only HEALTH_JQ pass (health.sh) over the opencode session
# index (owners.sh), so it needs no health snapshot and no sqlite3 CLI.

RUN_WAIT_USAGE='dispatch.sh run wait <run-id> [--timeout SECS] [--stall-min N] [--json] [--follow] [--include-notes]'
RUN_WAIT_POLL_SECS_DEFAULT=2
WAIT_WAKE_HEALTH='"stalled","dead","no-report"'

# A follower (--follow) keeps its own cursor, so a one-shot `run wait` beside it cannot consume its
# events; a restarted follower resumes from that cursor and neither repeats nor skips a change.
wait_cursor_file() { printf '%s/%s/wait%s.cursor\n' "$RUNS_HOME" "$1" "${2:+.$2}"; }
# Upper bound on the gap between two full scans (and two job syncs), so a change is printed within
# 30 seconds even when the file stamps did not move (same second, same size) or a job ended silently.
RUN_WAIT_RESCAN_SECS_DEFAULT=15

# Number of nodes that are running, and waiting with every dependency done.
run_live_counts() {
  jq -r "$NODE_READY_JQ_DEF"'. as $r
    | ([.nodes[] | select(.status == "running")] | length) as $run
    | ([.nodes[] | select(.status == "waiting") | .id as $n
        | select(node_ready($r))]
       | length) as $rdy
    | "\($run) \($rdy)"' "$1"
}

# wait_health_map <run> <stall-min> - {node: {h, note}} for every running node: the health.sh
# classification, computed read-only (no previous pass, no events, no nudges).
wait_health_map() {
  local run_id="$1" stall_min="$2" idx
  idx=$(owner_session_index_file 2>/dev/null) || idx=""
  [ -n "$idx" ] && [ -f "$idx" ] || idx=/dev/null
  jq -c --arg run "$run_id" --argjson now "$(date +%s)" --argjson stall "$((stall_min * 60))" \
    --argjson gap "$HEALTH_NUDGE_GAP_SECS" --argjson days "$HEALTH_INDEX_DAYS" \
    --slurpfile idx "$idx" --slurpfile prev /dev/null --slurpfile prof /dev/null \
    "$HEALTH_JQ"' | [.nodes[] | select(.status == "running") | {key: .id, value: {h: .health, note: .note}}] | from_entries' \
    "$(run_state_file "$run_id")" 2>/dev/null
}

# The scan: new event lines + state + optional health map + cursor -> {cursor, events}.
# shellcheck disable=SC2016
WAIT_SCAN_JQ="$NODE_READY_JQ_DEF"'
def wake: IN('"$WAIT_WAKE_HEALTH"');
def nn: if . == null or . == "" then null else . end;
$st[0] as $r
| {status: $r.status,
   nodes: ($r.nodes | map({key: .id, value: {s: .status, needs: (.needs_user | nn), e: (.error | nn)}}) | from_entries),
   ready: [$r.nodes[] | select(node_ready($r)) | .id]} as $now
| ([$r.nodes[] | select(.status == "running")] | length) as $running
| ($cur.health // {}) as $h0
| if ($cur.snap // null) == null then {cursor: ($cur + {snap: $now, health: $h0, settled: false}), events: []}
  else
    (reduce ($ev[]? | select(type == "object" and .node != null)) as $e ({snap: $cur.snap, health: $h0, out: []};
      if $e.kind == "status" then
        if .snap.nodes[$e.node].s == $e.to then . else
          .snap.nodes[$e.node].s = $e.to
          | .out += [{kind: "status", node: $e.node, from: $e.from, to: $e.to, note: (if $e.to == "error" then $e.note else null end)}] end
      elif $e.kind == "needs-user" then
        (($e.note // "cleared") | if . == "cleared" then null else . end) as $nu
        | if .snap.nodes[$e.node].needs == $nu then . else
            .snap.nodes[$e.node].needs = $nu
            | (if $nu == null then . else .out += [{kind: "needs-user", node: $e.node, note: $nu}] end) end
      elif ($e.kind == "health" or $e.kind == "owner") and (($e.to // "") | IN("stalled", "dead", "no-report", "gone", "failed")) then
        ($e.to | if . == "gone" or . == "failed" then "dead" else . end) as $k
        | if .health[$e.node] == $k then . else .health[$e.node] = $k | .out += [{kind: $k, node: $e.node, note: $e.note}] end
      elif $e.kind == "health" and $e.to == "ok" then .health[$e.node] = "ok"
      elif $e.kind == "ask" then .out += [{kind: "ask", node: $e.node, note: $e.note}]
      elif $notes == 1 and ($e.kind == "note" or $e.kind == "ping") then .out += [{kind: "note", node: $e.node, note: ($e.note // "ping")}]
      else . end)) as $a
    | [$now.nodes | to_entries[] | .key as $id | .value as $c | ($a.snap.nodes[$id] // null) as $p
        | (if $p != null and $p.s != $c.s then {kind: "status", node: $id, from: $p.s, to: $c.s, note: (if $c.s == "error" then $c.e else null end)} else empty end),
          (if $c.needs != null and ($p.needs // null) != $c.needs then {kind: "needs-user", node: $id, note: $c.needs} else empty end)] as $diff
    | [$now.ready[] | select(. as $i | ($a.snap.ready // []) | index($i) | not)] as $newready
    | (if $hm == null then {health: $a.health, out: []} else
        reduce ($hm | to_entries[]) as $x ({health: $a.health, out: []};
          if ($x.value.h | wake) and .health[$x.key] != $x.value.h
          then .health[$x.key] = $x.value.h | .out += [{kind: $x.value.h, node: $x.key, note: $x.value.note}]
          else .health[$x.key] = $x.value.h end) end) as $hp
    | ($hp.health | with_entries(select(.key as $k | $now.nodes[$k].s == "running"))) as $health
    | ($a.out + $diff
       + (if ($newready | length) > 0 then [{kind: "ready", node: null, note: ($newready | join(","))}] else [] end)
       + $hp.out
       + (if $now.status != "running" then [{kind: "run-ended", node: null, to: $now.status, note: null}] else [] end)) as $ev1
    | ($now.status == "running" and $running == 0 and ($now.ready | length) == 0) as $idle
    | (if ($ev1 | length) == 0 and $idle and (($cur.settled // false) | not)
       then [{kind: "settled", node: null, note: "no running or ready nodes"}] else [] end) as $settle
    | {cursor: ($cur + {snap: $now, health: $health,
                        settled: (if ($settle | length) > 0 then true elif $idle then ($cur.settled // false) else false end)}),
       events: ($ev1 + $settle)}
  end
'

# Formats events (a JSON array on stdin) as text lines or one JSON object per line.
wait_render() {
  local run_id="$1" json="$2"
  if [ "$json" = 1 ]; then
    jq -c --arg run "$run_id" --arg at "$(now_iso)" '.[] | {at: $at, run: $run, kind, node, from: (.from // null), to: (.to // null), note: (.note // null)}'
  else
    jq -r '.[] |
      if .kind == "status" then "\(.node) \(.from // "-")->\(.to)" + (if .note then ": \(.note)" else "" end)
      elif .kind == "ready" then "ready: \(.note)"
      elif .kind == "run-ended" then "run ended: \(.to)"
      elif .kind == "settled" then "settled: \(.note)"
      elif .kind == "monitor" then "monitor: \(.note)"
      elif .node == null then "\(.kind): \(.note // "")"
      else "\(.node) \(.kind): \(.note // "")" end'
  fi
}

# wait_check_monitor <run> - when the run had a health monitor and it is gone, start it again
# (the --ensure-monitors path) and print one monitor event as a JSON array; prints [] otherwise.
wait_check_monitor() {
  local run_id="$1" ev id
  case "${ORCH_HEALTH_MONITOR:-}" in 0|false|off) printf '[]'; return 0 ;; esac
  ev=$(run_events_file "$run_id")
  if [ -f "$ev" ] && grep -q '"note":"monitor started' "$ev" 2>/dev/null && ! health_monitor_find "$run_id" >/dev/null; then
    if id=$(health_monitor_start "$run_id"); then
      jq -nc --arg id "$id" '[{kind: "monitor", node: null, note: "health monitor was dead, restarted \($id)"}]'
    else
      jq -nc '[{kind: "monitor", node: null, note: "health monitor is dead and did not restart"}]'
    fi
    return 0
  fi
  printf '[]'
}

cmd_run_wait() {
  local run_id="" timeout=0 stall_min="" json=0 follow=0 notes=0 file evf cursor cur poll every
  local deadline=0 next_health=0 next_sync=0 next_scan=0 next_bridge=0 rescan key last_key="" total n hm events out now extra newcur
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) shift; timeout="${1:-}" ;;
      --stall-min) shift; stall_min="${1:-}" ;;
      --json) json=1 ;;
      --follow) follow=1 ;;
      --include-notes) notes=1 ;;
      -*) printf 'run wait: unknown argument %s\n  usage: %s\n' "$1" "$RUN_WAIT_USAGE" >&2; return 2 ;;
      *) [ -z "$run_id" ] || { printf 'usage: %s\n' "$RUN_WAIT_USAGE" >&2; return 2; }; run_id="$1" ;;
    esac
    shift
  done
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_WAIT_USAGE" >&2; return 2; }
  is_uint "$timeout" || { printf 'run wait: --timeout must be whole seconds\n' >&2; return 2; }
  [ -n "$stall_min" ] || stall_min="${ORCH_STALL_MIN:-$(setting_get stall_minutes "$HEALTH_STALL_MIN_DEFAULT")}"
  is_uint "$stall_min" && [ "$stall_min" -gt 0 ] || { printf 'run wait: --stall-min must be a positive whole number\n' >&2; return 2; }
  require_jq "run wait"
  file=$(run_require "$run_id") || return $?
  evf=$(run_events_file "$run_id")
  if [ "$follow" = 1 ]; then
    cursor=$(wait_cursor_file "$run_id" follow)
    # First follower: start from the shared cursor, so changes since the last wait are kept.
    [ -f "$cursor" ] || [ ! -f "$(wait_cursor_file "$run_id")" ] || cp "$(wait_cursor_file "$run_id")" "$cursor" 2>/dev/null || true
  else
    cursor=$(wait_cursor_file "$run_id")
  fi
  rescan="${ORCH_WAIT_RESCAN_SECS:-$RUN_WAIT_RESCAN_SECS_DEFAULT}"
  is_uint "$rescan" && [ "$rescan" -ge 1 ] || rescan=$RUN_WAIT_RESCAN_SECS_DEFAULT
  poll="${ORCH_WAIT_POLL_SECS:-$RUN_WAIT_POLL_SECS_DEFAULT}"
  every="${ORCH_WAIT_HEALTH_SECS:-$(health_every_sec)}"
  now=$(date +%s)
  [ "$timeout" = 0 ] || deadline=$((now + timeout))
  cur=$(jq -c 'if type == "object" then . else {} end' "$cursor" 2>/dev/null) || cur=""
  if [ -z "$cur" ] || [ "$(printf '%s' "$cur" | jq -r '.n // empty')" = "" ]; then
    n=0; [ -f "$evf" ] && n=$(wc -l < "$evf" | tr -d ' ')
    cur=$(jq -nc --argjson n "$n" '{n: $n}')
  fi
  while :; do
    now=$(date +%s)
    hm=null extra='[]'
    if [ "$now" -ge "$next_sync" ]; then
      next_sync=$((now + rescan))
      # A job-backed node flips only through run sync; the dashboard does this too, but may be down.
      if jq -e 'any(.nodes[]; .status == "running" and (.job_id // "") != "")' "$file" >/dev/null 2>&1; then
        cmd_run_sync "$run_id" --no-retry >/dev/null 2>&1 || true
      fi
    fi
    if [ "$now" -ge "$next_scan" ]; then next_scan=$((now + rescan)); last_key=""; fi
    if [ "$now" -ge "$next_bridge" ]; then
      next_bridge=$((now + COORD_SWEEP_SECS))
      # The first wait of a session records the coordinator; later sweeps keep the stored one.
      [ "$(jq -r '.coordinator == null' "$file")" = true ] && coordinator_auto_record "$run_id" >/dev/null 2>&1 || true
      coord_sweep "$run_id" >/dev/null 2>&1 || true
    fi
    if [ "$now" -ge "$next_health" ]; then
      next_health=$((now + every))
      hm=$(wait_health_map "$run_id" "$stall_min") || hm=null
      [ -n "$hm" ] || hm=null
      extra=$(wait_check_monitor "$run_id")
      last_key=""
    fi
    key=$(health_key "$file" "$evf")
    if [ "$key" != "$last_key" ]; then
      last_key="$key"
      # Events first, then the state: a change that lands between the two reads shows up in the
      # state diff now, and its event line is skipped next time (the snapshot already has it).
      total=0; [ -f "$evf" ] && total=$(wc -l < "$evf" | tr -d ' ')
      n=$(printf '%s' "$cur" | jq -r '.n // 0')
      [ "$total" -ge "$n" ] || n=0
      out=$( { [ "$total" -le "$n" ] || sed -n "$((n + 1)),${total}p" "$evf"; } \
        | jq -c -n -R --slurpfile st "$file" --argjson cur "$cur" --argjson hm "$hm" --argjson notes "$notes" \
            '[inputs | try fromjson catch null] as $ev | '"$WAIT_SCAN_JQ" 2>/dev/null) || out=""
      newcur=""
      if [ -n "$out" ]; then
        newcur=$(printf '%s' "$out" | jq -c --argjson n "$total" '.cursor + {n: $n}')
        events=$(printf '%s' "$out" | jq -c --argjson x "$extra" '$x + .events')
      else
        events="$extra"
        last_key=""   # the scan failed (a half-written file): try again on the next poll
      fi
      # Print first, then move the cursor: a follower killed in between repeats nothing it did not
      # print, and a change is never marked seen before it reached the output.
      [ "$events" = '[]' ] || printf '%s' "$events" | wait_render "$run_id" "$json"
      if [ -n "$newcur" ]; then
        cur="$newcur"
        printf '%s\n' "$cur" > "$cursor.tmp.$$" && mv -f "$cursor.tmp.$$" "$cursor"
      fi
      if [ "$events" != '[]' ]; then
        if printf '%s' "$events" | jq -e 'any(.[]; .kind == "run-ended")' >/dev/null; then return 0; fi
        if [ "$follow" = 0 ]; then
          printf '%s' "$events" | jq -e 'all(.[]; .kind == "settled")' >/dev/null && return 3
          return 0
        fi
      fi
    elif [ "$extra" != '[]' ]; then
      printf '%s' "$extra" | wait_render "$run_id" "$json"
      [ "$follow" = 1 ] || return 0
    fi
    if [ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      if [ "$json" = 1 ]; then
        jq -nc --arg run "$run_id" --arg at "$(now_iso)" --argjson t "$timeout" '{at: $at, run: $run, kind: "timeout", note: "no change in \($t)s"}'
      else
        printf 'no change (timed out after %ss)\n' "$timeout"
      fi
      return 124
    fi
    sleep "$poll"
  done
}
