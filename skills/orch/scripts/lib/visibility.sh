# Visibility: the activity feed, node pings, staleness, `run wait` and `run status`.
# Sourced by dispatch.sh after runs.sh; only defines functions. Every write still goes through
# state_write_raw / node_patch (runs.sh) or appends to runs/<run>/events.jsonl.

NODE_PING_USAGE='dispatch.sh node ping <run-id> <node-id> [--note "text"] [--progress "3/10"]'
RUN_WAIT_USAGE='dispatch.sh run wait <run-id> [--timeout S] [--include-notes]'
RUN_STATUS_USAGE='dispatch.sh run status <run-id> [--json]'
STALE_MINUTES_DEFAULT=10
NODE_NOTES_KEEP=20
RUN_WAIT_POLL_SECS_DEFAULT=2

run_events_file() { printf '%s/%s/events.jsonl\n' "$RUNS_HOME" "$1"; }

# run_event <run> <kind> <node> <from> <to> <note> — one JSON line per mutation. Never fails the caller.
run_event() {
  local run_id="$1" kind="$2" node="${3:-}" from="${4:-}" to="${5:-}" note="${6:-}"
  [ -d "$RUNS_HOME/$run_id" ] || return 0
  jq -nc --arg at "$(now_iso)" --arg kind "$kind" --arg node "$node" --arg from "$from" --arg to "$to" \
    --arg note "$note" --arg by "${ORCH_EVENT_BY:-cli}" \
    '{at: $at, kind: $kind, node: (if $node == "" then null else $node end),
      from: (if $from == "" then null else $from end), to: (if $to == "" then null else $to end),
      note: (if $note == "" then null else $note end), by: $by}' >> "$(run_events_file "$run_id")" 2>/dev/null || true
}

file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# Newest mtime (epoch) of the files under a directory; prints nothing when there are none.
dir_newest_mtime() {
  local dir="$1" f m best=""
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do
    m=$(file_mtime "$f") || continue
    if [ -z "$best" ] || [ "$m" -gt "$best" ]; then best="$m"; fi
  done <<EOF
$(find "$dir" -type f 2>/dev/null)
EOF
  [ -z "$best" ] || printf '%s\n' "$best"
}

# node_last_activity <run> <node> — epoch of the newest sign of life; empty when none.
node_last_activity() {
  local run_id="$1" node="$2" file updated started job best="" cand iso
  file=$(run_state_file "$run_id")
  updated=$(node_field "$file" "$node" updated)
  started=$(node_field "$file" "$node" started)
  job=$(node_field "$file" "$node" job_id)
  for iso in "$updated" "$started"; do
    [ -n "$iso" ] || continue
    cand=$(to_epoch_iso "$iso") || continue
    if [ -z "$best" ] || [ "$cand" -gt "$best" ]; then best="$cand"; fi
  done
  for cand in "$(dir_newest_mtime "$(node_out_dir "$run_id" "$node")")" \
              "$( [ -z "$job" ] || file_mtime "$JOBS_HOME/$job/log" 2>/dev/null )"; do
    [ -n "$cand" ] || continue
    if [ -z "$best" ] || [ "$cand" -gt "$best" ]; then best="$cand"; fi
  done
  [ -z "$best" ] || printf '%s\n' "$best"
}

# newest_mtime <path>... - newest mtime (epoch) of the files under the given paths (files or dirs),
# one find for all of them; prints nothing when there are none.
newest_mtime() {
  local -a have=()
  local p
  for p in "$@"; do [ -n "$p" ] && [ -e "$p" ] && have+=("$p"); done
  [ ${#have[@]} -gt 0 ] || return 0
  { find "${have[@]}" -type f -exec stat -f %m {} + 2>/dev/null || find "${have[@]}" -type f -exec stat -c %Y {} + 2>/dev/null; } \
    | sort -n | tail -n 1
}

# run_activity_rows <run> - one \x1f-separated line per running node (a tab would collapse empty fields): id, last activity epoch (may be empty),
# started (ISO or -), owner (or job id, or -). One jq for the whole state instead of three per
# node; the same rules as node_last_activity.
run_activity_rows() {
  local run_id="$1" file id upd sta job dir started owner last f
  file=$(run_state_file "$run_id")
  while IFS=$'\x1f' read -r id upd sta job dir started owner; do
    [ -n "$id" ] || continue
    last=""
    for f in "$upd" "$sta"; do
      [ -n "$f" ] || continue
      if [ -z "$last" ] || [ "$f" -gt "$last" ]; then last="$f"; fi
    done
    f=$(newest_mtime "$dir" "${job:+$JOBS_HOME/$job/log}")
    if [ -n "$f" ] && { [ -z "$last" ] || [ "$f" -gt "$last" ]; }; then last="$f"; fi
    printf '%s\037%s\037%s\037%s\n' "$id" "$last" "$started" "$owner"
  done <<EOF
$(jq -r --arg runs "$RUNS_HOME" --arg run "$run_id" '
  def ep: if (. // "") == "" then "" else ((try fromdateiso8601 catch "") | tostring) end;
  .nodes[] | select(.status == "running")
  | [.id, (.updated | ep), (.started | ep), (.job_id // ""),
     (if (.out_dir // "") != "" then .out_dir else "\($runs)/\($run)/out/\(.id)" end),
     (.started // "-"), ((.owner // .job_id // "-") | tostring | gsub("[\t\r\n\u001f]"; " "))]
  | map(tostring) | join("\u001f")' "$file")
EOF
}

# run_stale_nodes <run> [rows] - ids of running nodes with no activity for settings.stale_minutes.
run_stale_nodes() {
  local run_id="$1" rows="${2-}" minutes now node last rest out=""
  [ $# -ge 2 ] || rows=$(run_activity_rows "$run_id")
  minutes=$(setting_uint stale_minutes "$STALE_MINUTES_DEFAULT")
  now=$(date -u +%s)
  while IFS=$'\x1f' read -r node last rest; do
    [ -n "$node" ] && [ -n "$last" ] || continue
    case "$last" in *[!0-9]*) continue ;; esac
    [ $((now - last)) -ge $((minutes * 60)) ] && out="$out${out:+,}$node"
  done <<EOF
$rows
EOF
  printf '%s\n' "$out"
}

cmd_node_ping() {
  local run_id="${1:-}" node_id="${2:-}" note="" progress="" file
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_PING_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) shift; note="${1:-}" ;;
      --progress) shift; progress="${1:-}" ;;
      *) printf 'node ping: unknown argument %s\n  usage: %s\n' "$1" "$NODE_PING_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node ping"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  node_patch "$run_id" "$node_id" \
    '.updated = $ts
     | (if $note != "" then .notes = (((.notes // []) + [{at: $ts, text: $note}]) | .[-($keep):]) else . end)
     | (if $progress != "" then .progress = $progress else . end)' \
    --arg ts "$(now_iso)" --arg note "$note" --arg progress "$progress" --argjson keep "$NODE_NOTES_KEEP" || return 1
  if [ -n "$note" ]; then
    run_event "$run_id" note "$node_id" "" "" "$note"
  else
    run_event "$run_id" ping "$node_id" "" "" "$progress"
  fi
}

wait_cursor_file() { printf '%s/%s/wait.cursor\n' "$RUNS_HOME" "$1"; }

# Number of nodes that are running, and waiting with every dependency done.
run_live_counts() {
  jq -r "$NODE_READY_JQ_DEF"'. as $r
    | ([.nodes[] | select(.status == "running")] | length) as $run
    | ([.nodes[] | select(.status == "waiting") | .id as $n
        | select(node_ready($r))]
       | length) as $rdy
    | "\($run) \($rdy)"' "$1"
}

cmd_run_wait() {
  local run_id="${1:-}" timeout=300 notes=0 file cursor n total seen stale new elapsed=0 poll tick=0 counts
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_WAIT_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) shift; timeout="${1:-300}" ;;
      --include-notes) notes=1 ;;
      *) printf 'run wait: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  is_uint "$timeout" || { printf 'run wait: --timeout must be whole seconds\n' >&2; return 2; }
  require_jq "run wait"
  file=$(run_require "$run_id") || return $?
  poll="${ORCH_WAIT_POLL_SECS:-$RUN_WAIT_POLL_SECS_DEFAULT}"
  cursor=$(wait_cursor_file "$run_id")
  if [ -f "$cursor" ]; then
    n=$(jq -r '.n // 0' "$cursor" 2>/dev/null || printf 0)
    seen=$(jq -r '.stale // ""' "$cursor" 2>/dev/null || printf '')
  else
    n=$( [ -f "$(run_events_file "$run_id")" ] && wc -l < "$(run_events_file "$run_id")" | tr -d ' ' || printf 0 )
    seen=""
    jq -nc --argjson n "$n" '{n: $n, stale: ""}' > "$cursor"
  fi
  while :; do
    total=0
    [ -f "$(run_events_file "$run_id")" ] && total=$(wc -l < "$(run_events_file "$run_id")" | tr -d ' ')
    if [ "$total" -gt "$n" ]; then
      new=$(tail -n "+$((n + 1))" "$(run_events_file "$run_id")" | jq -r --argjson notes "$notes" \
        'select(.node != null)
         | if .kind == "status" then "\(.node) \(.from // "-")->\(.to)"
           elif .kind == "owner" then "\(.node) owner \(.to)"
           elif $notes == 1 and (.kind == "note" or .kind == "ping") then "\(.node) note: \(.note // "ping")"
           else empty end')
      n="$total"
      jq -nc --argjson n "$n" --arg s "$seen" '{n: $n, stale: $s}' > "$cursor"
      if [ -n "$new" ]; then printf '%s\n' "$new"; return 0; fi
    fi
    stale=$(run_stale_nodes "$run_id")
    if [ "$stale" != "$seen" ]; then
      new=""
      local s
      for s in $(printf '%s' "$stale" | tr ',' ' '); do
        case ",$seen," in *",$s,"*) ;; *) new="$new$s stale"$'\n' ;; esac
      done
      seen="$stale"
      jq -nc --argjson n "$n" --arg s "$seen" '{n: $n, stale: $s}' > "$cursor"
      if [ -n "$new" ]; then printf '%s' "$new"; return 0; fi
    fi
    counts=$(run_live_counts "$file")
    if [ "$counts" = "0 0" ]; then
      printf 'settled: no running or ready nodes\n'
      return 3
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      printf 'run wait: timed out after %ss (no changes)\n' "$timeout" >&2
      return 124
    fi
    tick=$((tick + 1))
    if [ $((tick % 3)) -eq 0 ]; then cmd_run_sync "$run_id" --no-retry >/dev/null 2>&1 || true; fi
    sleep "$poll"
    elapsed=$((elapsed + poll))
  done
}

fmt_age() {
  local s="$1"
  [ "$s" -ge 0 ] 2>/dev/null || s=0
  if [ "$s" -lt 60 ]; then printf '%ss' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%sm' $((s / 60))
  else printf '%sh%sm' $((s / 3600)) $((s % 3600 / 60)); fi
}

run_link() {
  local port
  port=$(cat "$SERVE_PORT_FILE" 2>/dev/null || printf '%s' "$SERVE_DEFAULT_PORT")
  printf 'http://127.0.0.1:%s/#/run/%s\n' "$port" "$1"
}

cmd_run_status() {
  local run_id="${1:-}" json=0 owner_lines file now stale rows=""
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_STATUS_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      *) printf 'run status: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run status"
  file=$(run_require "$run_id") || return $?
  owner_lines=$(owners_verify_run "$run_id" 1 | owner_report_lines)
  now=$(date -u +%s)
  rows=$(run_activity_rows "$run_id")
  stale=$(run_stale_nodes "$run_id" "$rows")
  local summary
  # One jq: the activity rows (id, last epoch, started, owner) become the running entries.
  summary=$(printf '%s' "$rows" | jq -R -s --slurpfile st "$file" --arg link "$(run_link "$run_id")" \
    --argjson now "$now" --arg stale ",$stale," --arg o "$owner_lines" "$NODE_READY_JQ_DEF"'
    $st[0] as $r
    | [split("\n")[] | select(length > 0) | split("\u001f")
       | {id: .[0], owner: (if (.[3] // "-") == "-" then null else .[3] end),
          age_s: (if (.[2] // "-") == "-" then null else ((.[2] | try fromdateiso8601 catch null) | if . == null then null else $now - . end) end),
          last_activity_s: (if (.[1] // "") == "" then null else $now - (.[1] | tonumber) end),
          stale: (.[0] as $i | $stale | contains("," + $i + ","))}] as $live
    | {run_id: $r.run_id, title: $r.title, status: $r.status,
       done: ([$r.nodes[] | select(.status == "done")] | length), total: ($r.nodes | length),
       running: [$r.nodes[] | select(.status == "running") | . as $n
         | ($live[] | select(.id == $n.id)) + {note: (($n.notes // [])[-1].text // null), progress: ($n.progress // null)}],
       ready: [$r.nodes[] | select(.status == "waiting") | .id as $id
         | select(node_ready($r))
         | $id],
       errors: [$r.nodes[] | select(.status == "error") | {id, error}],
       link: $link,
       owner_events: ($o | split("\n") | map(select(length > 0)))}')
  if [ "$json" = 1 ]; then printf '%s\n' "$summary"; return 0; fi
  printf '%s' "$summary" | jq -r '
    def age: if . == null then "?" elif . < 60 then "\(.)s" elif . < 3600 then "\(. / 60 | floor)m" else "\(. / 3600 | floor)h\(. % 3600 / 60 | floor)m" end;
    "\(.title) [\(.status)] \(.done)/\(.total) done",
    (.running[] | "running \(.id): \(.age_s | age) in, last activity \(.last_activity_s | age) ago"
        + (if .progress then ", \(.progress)" else "" end)
        + (if .note then ", \"\(.note)\"" else "" end)
        + (if .stale then " [STALE]" else "" end)
        + (if .owner == null then " [UNOWNED: nothing is recorded as doing the work]" else "" end)),
    (if (.ready | length) > 0 then "ready: " + (.ready | join(",")) else empty end),
    (.errors[] | "error \(.id): \(.error // "unknown")"),
    (.owner_events[]),
    .link'
}

# The run ids searched for a dependency: the run itself, then each run it was continued from.
run_chain() {
  local id="$1" n=0 f
  while [ -n "$id" ] && [ "$n" -lt 20 ]; do
    printf '%s\n' "$id"
    f=$(run_state_file "$id")
    [ -f "$f" ] || break
    id=$(jq -r '.continued_from // empty' "$f")
    n=$((n + 1))
  done
}

# node_finished_in_origin <run> <node> — prints the origin run id when the node is done there.
node_finished_in_origin() {
  local run_id="$1" dep="$2" id f
  while IFS= read -r id; do
    [ "$id" != "$run_id" ] || continue
    f=$(run_state_file "$id")
    [ -f "$f" ] || continue
    if jq -e --arg n "$dep" 'any(.nodes[]; .id == $n and .status == "done")' "$f" >/dev/null 2>&1; then
      printf '%s\n' "$id"
      return 0
    fi
  done <<EOF2
$(run_chain "$run_id")
EOF2
  return 1
}

# Running nodes with no owner and no job: nothing is recorded as doing the work.
run_unowned_nodes() {
  jq -r '[.nodes[] | select(.status == "running" and ((.owner // "") == "") and ((.job_id // "") == "")) | .id] | join(",")' \
    "$(run_state_file "$1")"
}

NODE_REMOVE_USAGE='dispatch.sh node remove <run-id> <node-id> [--force]'

cmd_node_remove() {
  local run_id="${1:-}" node_id="${2:-}" force=0 file status blockers
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_REMOVE_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
      *) printf 'node remove: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node remove"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  status=$(node_field "$file" "$node_id" status)
  blockers=$(jq -r --arg n "$node_id" '. as $r | [$r.edges[] | select(.[0] == $n) | .[1] as $d
    | $r.nodes[] | select(.id == $d and (.status == "running" or .status == "done")) | .id] | join(",")' "$file")
  if [ "$force" = 0 ]; then
    if [ "$status" != waiting ]; then
      printf 'node remove: %s is %s; only a waiting node can be removed (--force overrides)\n' "$node_id" "$status" >&2
      return 2
    fi
    if [ -n "$blockers" ]; then
      printf 'node remove: %s has running or done dependents: %s (--force overrides)\n' "$node_id" "$blockers" >&2
      return 2
    fi
  fi
  state_write "$run_id" '.nodes |= map(select(.id != $n)) | .edges |= map(select(.[0] != $n and .[1] != $n))' --arg n "$node_id" || return 1
  run_event "$run_id" remove "$node_id" "$status" "" ""
}
