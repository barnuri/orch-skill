#!/usr/bin/env bash
# Node health: `run health` classifies every non-terminal node of a run in one jq pass, lists the
# ready nodes and free slots, records only what changed since the last pass, and can nudge stalled
# opencode sessions. A `health:<run-id>` monitor (the watch machinery in loops.sh) runs it every
# ORCH_HEALTH_EVERY_SEC for each running run. Sourced by dispatch.sh, never executed.
#
# Inputs, all read-only: the run's state.json, opencode's session index (owner_session_index_file in
# owners.sh, one cached read-only sqlite query per database change) and profiles.json. The last pass
# lives in <home>/health/<run>.json (+ .key), written only here.

RUN_HEALTH_USAGE='dispatch.sh run health <run-id> [--json] [--nudge] | run health --ensure-monitors'
HEALTH_STALL_MIN_DEFAULT=15
HEALTH_EVERY_SEC_DEFAULT=30
HEALTH_EVERY_SEC_MIN=10
HEALTH_NUDGE_GAP_SECS=1800
HEALTH_INDEX_DAYS=3
HEALTH_MONITOR_RUNTIME=7d
HEALTH_BY=health

health_dir() { printf '%s/health\n' "$ORCH_HOME"; }

health_every_sec() {
  local v="${ORCH_HEALTH_EVERY_SEC:-}"
  [ -n "$v" ] || v=$(setting_get health_every_sec "$HEALTH_EVERY_SEC_DEFAULT")
  is_uint "$v" || v=$HEALTH_EVERY_SEC_DEFAULT
  [ "$v" -ge "$HEALTH_EVERY_SEC_MIN" ] || v=$HEALTH_EVERY_SEC_MIN
  printf '%s\n' "$v"
}

# The classification. Input: state.json. Output: one compact line, the report plus private
# `_`-prefixed fields (nudge actions, nudge history, the earliest time a quiet node can stall).
# shellcheck disable=SC2016
HEALTH_JQ="$NODE_READY_JQ_DEF"'
def ep: if . == null or . == "" then null else (try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null) end;
def iso: if . == null then null else (floor | todate) end;
def hhmm: if . == null then "?" else (floor | strflocaltime("%H:%M")) end;
($idx[0] // []) as $ix
| ($ix | map({key: .id, value: .}) | from_entries) as $S
| ($prev[0] // {}) as $P
| ($P._nodes // {}) as $pn
| (($prof[0].defaults.max_parallel // $prof[0].settings.max_parallel) // 15) as $maxp
| . as $r
| ($r.nodes | map({key: .id, value: .status}) | from_entries) as $st
| [$r.nodes[] | select(.status == "running")] as $runn
| ($runn | length) as $running
| ([0, $maxp - $running] | max) as $slots
| [$r.nodes[] | select(.status == "waiting") | . as $n
    | {id, needs: (.needs_user // null | if . == "" then null else . end), hold: (.hold // null | if . == "" then null else . end), ready: node_ready($r), gate: (.after_all // false),
       deps: [($r.edges // [])[] | select(.[1] == $n.id) | .[0]]}] as $waiting
| [$waiting[] | select(.ready) | .id] as $ready
| [$runn[]
    | (if .owner_kind == "session" and (.owner_id // "") != "" then $S[.owner_id] else null end) as $s
    | ([.notes[]?.at | ep] | map(select(. != null)) | max) as $noteat
    | (if $s != null then [$s.updated, $noteat, (.last_activity | ep)]
       else [(.updated | ep), (.started | ep), (.last_activity | ep), $noteat] end
       | map(select(. != null)) | max) as $last
    | (if $last == null then null else (($now - $last) / 60 | floor) end) as $idle
    | (if (.owner // "") == "" and (.job_id // "") == "" then "unowned"
       elif .owner_kind == "session" and (.owner_id // "") != "" and $s == null and ($ix | length) > 0
            and (((.started | ep) // 0) > ($now - $days * 86400)) then "dead"
       elif $last != null and ($now - $last) >= $stall then "stalled"
       elif $s != null and ($s.busy | not) and (.report == null or .report.reported_by == "owner-fill") then "no-report"
       else "ok" end) as $h
    | {id, status, health: $h, owner_id: (.owner_id // null), last_activity: ($last | iso), idle_min: $idle,
       note: (if $h == "stalled" then "no activity since \($last | hhmm)"
              elif $h == "dead" then "session \(.owner_id) is gone"
              elif $h == "unowned" then "running with no owner and no job"
              elif $h == "no-report" then "session idle, node not reported"
              else null end),
       _session: (if .owner_kind == "session" and ((.owner_id // "") | startswith("ses_")) then .owner_id else null end),
       _due: (if $h == "ok" or $h == "no-report" then (if $last == null then null else $last + $stall end) else null end)}] as $rn
| [$waiting[] | . as $w | {id, status: "waiting", health: (if .needs != null then "needs-user" elif .hold != null then "held" else "ok" end), owner_id: null, last_activity: null, idle_min: null,
    note: (if .needs != null then "needs the user: \(.needs)" elif .hold != null then "held: \(.hold)" elif .ready then "ready"
           else "waiting on " + (([.deps[] | select($st[.] != "done")]
             + (if .gate then [$r.nodes[] | select(.id != $w.id and ((.after_all // false) | not) and (.status | IN("done", "skipped") | not)) | .id] else [] end))
             | unique | join(",")) end)}] as $wn
| ((if ($P | length) == 0 then [] else
    [$r.nodes[] | select(($pn[.id].status // "") | IN("running", "waiting")) | select(.status | IN("done", "error", "skipped"))
      | {kind: "finished", node: .id, from: $pn[.id].status, to: .status, note: "\(.id) \(.status)"}]
  end)
  + ([$ready[] | select(. as $i | ($P.ready // []) | index($i) | not)]
     | if length > 0 then [{kind: "ready", node: null, from: null, to: null, note: ("ready: " + join(","))}] else [] end)
  + [$rn[] | select(.health != "ok" and (($pn[.id].health // "ok") != .health))
      | {kind: .health, node: .id, from: ($pn[.id].health // "ok"), to: .health, note: "\(.id) \(.health): \(.note)"}]
  + [$rn[] | select(.health == "ok" and (($pn[.id].health // "ok") != "ok"))
      | {kind: "recovered", node: .id, from: $pn[.id].health, to: "ok", note: "\(.id) recovered"}]) as $changes
| ($P._nudged // {}) as $nudged
| {run: $run, status: $r.status, at: ($now | iso), max_parallel: $maxp, running: $running, slots: $slots,
   nodes: ([$rn[] | del(._session, ._due)] + $wn), ready: $ready, changes: $changes,
   _nodes: (($rn | map({key: .id, value: .health}) | from_entries) as $hm
            | $r.nodes | map({key: .id, value: {status, health: ($hm[.id] // null)}}) | from_entries),
   _nudge: [$rn[] | select(.health == "stalled" and ._session != null and ($now - ($nudged[.id] // 0)) >= $gap)
            | {node: .id, session: ._session,
               text: "You stopped mid-task at \(.last_activity | ep | hhmm). Continue the task to completion and reply only with the final report."}],
   _nudged: $nudged,
   _due: ([($rn[]._due | select(. != null)),
           ($rn[] | select(.health == "stalled" and ._session != null and $nudged[.id] != null) | $nudged[.id] + $gap)] | min)}
'

HEALTH_FULL_PASS_SECS=300

# health_key <files...> - "mtime:size" of each file in one stat call: the skip key of a pass.
health_key() {
  case "${OSTYPE:-}" in
    darwin*|*bsd*) stat -f '%m:%z' "$@" 2>/dev/null ;;
    *) stat -c '%Y:%s' "$@" 2>/dev/null ;;
  esac | tr '\n' ' '
}

# health_pass <run> <nudge 0|1> - prints the snapshot line (report + private fields) and saves it.
# Skips the jq pass when state.json and the session index are unchanged and no quiet node can have
# crossed the stall threshold since the last pass; then the saved report is reused with no changes.
health_pass() {
  local run_id="$1" nudge="$2" file dir snap keyf idx key now stall_min line due prev_key prev_due sent=""
  file=$(run_state_file "$run_id")
  dir=$(health_dir)
  mkdir -p "$dir" 2>/dev/null
  snap="$dir/$run_id.json"; keyf="$dir/$run_id.key"
  idx=$(owner_session_index_file 2>/dev/null) || idx=""
  [ -n "$idx" ] && [ -f "$idx" ] || { idx="$dir/.empty-index.json"; [ -f "$idx" ] || printf '[]\n' > "$idx"; }
  now=$(date +%s)
  key=$(health_key "$file" "$idx" "$(run_events_file "$run_id")")
  stall_min="${ORCH_STALL_MIN:-$(setting_get stall_minutes "$HEALTH_STALL_MIN_DEFAULT")}"
  is_uint "$stall_min" || stall_min=$HEALTH_STALL_MIN_DEFAULT
  key="$key$stall_min ${ORCH_HEALTH_NUDGE_GAP_SECS:-$HEALTH_NUDGE_GAP_SECS}"
  if [ -f "$snap" ] && [ -f "$keyf" ]; then
    IFS=$'\t' read -r prev_key prev_due prev_at < "$keyf"
    if [ "$prev_key" = "$key" ] && [ $((now - ${prev_at:-0})) -lt "$HEALTH_FULL_PASS_SECS" ] \
      && { [ -z "$prev_due" ] || [ "$prev_due" = null ] || [ "$now" -lt "${prev_due%.*}" ]; }; then
      if [ "$nudge" = 0 ] || ! grep -q '"_nudge":\[{' "$snap"; then
        jq -c '.changes = [] | del(.nudged)' "$snap"
        return 0
      fi
    fi
  fi
  line=$(jq -c --arg run "$run_id" --argjson now "$now" --argjson stall "$((stall_min * 60))" \
    --argjson gap "${ORCH_HEALTH_NUDGE_GAP_SECS:-$HEALTH_NUDGE_GAP_SECS}" --argjson days "$HEALTH_INDEX_DAYS" \
    --slurpfile idx "$idx" --slurpfile prev "$([ -f "$snap" ] && printf '%s' "$snap" || printf /dev/null)" \
    --slurpfile prof "$([ -f "$PROFILES_FILE" ] && printf '%s' "$PROFILES_FILE" || printf /dev/null)" \
    "$HEALTH_JQ" "$file") || return 1
  if [ "$nudge" = 1 ] && [[ $line == *'"_nudge":[{'* ]]; then
    sent=$(health_send_nudges "$run_id" "$line")
    [ -z "$sent" ] || line=$(printf '%s' "$line" | jq -c --argjson now "$now" --arg sent "$sent" \
      '($sent | split(",")) as $s | ._nudged += ($s | map({key: ., value: $now}) | from_entries)
       | .nudged = $s | ._nudge |= map(select(.node as $n | $s | index($n) | not))')
  fi
  if [[ $line == *'"changes":[{'* ]]; then health_record_changes "$run_id" "$line"; fi
  printf '%s\n' "$line" > "$snap.tmp.$$" && mv -f "$snap.tmp.$$" "$snap"
  due=null
  [[ $line =~ \"_due\":([0-9.]+) ]] && due="${BASH_REMATCH[1]}"
  # Our own events moved events.jsonl, so the key is taken again after them.
  [[ $line != *'"changes":[{'* ]] && [ -z "$sent" ] || key="$(health_key "$file" "$idx" "$(run_events_file "$run_id")")$stall_min ${ORCH_HEALTH_NUDGE_GAP_SECS:-$HEALTH_NUDGE_GAP_SECS}"
  printf '%s\t%s\t%s\n' "$key" "$due" "$now" > "$keyf"
  printf '%s\n' "$line"
}

# One run event per change, by "health" — the coordinator and the activity feed see only changes.
health_record_changes() {
  local run_id="$1" kind node from to note
  while IFS=$'\t' read -r kind node from to note; do
    [ -n "$kind" ] || continue
    ORCH_EVENT_BY=$HEALTH_BY run_event "$run_id" health "${node#-}" "${from#-}" "${to#-}" "$note"
  done <<EOF
$(printf '%s' "$2" | jq -r '.changes[] | [.kind, (.node // "-"), (.from // "-"), (.to // "-"), .note] | @tsv')
EOF
}

# health_send_nudges <run> <line> - posts the nudge to each stalled opencode session; prints the
# comma-joined node ids that were sent. Each send is a node event (kind nudge).
health_send_nudges() {
  local run_id="$1" bin node session text body out sent=""
  bin=$(harness_find_binary opencode 2>/dev/null) || { printf 'health: opencode not found, no nudge sent\n' >&2; return 0; }
  while IFS=$'\t' read -r node session text; do
    [ -n "$node" ] || continue
    body=$(jq -nc --arg t "$text" '{text: $t, delivery: "queue"}')
    if out=$(owner_run_timeout "${ORCH_OWNER_CALL_TIMEOUT:-5}" "$bin" api POST "/api/session/$session/prompt" --data "$body" 2>&1 </dev/null); then
      ORCH_EVENT_BY=$HEALTH_BY run_event "$run_id" nudge "$node" "" "" "nudged $session: $text"
      printf 'health: nudged %s (%s)\n' "$node" "$session" >&2
      sent="$sent${sent:+,}$node"
    else
      printf 'health: nudge %s (%s) failed: %s\n' "$node" "$session" "$(printf '%s' "$out" | head -c 200)" >&2
    fi
  done <<EOF
$(printf '%s' "$2" | jq -r '._nudge[] | [.node, .session, .text] | @tsv')
EOF
  printf '%s' "$sent"
}

health_render_text() {
  jq -r '
    "run \(.run) [\(.status)]: running \(.running)/\(.max_parallel), slots \(.slots)",
    "ready: \(.ready | join(","))",
    (.nodes[] | select(.health != "ok") | "\(.health): \(.id)\(if .owner_id then " (" + .owner_id + ")" else "" end) — \(.note)"),
    (if (.changes | length) > 0 then "changes: " + ([.changes[].note] | join("; ")) else empty end),
    (if (.nudged // []) | length > 0 then "nudged: " + (.nudged | join(",")) else empty end),
    (if (._nudge | length) > 0 and ((.nudged // null) == null) then "would nudge (pass --nudge): " + ([._nudge[].node] | join(",")) else empty end)'
}

# --- the per-run monitor ------------------------------------------------------------------------

health_monitor_name() { printf 'health:%s\n' "$1"; }

# Prints "<watch-id>" of the live monitor of a run, nothing when there is none.
health_monitor_find() {
  local name spec dir id
  name=$(health_monitor_name "$1")
  for spec in "$WATCHES_HOME"/*/spec.json; do
    [ -f "$spec" ] || continue
    grep -q "\"name\": *\"$name\"" "$spec" 2>/dev/null || continue
    dir="${spec%/spec.json}"; id="${dir##*/}"
    [ "$(watch_alive_status "$id")" = running ] && { printf '%s\n' "$id"; return 0; }
  done
  return 1
}

# Single-flight per run: run start's auto-start, --ensure-monitors from the server and a second CLI
# call can race between find and start, which left two monitors on one run.
health_monitor_start() {
  local run_id="$1" lock="health-monitor-$1" tries=0 rc
  while ! orch_lock_acquire "$lock"; do
    tries=$((tries + 1)); [ "$tries" -lt 50 ] || return 1; sleep 0.1
  done
  health_monitor_start_locked "$run_id"; rc=$?
  orch_lock_release "$lock"
  return $rc
}

health_monitor_start_locked() {
  local run_id="$1" every cmd id
  health_monitor_find "$run_id" && return 0
  every=$(health_every_sec)
  cmd="HARNESS_ORCH_HOME='$ORCH_HOME' ORCH_NO_ANNOUNCE=1 ORCH_EVENT_BY=$HEALTH_BY bash '$SELF_REAL' run health '$run_id' --monitor"
  id=$(WATCH_MAX_ACTIVE=100000 cmd_watch_start --name "$(health_monitor_name "$run_id")" "$cmd" --every "${every}s" \
    --until '^health: run .* ended' --max-runtime "$HEALTH_MONITOR_RUNTIME" 2>/dev/null) || return 1
  ORCH_EVENT_BY=$HEALTH_BY run_event "$run_id" health "" "" "" "monitor started ($id, every ${every}s)"
  printf '%s\n' "$id"
}

# Auto-start at run creation: ORCH_HEALTH_MONITOR=1 forces, 0 disables; by default on, except for
# callers that set ORCH_NO_ANNOUNCE=1 (the dashboard server and the test suites).
health_monitor_autostart() {
  local run_id="$1"
  case "${ORCH_HEALTH_MONITOR:-}" in
    0|false|off) return 0 ;;
    1|true|on) ;;
    *) [ "${ORCH_NO_ANNOUNCE:-}" != 1 ] || return 0 ;;
  esac
  [ -n "$run_id" ] && [ -f "$(run_state_file "$run_id")" ] || return 0
  health_monitor_start "$run_id" >/dev/null 2>&1 || true
}

health_ensure_monitors() {
  local run_id id
  while IFS= read -r run_id; do
    [ -n "$run_id" ] || continue
    health_monitor_find "$run_id" >/dev/null && continue
    id=$(health_monitor_start "$run_id") && printf 'started %s for %s\n' "$id" "$run_id"
  done <<EOF
$(health_running_runs)
EOF
}

# Running run ids in one jq over every state.json. jq stops at a corrupt file, which hid every run
# after it; on a failure each file is read alone and the bad one is skipped.
health_running_runs() {
  local files=() f filter='select(.status == "running" and ((.run_id // "") | startswith("loop-") | not)) | .run_id' out
  for f in "$RUNS_HOME"/*/state.json; do [ -f "$f" ] && files+=("$f"); done
  [ "${#files[@]}" -gt 0 ] || return 0
  if out=$(jq -r "$filter" "${files[@]}" 2>/dev/null); then printf '%s\n' "$out"; return 0; fi
  for f in "${files[@]}"; do jq -r "$filter" "$f" 2>/dev/null; done
  return 0
}

# One monitor tick: prints change lines only (the watch emits an event when its output changes), and
# "health: run <id> ended" once the run is terminal or gone, which ends the watch (--until).
health_monitor_tick() {
  local run_id="$1" file status nudge=0 line
  file=$(run_state_file "$run_id")
  status=$([ -f "$file" ] && jq -r .status "$file" 2>/dev/null)
  if [ "$status" != running ]; then
    [ -f "$file" ] && ORCH_EVENT_BY=$HEALTH_BY run_event "$run_id" health "" "" "" "monitor stopped (run ${status:-gone})"
    printf 'health: run %s ended (%s)\n' "$run_id" "${status:-gone}"
    return 0
  fi
  [ "$(setting_get auto_nudge true)" = false ] || nudge=1
  line=$(health_pass "$run_id" "$nudge") || return 1
  [[ $line == *'"changes":[{'* ]] || return 0
  printf '%s' "$line" | jq -r '.changes[].note'
}

cmd_run_health() {
  local run_id="" json=0 nudge=0 monitor=0 ensure=0 line
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --nudge) nudge=1 ;;
      --monitor) monitor=1 ;;
      --ensure-monitors) ensure=1 ;;
      -*) printf 'run health: unknown argument %s\n  usage: %s\n' "$1" "$RUN_HEALTH_USAGE" >&2; return 2 ;;
      *) [ -z "$run_id" ] || { printf 'usage: %s\n' "$RUN_HEALTH_USAGE" >&2; return 2; }; run_id="$1" ;;
    esac
    shift
  done
  require_jq "run health"
  if [ "$ensure" = 1 ]; then health_ensure_monitors; [ -n "$run_id" ] || return 0; fi
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_HEALTH_USAGE" >&2; return 2; }
  if [ "$monitor" = 1 ]; then health_monitor_tick "$run_id"; return $?; fi
  run_require "$run_id" >/dev/null || return $?
  line=$(health_pass "$run_id" "$nudge") || return 1
  if [ "$json" = 1 ]; then
    printf '%s' "$line" | jq -c '.would_nudge = [._nudge[].node] | del(._nodes, ._nudged, ._due, ._nudge)'
  else
    printf '%s' "$line" | health_render_text
  fi
}
