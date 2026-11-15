#!/usr/bin/env bash
# Owner liveness: a running node names its owner; this file parses that text, checks the owner
# against reality and moves the node when the owner finished or vanished. Sourced, never executed.

OWNER_CALL_TIMEOUT_DEFAULT=3
OWNER_CACHE_SECS_DEFAULT=20
OWNER_TOTAL_SECS_DEFAULT=5
OWNER_NOTE_CHARS=300
OWNER_BY="owner-liveness"

owners_dir() { printf '%s/owners\n' "$ORCH_HOME"; }

# owner_parse <text> - prints "<kind><TAB><id>". kind: session | process | job | none | unknown.
owner_parse() {
  local text="${1:-}" t lower
  t=$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -z "$t" ]; then printf 'none\t\n'; return 0; fi
  lower=$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')
  if [ "$lower" = coordinator ]; then printf 'none\tcoordinator\n'; return 0; fi
  if [[ "$t" =~ ^(agent[[:space:]:]+)?(ses_[A-Za-z0-9]+)$ ]]; then
    printf 'session\t%s\n' "${BASH_REMATCH[2]}"; return 0
  fi
  if [[ "$lower" =~ ^pid[:[:space:]]+([0-9]+)$ ]]; then
    printf 'process\t%s\n' "${BASH_REMATCH[1]}"; return 0
  fi
  if [ -d "$JOBS_HOME/$t" ]; then printf 'job\t%s\n' "$t"; return 0; fi
  printf 'unknown\t%s\n' "$t"
}

# owner_register <run> <node> - stores owner_kind/owner_id on the node and, for a running node with an
# owner, writes <home>/owners/<id>.json atomically.
owner_register() {
  local run_id="$1" node_id="$2" file owner status kind id
  file=$(run_state_file "$run_id")
  owner=$(node_field "$file" "$node_id" owner)
  status=$(node_field "$file" "$node_id" status)
  [ -n "$owner" ] || return 0
  IFS=$'\t' read -r kind id <<< "$(owner_parse "$owner")"
  owner_write_dispatch_path
  node_patch "$run_id" "$node_id" '.owner_kind = $k | .owner_id = (if $i == "" then null else $i end)' --arg k "$kind" --arg i "$id" || return 1
  if [ "$status" != running ] || [ -z "$id" ]; then return 0; fi
  [ "$kind" = unknown ] || owner_registry_write "$run_id" "$node_id" "$id"
  # The text often carries a real id after other words ("agent ses_x (spawned)"): bind it right away.
  [ "$kind" != unknown ] || owner_bind_literal "$run_id" "$node_id" "$owner" || true
}

owner_safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

# owner_registry_write <run> <node> <id> - <home>/owners/<id>.json, atomically.
owner_registry_write() {
  local dir safe tmp
  dir=$(owners_dir)
  mkdir -p "$dir" || return 0
  safe=$(owner_safe "$3")
  tmp="$dir/.$safe.tmp.$$"
  jq -nc --arg run "$1" --arg node "$2" --arg since "$(now_iso)" '{run: $run, node: $node, since: $since}' > "$tmp" \
    && mv -f "$tmp" "$dir/$safe.json"
}

# owner_run_timeout <secs> <cmd...> - exit 124 when the command ran past the limit.
owner_run_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  perl -e 'my $s = shift; my $pid = fork(); if (!$pid) { exec @ARGV or exit 127 } $SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; alarm $s; waitpid($pid, 0); exit($? >> 8)' "$secs" "$@"
}

# owner_session_messages <session-id> <limit> <timeout> - raw JSON of the newest messages on stdout.
# Exit 0 ok, 3 session not found, 1 unreachable or error. The one call verify-owners and the
# activity endpoint both use.
owner_session_messages() {
  local id="$1" limit="$2" tmo="$3" bin out rc
  bin=$(harness_find_binary opencode 2>/dev/null) || return 1
  out=$(owner_run_timeout "$tmo" "$bin" api GET "/api/session/$id/message" --param "limit=$limit" --param order=desc 2>&1 </dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$out" | grep -qiE '404|not.?found'; then return 3; fi
    return 1
  fi
  if printf '%s' "$out" | jq -e '(.data | type) != "array" and ((.status // 0) == 404 or ((.error.name // .name // "") | test("NotFound"; "i")))' >/dev/null 2>&1; then
    return 3
  fi
  printf '%s\n' "$out"
}

# owner_probe <kind> <id> <call-timeout> - prints "<state><TAB><note>"; state: alive | finished | gone | unknown.
owner_probe() {
  local kind="$1" id="$2" tmo="$3" out rc st
  case "$kind" in
    process)
      if kill -0 "$id" 2>/dev/null; then printf 'alive\t\n'; else printf 'gone\t\n'; fi ;;
    job)
      st=$(job_status "$id" 2>/dev/null) || { printf 'gone\t\n'; return 0; }
      case "$st" in
        running) printf 'alive\t\n' ;;
        "done exit=0"*) printf 'finished\tjob %s exited 0\n' "$id" ;;
        done*) printf 'gone\tjob %s exited %s\n' "$id" "${st#done }" ;;
        *) printf 'unknown\t\n' ;;
      esac ;;
    session)
      out=$(owner_session_messages "$id" 1 "$tmo")
      rc=$?
      if [ "$rc" -eq 3 ]; then printf 'gone\t\n'; return 0; fi
      if [ "$rc" -ne 0 ]; then printf 'unknown\t\n'; return 0; fi
      printf '%s' "$out" | jq -r --argjson n "$OWNER_NOTE_CHARS" '
        if (.data | type) != "array" then "unknown\t"
        elif (.data | length) == 0 then "unknown\t"
        elif (.data[0].type == "assistant" and (.data[0].time.completed != null)) then
          "finished\t" + (([.data[0] | .. | objects | select(.type == "text") | .text? // empty | strings] | join(" ")
                           | gsub("[\\r\\n\\t]+"; " ") | .[0:$n]))
        else "alive\t" end' 2>/dev/null || printf 'unknown\t\n' ;;
    *) printf 'unknown\t\n' ;;
  esac
}

owner_cache_file() {
  local safe
  safe=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/cache/%s.json\n' "$(owners_dir)" "$safe"
}

# owner_state <kind> <id> <deadline-epoch> - cached for OWNER_CACHE_SECS; prints "<state><TAB><note>".
owner_state() {
  local kind="$1" id="$2" deadline="$3" cache now at ttl tmo left res
  cache=$(owner_cache_file "$kind-$id")
  now=$(date +%s)
  ttl="${ORCH_OWNER_CACHE_SECS:-$OWNER_CACHE_SECS_DEFAULT}"
  if [ -f "$cache" ]; then
    at=$(jq -r '.at // 0' "$cache" 2>/dev/null || printf 0)
    if [ $((now - at)) -lt "$ttl" ]; then
      jq -r '"\(.state)\t\(.note // "")"' "$cache" 2>/dev/null && return 0
    fi
  fi
  left=$((deadline - now))
  if [ "$left" -lt 1 ]; then printf 'unknown\t\n'; return 0; fi
  tmo="${ORCH_OWNER_CALL_TIMEOUT:-$OWNER_CALL_TIMEOUT_DEFAULT}"
  [ "$tmo" -le "$left" ] || tmo="$left"
  res=$(owner_probe "$kind" "$id" "$tmo")
  mkdir -p "$(dirname "$cache")" 2>/dev/null
  if [ "${res%%$'\t'*}" != unknown ]; then
    jq -nc --argjson at "$(date +%s)" --arg r "$res" '($r | split("\t")) as $p | {at: $at, state: $p[0], note: ($p[1] // "")}' \
      > "$cache.tmp.$$" 2>/dev/null && mv -f "$cache.tmp.$$" "$cache"
  fi
  printf '%s\n' "$res"
}

# owner_apply_state <run> <node> <alive|finished|gone|failed|unknown> <note> <owner-id> <by> [now]
# The one set of transition rules, shared by verify-owners and `owner event`. Only a running node moves.
owner_apply_state() {
  local run_id="$1" node="$2" state="$3" note="$4" id="$5" by="$6" now="${7:-$(now_iso)}"
  case "$state" in
    finished)
      ORCH_EVENT_BY=$by node_set_status "$run_id" "$node" done || true
      node_patch "$run_id" "$node" \
        '.auto = true | .unverified = true | .owner_state = "finished" | .owner_checked = $now
         | .report = ((.report // {}) + {reported_by: $by, note: (if $note == "" then "owner finished (no final message)" else $note end), at: $now})' \
        --arg now "$now" --arg note "$note" --arg by "$by" || true ;;
    gone|failed)
      ORCH_EVENT_BY=$by node_set_status "$run_id" "$node" error "" "${note:-owner $id is gone}" || true
      node_patch "$run_id" "$node" '.owner_state = "gone" | .owner_checked = $now' --arg now "$now" || true ;;
    alive)
      node_patch "$run_id" "$node" '.updated = $now | .owner_state = "alive" | .owner_checked = $now' --arg now "$now" || true ;;
    *)
      node_patch "$run_id" "$node" '.owner_state = "unknown" | .owner_checked = $now' --arg now "$now" || true ;;
  esac
}

# owners_verify_run <run> <apply 0|1> [deadline] - prints "<node><TAB><owner_state><TAB><note>" per checked node.
owners_verify_run() {
  local run_id="$1" apply="${2:-1}" deadline="${3:-}" file node owner prev kind id state note now
  [ "${ORCH_OWNER_VERIFY:-1}" != 0 ] || return 0
  [ -n "$deadline" ] || deadline=$(( $(date +%s) + ${ORCH_OWNER_TOTAL_SECS:-$OWNER_TOTAL_SECS_DEFAULT} ))
  file=$(run_state_file "$run_id")
  if [ "$apply" = 1 ]; then
    owners_bind_run "$run_id" >/dev/null || true
  fi
  local rows
  rows=$(jq -r '.nodes[] | select(.status == "running" and ((.owner // "") != "")) | "\(.id)\t\(.owner | gsub("[\t\r\n]"; " "))\t\(if (.owner_state // "") == "" then "-" else .owner_state end)\t\(if (.job_id // "") == "" then "-" else .job_id end)"' "$file")
  while IFS=$'\t' read -r node owner prev jobid; do
    [ -n "$node" ] || continue
    [ "$prev" != "-" ] || prev=""
    [ "$jobid" != "-" ] || jobid=""
    IFS=$'\t' read -r kind id <<< "$(owner_parse "$owner")"
    case "$kind" in session|process|job) ;; *) continue ;; esac
    # A node's own dispatched job is settled by `run sync` (exit code, cost); the owner check adds nothing.
    [ "$kind" = job ] && [ "$id" = "$jobid" ] && continue
    IFS=$'\t' read -r state note <<< "$(owner_state "$kind" "$id" "$deadline")"
    now=$(now_iso)
    if [ "$apply" = 1 ]; then
      owner_apply_state "$run_id" "$node" "$state" "$note" "$id" "$OWNER_BY" "$now"
      if [ "$state" != "$prev" ] && { [ "$state" != alive ] || [ -n "$prev" ]; }; then
        ORCH_EVENT_BY=$OWNER_BY run_event "$run_id" owner "$node" "$prev" "$state" "owner $id: $state"
      fi
    fi
    printf '%s\t%s\t%s\n' "$node" "$state" "$note"
  done <<< "$rows"
  [ "$apply" != 1 ] || owners_fill_run "$run_id" "$deadline" >/dev/null || true
}

# owner_report_lines - turns verify rows on stdin into "owner finished: a,b" / "owner gone: c".
owner_report_lines() {
  awk -F'\t' '$2 == "finished" { f = f (f ? "," : "") $1 } $2 == "gone" { g = g (g ? "," : "") $1 }
    END { if (f) print "owner finished: " f; if (g) print "owner gone: " g }'
}

NODE_VERIFY_OWNERS_USAGE='dispatch.sh node verify-owners [<run-id>] [--json] [--no-apply]'

cmd_node_verify_owners() {
  local run_id="" json=0 apply=1 rows="" file ids id deadline
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --no-apply) apply=0 ;;
      -*) printf 'node verify-owners: unknown argument %s\n  usage: %s\n' "$1" "$NODE_VERIFY_OWNERS_USAGE" >&2; return 2 ;;
      *) run_id="$1" ;;
    esac
    shift
  done
  require_jq "node verify-owners"
  if [ -n "$run_id" ]; then
    run_require "$run_id" >/dev/null || return $?
    ids="$run_id"
  else
    ids=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      ids="$ids $(jq -r 'select(.status == "running") | .run_id' "$file")"
    done <<< "$(run_state_files)"
  fi
  deadline=$(( $(date +%s) + ${ORCH_OWNER_TOTAL_SECS:-$OWNER_TOTAL_SECS_DEFAULT} ))
  for id in $ids; do
    rows="$rows$(owners_verify_run "$id" "$apply" "$deadline" | awk -F'\t' -v r="$id" 'BEGIN { OFS = "\t" } { print r, $0 }')"$'\n'
  done
  if [ "$json" = 1 ]; then
    printf '%s' "$rows" | jq -R -s 'split("\n") | map(select(length > 0) | split("\t")
      | {run: .[0], node: .[1], owner_state: .[2], note: (.[3] // "")})'
    return 0
  fi
  printf '%s' "$rows" | awk -F'\t' 'NF { printf "%s %s: owner %s%s\n", $1, $2, $3, ($4 != "" ? " - " $4 : "") }'
}

NODE_ACTIVITY_USAGE='dispatch.sh node activity <run-id> <node-id> [--limit N]'

# Raw newest messages of the node's owner session as JSON; exit 4 = no checkable owner, 3 = gone, 1 = unreachable.
cmd_node_activity() {
  local run_id="${1:-}" node_id="${2:-}" limit=20 file owner kind id
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then printf 'usage: %s\n' "$NODE_ACTIVITY_USAGE" >&2; return 2; fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) shift; limit="${1:-20}" ;;
      *) printf 'node activity: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node activity"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  owner=$(node_field "$file" "$node_id" owner)
  IFS=$'\t' read -r kind id <<< "$(owner_parse "$owner")"
  [ "$kind" = session ] || return 4
  owner_session_messages "$id" "$limit" "${ORCH_OWNER_CALL_TIMEOUT:-$OWNER_CALL_TIMEOUT_DEFAULT}"
}

NODE_BRIEF_USAGE='dispatch.sh node brief <run-id> <node-id>'

cmd_node_brief() {
  local run_id="${1:-}" node_id="${2:-}" file
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then printf 'usage: %s\n' "$NODE_BRIEF_USAGE" >&2; return 2; fi
  require_jq "node brief"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  cat <<EOF2
You are node "$node_id" of orch run "$run_id". Keep the run graph true with these orch commands:
- At least every 5 minutes while you work: orch node ping $run_id $node_id --note "<what you just did>" [--progress 3/10]
- When you know your real model and token numbers: orch node report $run_id $node_id --model <model> --input-tokens N --output-tokens N --note "<summary>"
- When the work is finished AND verified (tests ran, output read): orch node update $run_id $node_id done
- On failure: orch node update $run_id $node_id error --error "<reason>"
Rules: never redirect a command to /dev/null (no >/dev/null, no 2>/dev/null). Read the result of every orch command. Never mark done before you verified the work.
EOF2
}

owner_write_dispatch_path() {
  local tmp="$ORCH_HOME/.dispatch-path.tmp.$$"
  mkdir -p "$ORCH_HOME" 2>/dev/null || return 0
  printf '%s\n' "$SELF_REAL" > "$tmp" 2>/dev/null && mv -f "$tmp" "$ORCH_HOME/.dispatch-path" 2>/dev/null
  return 0
}

OWNER_EVENT_USAGE='dispatch.sh owner event <session-id> <started|alive|finished|failed> [--note "text"] [--harness opencode|claude]'
OWNER_HEARTBEAT_DEBOUNCE_SECS=20

# owner event: harness-neutral push from a plugin or hook. Unknown ids are ignored; never fails the caller.
cmd_owner_event() {
  [ "${1:-}" = event ] && shift
  local sid="${1:-}" kind="${2:-}" note="" harness="unknown" reg run_id node file status safe last now
  [ -n "$sid" ] && [ -n "$kind" ] || { printf 'usage: %s\n' "$OWNER_EVENT_USAGE" >&2; return 2; }
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) shift; note="${1:-}" ;;
      --harness) shift; harness="${1:-unknown}" ;;
      *) shift; continue ;;
    esac
    shift
  done
  safe=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9._-' '_')
  reg="$ORCH_HOME/owners/$safe.json"
  [ -f "$reg" ] || return 0
  run_id=$(jq -r '.run // empty' "$reg" 2>/dev/null) || return 0
  node=$(jq -r '.node // empty' "$reg" 2>/dev/null) || return 0
  file=$(run_state_file "$run_id" 2>/dev/null)
  [ -n "$run_id" ] && [ -n "$node" ] && [ -f "$file" ] || return 0
  status=$(node_field "$file" "$node" status)
  now=$(now_iso)
  case "$kind" in
    started)
      if [ "$status" = waiting ]; then
        ORCH_EVENT_BY="owner-event:$harness" NODE_OWNER="$sid" node_set_status "$run_id" "$node" running || true
      fi ;;
    alive)
      [ "$status" = running ] || return 0
      last=$(node_field "$file" "$node" owner_checked)
      if [ -n "$last" ] && last=$(to_epoch_iso "$last" 2>/dev/null) && [ $(( $(date -u +%s) - last )) -lt "$OWNER_HEARTBEAT_DEBOUNCE_SECS" ]; then return 0; fi
      owner_apply_state "$run_id" "$node" alive "" "$sid" "owner-event:$harness" "$now" ;;
    finished|failed)
      [ "$status" = running ] || return 0
      owner_apply_state "$run_id" "$node" "$kind" "$note" "$sid" "owner-event:$harness" "$now" ;;
    *) printf 'owner event: unknown kind %s\n' "$kind" >&2; return 2 ;;
  esac
  return 0
}

# --- owner binder: find the real session behind a free-text owner, then fill what the session knows ---

OWNER_BIND_BEFORE_SECS_DEFAULT=60
OWNER_BIND_AFTER_SECS_DEFAULT=180
OWNER_BIND_TIE_SECS=3
OWNER_UNOWNED_SECS_DEFAULT=120
OWNER_FILL_MAX_NODES=5
OWNER_THROTTLE_SECS_DEFAULT=20

# owner_throttle <key> <ttl> - 0 (and stamps) when the last pass for the key is older than ttl.
owner_throttle() {
  local f at
  f="$(owners_dir)/cache/throttle-$(owner_safe "$1")"
  at=$(file_mtime "$f" 2>/dev/null || printf 0)
  [ -n "$at" ] || at=0
  [ $(( $(date +%s) - at )) -ge "$2" ] || return 1
  mkdir -p "$(dirname "$f")" 2>/dev/null
  : > "$f" 2>/dev/null
  return 0
}

# owner_literal_id <text> - "<kind><TAB><id>" for a session id, claude uuid or pid inside free text; none otherwise.
owner_literal_id() {
  local t="$1" lower uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  lower=$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')
  if [[ "$t" =~ (ses_[A-Za-z0-9]+) ]]; then printf 'session\t%s\n'  "${BASH_REMATCH[1]}"; return 0; fi
  if [[ "$lower" =~ ($uuid) ]]; then printf 'claude\t%s\n' "${BASH_REMATCH[1]}"; return 0; fi
  if [[ "$lower" =~ (^|[^a-z])pid[:[:space:]-]*([0-9]+) ]]; then printf 'process\t%s\n' "${BASH_REMATCH[2]}"; return 0; fi
  printf 'none\t\n'
}

# owner_bind_apply <run> <node> <kind> <id> <how>
owner_bind_apply() {
  local run_id="$1" node="$2" kind="$3" id="$4" how="$5"
  node_patch "$run_id" "$node" \
    '.owner_kind = $k | .owner_id = $i | .owner_bind = $how | .owner_reason = null | .unowned = null
     | (if .owner_state == "unbound" then .owner_state = null else . end)
     | (if ((.owner // "") == "") then .owner = ("agent " + $i) else . end)' \
    --arg k "$kind" --arg i "$id" --arg how "$how" || return 1
  owner_registry_write "$run_id" "$node" "$id"
  ORCH_EVENT_BY=owner-binder run_event "$run_id" owner "$node" "" bound "owner $id bound ($how)"
}

# owner_bind_literal <run> <node> <text> - step (a). Returns 0 when it bound.
owner_bind_literal() {
  local kind id
  IFS=$'\t' read -r kind id <<< "$(owner_literal_id "$3")"
  [ "$kind" != none ] || return 1
  owner_bind_apply "$1" "$2" "$kind" "$id" literal
}

# owner_mark_unbound <run> <node> <reason> - the node says why; one event per changed reason.
owner_mark_unbound() {
  local run_id="$1" node="$2" reason="$3" prev
  prev=$(node_field "$(run_state_file "$run_id")" "$node" owner_reason)
  [ "$prev" != "$reason" ] || return 0
  node_patch "$run_id" "$node" \
    '.owner_state = "unbound" | .owner_reason = $r | .owner_checked = $now
     | (if (.owner_kind == null or .owner_kind == "unknown") then .owner_kind = "unbound" else . end)' \
    --arg r "$reason" --arg now "$(now_iso)" || return 1
  ORCH_EVENT_BY=owner-binder run_event "$run_id" owner "$node" "" unbound "$reason"
}

# owner_bind_match <nodes-json> <node-id> <cands-json> - prints {child,how} or {reason}. Never guesses on a tie.
owner_bind_match() {
  jq -nc --argjson nodes "$1" --arg id "$2" --argjson cands "$3" \
    --argjson before "${ORCH_BIND_BEFORE_SECS:-$OWNER_BIND_BEFORE_SECS_DEFAULT}" \
    --argjson after "${ORCH_BIND_AFTER_SECS:-$OWNER_BIND_AFTER_SECS_DEFAULT}" --argjson tie "$OWNER_BIND_TIE_SECS" '
    def stop: ["the","and","for","with","from","that","this","node","agent","task","run","spawned","ses"];
    def toks: ascii_downcase | [scan("[a-z0-9]{3,}")] | map(select(. as $w | stop | index($w) | not)) | unique;
    def score($n): (.title | toks) as $t | ($n.text | toks) as $x | [$t[] | select(. as $w | any($x[]; . == $w))] | length;
    ($nodes | map(select(.id == $id)) | .[0]) as $n
    | ($nodes | map(select(.id != $id))) as $others
    | [ $cands[] | . as $c | ($c.created - $n.start) as $d
        | select($d >= (-$before) and $d <= $after)
        | {child: $c.child, created: $c.created, ad: ($d | fabs), s: ($c | score($n)),
           os: ([$others[] | . as $o | ($c | score($o))] | max // 0)}
        | select(.s >= .os) ] as $e
    | if ($e | length) == 0 then {reason: "no child session found near the node start"}
      else ($e | map(.s) | max) as $top
        | if $top > 0 then
            ($e | map(select(.s == $top))) as $t
            | if ($t | length) == 1 then {child: $t[0].child, how: "title"}
              else {reason: ("tie on title between " + ($t | map(.child) | join(", ")))} end
          else
            ($e | sort_by(.ad)) as $s
            | if ($s | length) > 1 and ($s[1].ad - $s[0].ad) < $tie then
                {reason: ("tie on time between " + ($s | map(.child) | join(", ")))}
              elif ([$others[] | select((($s[0].created - .start) | fabs) <= $s[0].ad + $tie)] | length) > 0 then
                {reason: ("candidate " + $s[0].child + " also fits node " + ([$others[] | select((($s[0].created - .start) | fabs) <= $s[0].ad + $tie) | .id] | join(", ")))}
              else {child: $s[0].child, how: "time"} end
          end
      end'
}

# owner_pending_cands <parent> - plugin-written candidates for one parent, untaken, as a JSON array.
owner_pending_cands() {
  local dir f out="[]" safe now
  dir="$(owners_dir)/pending"
  [ -d "$dir" ] || { printf '[]\n'; return 0; }
  now=$(date +%s)
  for f in "$dir"/*.json; do
    [ -f "$f" ] || continue
    [ $((now - $(file_mtime "$f" 2>/dev/null || printf 0))) -lt 86400 ] || continue
    safe=$(basename "$f" .json)
    [ ! -f "$(owners_dir)/$safe.json" ] || continue
    out=$(jq -c --argjson acc "$out" --arg p "$1" 'if .parent == $p and (.child // "") != ""
      then $acc + [{child, title: (.title // ""), created: (if .created_ms != null then .created_ms / 1000 else ((.created // "") | try fromdateiso8601 catch 0) end)}]
      else $acc end' "$f" 2>/dev/null || printf '%s' "$out")
  done
  printf '%s\n' "$out"
}

# owner_children_cands <parent> - opencode's children of a session as a JSON array; exit 1 when unreachable.
owner_children_cands() {
  local bin out
  bin=$(harness_find_binary opencode 2>/dev/null) || return 1
  out=$(owner_run_timeout "${ORCH_OWNER_CALL_TIMEOUT:-$OWNER_CALL_TIMEOUT_DEFAULT}" "$bin" api GET /api/session \
    --param "parentID=$1" --param limit=100 2>/dev/null </dev/null) || return 1
  printf '%s' "$out" | jq -c --arg p "$1" '[.data[]? | select(.parentID == $p and (.id // "") != "")
    | {child: .id, title: (.title // ""), created: ((.time.created // 0) / 1000)}]' 2>/dev/null
}

# owners_bind_run <run> - prints "<node><TAB><result>" per node it looked at.
owners_bind_run() {
  local run_id="$1" file rows node owner jobid kind id nodes_json need=() left=() parent cands res child how why n reason started_epoch age
  [ "${ORCH_OWNER_BIND:-1}" != 0 ] || return 0
  file=$(run_state_file "$run_id")
  [ -f "$file" ] || return 0
  rows=$(jq -r '.nodes[] | select(.status == "running" and ((.job_id // "") == "") and ((.owner // "") != "coordinator"))
    | "\(.id)\t\(if (.owner // "") == "" then "-" else (.owner | gsub("[\t\r\n]"; " ")) end)\t\(if (.owner_id // "") == "" then "-" else .owner_id end)"' "$file")
  while IFS=$'\t' read -r node owner id; do
    [ -n "$node" ] || continue
    [ "$owner" != "-" ] || owner=""
    [ "$id" != "-" ] || id=""
    [ -z "$id" ] || [ ! -f "$(owners_dir)/$(owner_safe "$id").json" ] || continue
    IFS=$'\t' read -r kind id <<< "$(owner_parse "$owner")"
    [ "$kind" != job ] || continue
    if [ -n "$owner" ] && owner_bind_literal "$run_id" "$node" "$owner"; then
      printf '%s\tbound (literal)\n' "$node"; continue
    fi
    need+=("$node")
  done <<< "$rows"
  [ ${#need[@]} -gt 0 ] || return 0
  parent=$(jq -r '.harness_session // ""' "$file")
  nodes_json=$(jq -c --argjson want "$(printf '%s\n' "${need[@]}" | jq -R . | jq -sc .)" '
    [.nodes[] | select(.id as $i | $want | index($i))
     | {id, text: ([.label, .id, (.owner // ""), (.report.note // ""), ((.notes // []) | map(.text) | join(" "))] | map(. // "") | join(" ")),
        start: (try ((.started // .updated // .created) | fromdateiso8601) catch 0)}]' "$file")
  local pend="[]" kids="[]" kids_loaded=0 kids_ok=1 pend_n
  [ -z "$parent" ] || pend=$(owner_pending_cands "$parent")
  pend_n=$(printf '%s' "$pend" | jq 'length')
  for node in "${need[@]}"; do
    owner_throttle "bind-$run_id-$node" "${ORCH_OWNER_BIND_SECS:-$OWNER_THROTTLE_SECS_DEFAULT}" || continue
    res=$(owner_bind_match "$nodes_json" "$node" "$pend")
    child=$(printf '%s' "$res" | jq -r '.child // empty')
    how=$(printf '%s' "$res" | jq -r '.how // empty')
    why=$(printf '%s' "$res" | jq -r '.reason // empty')
    if [ -z "$child" ] && [ "$pend_n" = 0 ] && [[ "$parent" == ses_* ]]; then
      if [ "$kids_loaded" = 0 ]; then
        kids_loaded=1
        kids=$(owner_children_cands "$parent") || { kids="[]"; kids_ok=0; }
        kids=$(printf '%s' "$kids" | jq -c --argjson taken "$(for f in "$(owners_dir)"/ses_*.json; do [ -f "$f" ] && basename "$f" .json; done | jq -R . | jq -sc .)" \
          'map(select(.child as $c | $taken | index($c) | not))')
      fi
      res=$(owner_bind_match "$nodes_json" "$node" "$kids")
      child=$(printf '%s' "$res" | jq -r '.child // empty')
      how=$(printf '%s' "$res" | jq -r '.how // empty')
      [ -z "$how" ] || how="listing-$how"
      why=$(printf '%s' "$res" | jq -r '.reason // empty')
      [ "$kids_ok" = 1 ] || why="opencode session listing unavailable"
    elif [ -z "$child" ] && [[ "$parent" != ses_* ]]; then
      why="${why:+$why; }run harness session '${parent:-none}' is not an opencode session"
    fi
    if [ -n "$child" ]; then
      owner_bind_apply "$run_id" "$node" session "$child" "${how:-time}" || continue
      pend=$(printf '%s' "$pend" | jq -c --arg c "$child" 'map(select(.child != $c))')
      kids=$(printf '%s' "$kids" | jq -c --arg c "$child" 'map(select(.child != $c))')
      nodes_json=$(printf '%s' "$nodes_json" | jq -c --arg n "$node" 'map(select(.id != $n))')
      printf '%s\tbound %s (%s)\n' "$node" "$child" "$how"
      continue
    fi
    owner=$(node_field "$file" "$node" owner)
    started_epoch=$(to_epoch_iso "$(node_field "$file" "$node" started)" 2>/dev/null || printf 0)
    age=$(( $(date -u +%s) - ${started_epoch:-0} ))
    if [ -z "$owner" ] && [ "$age" -ge "${ORCH_UNOWNED_SECS:-$OWNER_UNOWNED_SECS_DEFAULT}" ]; then
      if [ "$(node_field "$file" "$node" unowned)" != true ]; then
        node_patch "$run_id" "$node" '.unowned = true | .owner_state = "unbound" | .owner_reason = $r' \
          --arg r "running without an owner for $((age / 60)) min; ${why:-no session found}" || true
        ORCH_EVENT_BY=owner-binder run_event "$run_id" owner "$node" "" unowned "running without an owner"
      fi
      printf '%s\tunowned\n' "$node"
    elif [ -n "$owner" ]; then
      owner_mark_unbound "$run_id" "$node" "owner \"$owner\" names no session id; ${why:-no session found}" || true
      printf '%s\tunbound: %s\n' "$node" "$why"
    fi
  done
}

# owners_fill_run <run> - fills EMPTY node fields from the bound owner session (opencode); at most 5 nodes.
owners_fill_run() {
  local run_id="$1" deadline="${2:-}" file rows node id left out n=0 model tokens_in tokens_out usd created updated cur_model have_tok have_usd harness last tmo
  [ "${ORCH_OWNER_FILL:-1}" != 0 ] || return 0
  file=$(run_state_file "$run_id")
  [ -f "$file" ] || return 0
  rows=$(jq -r '.nodes[] | select(.status == "running" and .owner_kind == "session" and (.owner_id // "") != "")
    | "\(.id)\t\(.owner_id)\t\((((.model // .report.model) // "") != "") | tostring)\t\(((.report.input_tokens != null) or (.report.output_tokens != null) or ((.usage // {}) | length > 0)) | tostring)\t\(((.report.usd != null) or (.cost != null)) | tostring)\t\((.harness // "") != "" | tostring)\t\(.last_activity // "")"' "$file")
  tmo="${ORCH_OWNER_CALL_TIMEOUT:-$OWNER_CALL_TIMEOUT_DEFAULT}"
  while IFS=$'\t' read -r node id cur_model have_tok have_usd harness last; do
    [ -n "$node" ] || continue
    [ "$n" -lt "$OWNER_FILL_MAX_NODES" ] || break
    [ -z "$deadline" ] || [ "$(date +%s)" -lt "$deadline" ] || break
    owner_throttle "fill-$run_id-$node" "${ORCH_OWNER_BIND_SECS:-$OWNER_THROTTLE_SECS_DEFAULT}" || continue
    n=$((n + 1))
    out=$(owner_session_info "$id" "$tmo") || continue
    IFS=$'\t' read -r model tokens_in tokens_out usd created updated <<< "$(printf '%s' "$out" | jq -r '.data
      | [(.model.id // ""), (.tokens.input // ""), (.tokens.output // ""), (.cost // ""), ((.time.created // 0) / 1000 | floor), ((.time.updated // 0) / 1000 | floor)] | @tsv')"
    local -a args=()
    [ "$cur_model" = false ] && [ -n "$model" ] && args+=(--model "$model")
    [ "$have_tok" = false ] && [ -n "$tokens_in" ] && args+=(--input-tokens "${tokens_in%.*}")
    [ "$have_tok" = false ] && [ -n "$tokens_out" ] && args+=(--output-tokens "${tokens_out%.*}")
    [ "$have_usd" = false ] && [ -n "$usd" ] && args+=(--usd "$usd")
    if [ ${#args[@]} -gt 0 ]; then cmd_node_report "$run_id" "$node" "${args[@]}" >/dev/null || true; fi
    node_patch "$run_id" "$node" \
      '(if (.harness // "") == "" then .harness = "opencode" else . end)
       | (if .started == null and $c != "" then .started = $c else . end)
       | (if $u != "" then .last_activity = $u else . end)' \
      --arg c "$(epoch_to_iso "${created:-0}" 2>/dev/null)" --arg u "$([ "${updated:-0}" -gt 0 ] && epoch_to_iso "$updated")" || true
  done <<< "$rows"
}

# owner_session_info <id> <timeout> - raw JSON of one opencode session; exit 3 not found, 1 unreachable.
owner_session_info() {
  local bin out rc
  bin=$(harness_find_binary opencode 2>/dev/null) || return 1
  out=$(owner_run_timeout "$2" "$bin" api GET "/api/session/$1" 2>&1 </dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then printf '%s' "$out" | grep -qiE '404|not.?found' && return 3; return 1; fi
  printf '%s' "$out" | jq -e '.data | type == "object"' >/dev/null 2>&1 || return 1
  printf '%s\n' "$out"
}

NODE_BIND_OWNERS_USAGE='dispatch.sh node bind-owners [--run <run-id>] [--json]'

cmd_node_bind_owners() {
  local run_id="" json=0 ids id file rows="" out
  while [ $# -gt 0 ]; do
    case "$1" in
      --run) shift; run_id="${1:-}" ;;
      --json) json=1 ;;
      *) printf 'node bind-owners: unknown argument %s\n  usage: %s\n' "$1" "$NODE_BIND_OWNERS_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node bind-owners"
  if [ -n "$run_id" ]; then
    run_require "$run_id" >/dev/null || return $?
    ids="$run_id"
  else
    ids=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      ids="$ids $(jq -r 'select(.status == "running") | .run_id' "$file")"
    done <<< "$(run_state_files)"
  fi
  for id in $ids; do
    out=$(owners_bind_run "$id") || true
    owners_fill_run "$id" || true
    [ -z "$out" ] || rows="$rows$(printf '%s\n' "$out" | awk -F'\t' -v r="$id" 'BEGIN { OFS = "\t" } { print r, $0 }')"$'\n'
  done
  if [ "$json" = 1 ]; then
    printf '%s' "$rows" | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {run: .[0], node: .[1], result: .[2]})'
    return 0
  fi
  printf '%s' "$rows" | awk -F'\t' 'NF { printf "%s %s: %s\n", $1, $2, $3 }'
}
