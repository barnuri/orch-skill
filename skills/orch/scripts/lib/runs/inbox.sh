# Messaging: `node tell`, `node ask`, `node inbox`, `run broadcast`, `run rule`, `run messages`.
# Sourced by dispatch.sh after runs.sh and herdr.sh; only defines functions.
#
# Every message is one file, runs/<run>/inbox/<node>/<seq>.json:
#   {id, seq, from, to, kind (tell|broadcast|rule|ask), at, text, delivered_at, via, tries, status, last_error}
# status is pending, delivered or failed. Delivery order:
#   1. herdr: the node's job has a herdr_pane in the orch herdr instance -> pane send-text + Enter.
#   2. no pane: the message stays pending; the node reads it with `node inbox` (the opencode plugin
#      orch-nodes.js does this on its next event and injects it into the live session).
#   3. the node has ended: the message waits and `node retry` prepends it to the retry prompt.
# An ask (node -> orch) is stored in inbox/orch with answer/answered_at; `node answer` fills them and
# sends the answer to the node as a kind "answer" message. `node ask --wait` blocks until then.
# A failed herdr push counts one try; after INBOX_MAX_TRIES the message is marked failed.
# The watchdog calls `run messages <run> retry` on every sweep. Asks from a node go to inbox/orch.

INBOX_MAX_TRIES=3
NODE_TELL_USAGE='dispatch.sh node tell <run-id> <node-id> "<text>" [--from NAME]'
NODE_ASK_USAGE='dispatch.sh node ask <run-id> <node-id> "<question>" [--wait] [--timeout SECS]'
NODE_ANSWER_USAGE='dispatch.sh node answer <run-id> <node-id> "<answer>" [--ask <id>]'
INBOX_ASK_WAIT_SECS=1800
NODE_INBOX_USAGE='dispatch.sh node inbox <run-id> <node-id> [--json] [--peek] [--ack <id>] [--via NAME]'
RUN_BROADCAST_USAGE='dispatch.sh run broadcast <run-id> "<text>" [--from NAME]'
RUN_RULE_USAGE='dispatch.sh run rule add <run-id> "<text>" | run rule list <run-id> [--json]'
RUN_MESSAGES_USAGE='dispatch.sh run messages <run-id> [--json] | run messages <run-id> retry'

inbox_dir() { printf '%s/%s/inbox/%s\n' "$RUNS_HOME" "$1" "$2"; }

# inbox_files <run> <node>: the node's message files in seq order.
inbox_files() {
  local dir
  dir=$(inbox_dir "$1" "$2")
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -name '*.json' -type f -exec basename {} \; 2>/dev/null | sort -n | sed "s|^|$dir/|"
}

# inbox_write_file <path> <jq-filter> [jq args]: rewrite one message file atomically.
inbox_write_file() {
  local path="$1" filter="$2" tmp
  shift 2
  tmp="$path.tmp.$$"
  jq "$@" "$filter" "$path" > "$tmp" && mv -f "$tmp" "$path"
}

# inbox_new <run> <to> <from> <kind> <text>: stores a pending message, prints its path. The seq is
# allocated under the run lock, so two writers never share a number.
inbox_new() {
  local run_id="$1" to="$2" from="$3" kind="$4" text="$5" dir seqf seq path rc=0
  dir=$(inbox_dir "$run_id" "$to")
  mkdir -p "$dir" || return 1
  seqf="$RUNS_HOME/$run_id/inbox/.seq"
  run_lock "$run_id" || return $?
  seq=$(( $(cat "$seqf" 2>/dev/null || printf 0) + 1 ))
  path="$dir/$seq.json"
  if printf '%s\n' "$seq" > "$seqf" \
    && jq -n --argjson seq "$seq" --arg id "m$seq" --arg from "$from" --arg to "$to" --arg kind "$kind" \
      --arg at "$(now_iso)" --arg text "$text" \
      '{id: $id, seq: $seq, from: $from, to: $to, kind: $kind, at: $at, text: $text,
        delivered_at: null, via: null, tries: 0, status: "pending", last_error: null}' > "$path.tmp.$$" \
    && mv -f "$path.tmp.$$" "$path"; then :; else rc=1; fi
  run_unlock "$run_id"
  [ "$rc" = 0 ] && printf '%s\n' "$path"
  return $rc
}

inbox_mark_delivered() {
  inbox_write_file "$1" '.status = "delivered" | .delivered_at = $at | .via = $via | .last_error = null' \
    --arg at "$(now_iso)" --arg via "$2"
}

# inbox_node_pane <run> <node>: the herdr pane of the node's running job; empty when none.
inbox_node_pane() {
  local file job
  file=$(run_state_file "$1")
  [ "$(node_field "$file" "$2" status)" = running ] || return 0
  job=$(node_field "$file" "$2" job_id)
  [ -n "$job" ] && [ -s "$JOBS_HOME/$job/herdr_pane" ] || return 0
  head -n1 "$JOBS_HOME/$job/herdr_pane"
}

inbox_push_text() { printf '[orch message %s from %s] %s' "$(jq -r .id "$1")" "$(jq -r .from "$1")" "$(jq -r .text "$1")"; }

# inbox_deliver <run> <node> <path>: one push attempt. Prints the result (delivered|pending|failed).
inbox_deliver() {
  local run_id="$1" node="$2" path="$3" pane tries err
  [ "$(jq -r .status "$path")" = pending ] || { jq -r .status "$path"; return 0; }
  pane=$(inbox_node_pane "$run_id" "$node")
  if [ -z "$pane" ] || ! herdr_enabled; then printf 'pending\n'; return 0; fi
  if err=$(herdr_cli pane send-text "$pane" "$(inbox_push_text "$path")" 2>&1) \
    && err=$(herdr_cli pane send-keys "$pane" Enter 2>&1); then
    inbox_mark_delivered "$path" herdr
    printf 'delivered\n'
    return 0
  fi
  tries=$(( $(jq -r '.tries // 0' "$path") + 1 ))
  if [ "$tries" -ge "$INBOX_MAX_TRIES" ]; then
    inbox_write_file "$path" '.tries = $t | .status = "failed" | .last_error = $e' --argjson t "$tries" --arg e "${err:-herdr send failed}"
    run_event "$run_id" message "$node" "" failed "$(jq -r .id "$path") failed after $tries tries"
    printf 'failed\n'
  else
    inbox_write_file "$path" '.tries = $t | .last_error = $e' --argjson t "$tries" --arg e "${err:-herdr send failed}"
    printf 'pending\n'
  fi
}

# inbox_send <run> <node> <from> <kind> <text>: store, try to push, print "<id> <result>".
inbox_send() {
  local run_id="$1" node="$2" path result
  path=$(inbox_new "$run_id" "$node" "$3" "$4" "$5") || return 1
  result=$(inbox_deliver "$run_id" "$node" "$path")
  run_event "$run_id" message "$node" "$3" "$result" "$5"
  printf '%s %s %s\n' "$(jq -r .id "$path")" "$node" "$result"
}

# inbox_take_args: shared parse of <run> <node> "<text>" [--from NAME]; sets IT_RUN IT_NODE IT_TEXT IT_FROM.
inbox_take_args() {
  local usage="$1"
  shift
  IT_RUN="" IT_NODE="" IT_TEXT="" IT_FROM=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) shift; IT_FROM="${1:-}" ;;
      *) if [ -z "$IT_RUN" ]; then IT_RUN="$1"; elif [ -z "$IT_NODE" ]; then IT_NODE="$1"; else IT_TEXT="${IT_TEXT:+$IT_TEXT }$1"; fi ;;
    esac
    shift
  done
  [ -n "$IT_RUN" ] && [ -n "$IT_NODE" ] && [ -n "$IT_TEXT" ] || { printf 'usage: %s\n' "$usage" >&2; return 2; }
}

cmd_node_tell() {
  local file
  inbox_take_args "$NODE_TELL_USAGE" "$@" || return $?
  file=$(run_require "$IT_RUN") || return 2
  node_require "$file" "$IT_NODE" || return 2
  inbox_send "$IT_RUN" "$IT_NODE" "${IT_FROM:-orch}" tell "$IT_TEXT"
}

cmd_node_ask() {
  local file path wait=0 timeout="$INBOX_ASK_WAIT_SECS" id deadline ans args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) wait=1 ;;
      --timeout) shift; timeout="${1:-}" ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  case "$timeout" in ''|*[!0-9]*) printf 'usage: %s\n' "$NODE_ASK_USAGE" >&2; return 2 ;; esac
  inbox_take_args "$NODE_ASK_USAGE" "${args[@]}" || return $?
  file=$(run_require "$IT_RUN") || return 2
  node_require "$file" "$IT_NODE" || return 2
  path=$(inbox_new "$IT_RUN" orch "$IT_NODE" ask "$IT_TEXT") || return 1
  inbox_write_file "$path" '. + {answer: null, answered_at: null, waiting: ($w == "1")}' --arg w "$wait" || return 1
  id=$(jq -r .id "$path")
  run_event "$IT_RUN" ask "$IT_NODE" "" "" "$id: $IT_TEXT"
  if [ "$wait" = 0 ]; then printf '%s asked\n' "$id"; return 0; fi
  deadline=$(( $(date -u +%s) + timeout ))
  while :; do
    ans=$(jq -r '.answer // empty' "$path" 2>/dev/null)
    if [ -n "$ans" ]; then
      # The answer was printed here, so its inbox copy counts as delivered.
      inbox_ack_answer "$IT_RUN" "$IT_NODE" "$id"
      printf '%s\n' "$ans"
      return 0
    fi
    [ "$(date -u +%s)" -lt "$deadline" ] || { printf 'node ask: no answer to %s after %ss\n' "$id" "$timeout" >&2; return 4; }
    sleep "${ORCH_ASK_POLL_SECS:-2}"
  done
}

# inbox_ack_answer <run> <node> <ask-id>: marks the pending answer to <ask-id> delivered (via ask-wait).
inbox_ack_answer() {
  local f
  for f in $(inbox_files "$1" "$2"); do
    [ "$(jq -r '"\(.status) \(.reply_to // "")"' "$f")" = "pending $3" ] || continue
    inbox_mark_delivered "$f" ask-wait
  done
}

# inbox_find_ask <run> <node> [<ask-id>]: path of the ask; without an id, the oldest unanswered ask of the node.
inbox_find_ask() {
  local f
  for f in $(inbox_files "$1" orch); do
    if [ -n "${3:-}" ]; then
      [ "$(jq -r .id "$f")" = "$3" ] && { printf '%s\n' "$f"; return 0; }
    else
      [ "$(jq -r '"\(.kind) \(.from) \(.answer == null)"' "$f")" = "ask $2 true" ] && { printf '%s\n' "$f"; return 0; }
    fi
  done
  return 1
}

cmd_node_answer() {
  local ask="" path out file node_path args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --ask) shift; ask="${1:-}" ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  inbox_take_args "$NODE_ANSWER_USAGE" "${args[@]}" || return $?
  file=$(run_require "$IT_RUN") || return 2
  node_require "$file" "$IT_NODE" || return 2
  path=$(inbox_find_ask "$IT_RUN" "$IT_NODE" "$ask") || { printf 'node answer: no open ask from %s%s\n' "$IT_NODE" "${ask:+ with id $ask}" >&2; return 2; }
  [ "$(jq -r .from "$path")" = "$IT_NODE" ] || { printf 'node answer: %s was not asked by %s\n' "$ask" "$IT_NODE" >&2; return 2; }
  [ "$(jq -r '.answer // empty' "$path")" = "" ] || { printf 'node answer: %s is already answered\n' "$(jq -r .id "$path")" >&2; return 2; }
  ask=$(jq -r .id "$path")
  # The node's copy first: a waiting `node ask --wait` acks it as soon as the ask holds the answer.
  node_path=$(inbox_new "$IT_RUN" "$IT_NODE" "${IT_FROM:-orch}" answer "Answer to $ask: $IT_TEXT") || return 1
  inbox_write_file "$node_path" '.reply_to = $r' --arg r "$ask" || return 1
  inbox_write_file "$path" '.answer = $a | .answered_at = $at | .status = "delivered" | .delivered_at = (.delivered_at // $at) | .via = (.via // "answer")' \
    --arg a "$IT_TEXT" --arg at "$(now_iso)" || return 1
  # A blocked `node ask --wait` prints the answer itself, so no pane push for it.
  if [ "$(jq -r '.waiting // false' "$path")" = true ]; then out=pending; else out=$(inbox_deliver "$IT_RUN" "$IT_NODE" "$node_path"); fi
  run_event "$IT_RUN" message "$IT_NODE" "${IT_FROM:-orch}" "$out" "answer $ask: $IT_TEXT"
  printf '%s answered %s %s\n' "$ask" "$IT_NODE" "$out"
}

# cmd_node_inbox: prints the node's pending messages and marks them delivered (unless --peek).
# --ack <id> marks one message delivered and prints nothing else. Use node `orch` for asks.
cmd_node_inbox() {
  local run_id="" node="" json=0 peek=0 ack="" via=inbox f out
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --peek) peek=1 ;;
      --ack) shift; ack="${1:-}" ;;
      --via) shift; via="${1:-inbox}" ;;
      *) if [ -z "$run_id" ]; then run_id="$1"; elif [ -z "$node" ]; then node="$1"; else printf 'usage: %s\n' "$NODE_INBOX_USAGE" >&2; return 2; fi ;;
    esac
    shift
  done
  [ -n "$run_id" ] && [ -n "$node" ] || { printf 'usage: %s\n' "$NODE_INBOX_USAGE" >&2; return 2; }
  run_require "$run_id" >/dev/null || return 2
  if [ -n "$ack" ]; then
    for f in $(inbox_files "$run_id" "$node"); do
      [ "$(jq -r .id "$f")" = "$ack" ] || continue
      [ "$(jq -r .status "$f")" = delivered ] || inbox_mark_delivered "$f" "$via"
      printf 'acked %s\n' "$ack"
      return 0
    done
    printf 'node inbox: no message %s\n' "$ack" >&2
    return 2
  fi
  out='[]'
  for f in $(inbox_files "$run_id" "$node"); do
    [ "$(jq -r .status "$f")" = pending ] || continue
    out=$(jq -c --slurpfile m "$f" '. + $m' <<<"$out")
    [ "$peek" = 1 ] || inbox_mark_delivered "$f" "$via"
  done
  if [ "$json" = 1 ]; then printf '%s\n' "$out"; return 0; fi
  jq -r '.[] | "[\(.id) from \(.from)] \(.text)"' <<<"$out"
}

# inbox_all <run>: every message of the run as one JSON array, oldest first.
inbox_all() {
  local root="$RUNS_HOME/$1/inbox"
  [ -d "$root" ] || { printf '[]\n'; return 0; }
  find "$root" -mindepth 2 -maxdepth 2 -name '*.json' -type f -print0 2>/dev/null \
    | xargs -0 cat 2>/dev/null | jq -sc 'sort_by(.seq)'
}

# run messages <run> retry: one push attempt for every pending message of a running node.
inbox_retry_run() {
  local run_id="$1" d node f n=0 r
  [ -d "$RUNS_HOME/$run_id/inbox" ] || { printf 'retried 0\n'; return 0; }
  for d in "$RUNS_HOME/$run_id/inbox"/*/; do
    [ -d "$d" ] || continue
    node=$(basename "$d")
    [ "$node" = orch ] && continue
    [ -n "$(inbox_node_pane "$run_id" "$node")" ] || continue
    for f in $(inbox_files "$run_id" "$node"); do
      [ "$(jq -r .status "$f")" = pending ] || continue
      r=$(inbox_deliver "$run_id" "$node" "$f")
      n=$((n + 1))
      printf '%s %s %s\n' "$(jq -r .id "$f")" "$node" "$r"
    done
  done
  printf 'retried %s\n' "$n"
}

cmd_run_messages() {
  local run_id="${1:-}"
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_MESSAGES_USAGE" >&2; return 2; }
  run_require "$run_id" >/dev/null || return 2
  case "${2:-}" in
    retry) inbox_retry_run "$run_id" ;;
    --json) inbox_all "$run_id" ;;
    "") inbox_all "$run_id" | jq -r '.[] | "\(.id) \(.from)->\(.to) [\(.kind)] \(.status)\(if .via then " via \(.via)" else "" end): \(.text)"' ;;
    *) printf 'usage: %s\n' "$RUN_MESSAGES_USAGE" >&2; return 2 ;;
  esac
}

# inbox_broadcast <run> <from> <kind> <text>: send to every running node.
inbox_broadcast() {
  local run_id="$1" from="$2" kind="$3" text="$4" node n=0
  for node in $(jq -r '.nodes[] | select(.status == "running") | .id' "$(run_state_file "$run_id")"); do
    inbox_send "$run_id" "$node" "$from" "$kind" "$text"
    n=$((n + 1))
  done
  printf 'broadcast %s\n' "$n"
}

cmd_run_broadcast() {
  local run_id="" text="" from=orch
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) shift; from="${1:-orch}" ;;
      *) if [ -z "$run_id" ]; then run_id="$1"; else text="${text:+$text }$1"; fi ;;
    esac
    shift
  done
  [ -n "$run_id" ] && [ -n "$text" ] || { printf 'usage: %s\n' "$RUN_BROADCAST_USAGE" >&2; return 2; }
  run_require "$run_id" >/dev/null || return 2
  inbox_broadcast "$run_id" "$from" broadcast "$text"
}

cmd_run_rule() {
  local verb="${1:-}" run_id="${2:-}" file text id
  case "$verb" in
    add)
      shift 2
      text="$*"
      [ -n "$run_id" ] && [ -n "$text" ] || { printf 'usage: %s\n' "$RUN_RULE_USAGE" >&2; return 2; }
      file=$(run_require "$run_id") || return 2
      id="r$(( $(jq '(.rules // []) | length' "$file") + 1 ))"
      state_write "$run_id" '.rules = ((.rules // []) + [{id: $id, text: $text, at: $at}])' \
        --arg id "$id" --arg text "$text" --arg at "$(now_iso)" || return 1
      run_event "$run_id" rule "" "" "" "$text"
      printf 'rule %s added\n' "$id"
      inbox_broadcast "$run_id" orch rule "New run rule: $text"
      ;;
    list)
      [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_RULE_USAGE" >&2; return 2; }
      file=$(run_require "$run_id") || return 2
      if [ "${3:-}" = --json ]; then jq -c '.rules // []' "$file"; else jq -r '(.rules // [])[] | "\(.id) \(.text)"' "$file"; fi
      ;;
    *) printf 'usage: %s\n' "$RUN_RULE_USAGE" >&2; return 2 ;;
  esac
}

# inbox_rules_block <run>: the run rules and the inbox instruction, for the header of a node prompt.
inbox_rules_block() {
  local run_id="$1" node="$2" file rules
  file=$(run_state_file "$run_id")
  rules=$(jq -r '(.rules // [])[] | "- \(.text)"' "$file" 2>/dev/null)
  if [ -n "$rules" ]; then printf '## Run rules\n\n%s\n\n' "$rules"; fi
  printf 'Messages: the coordinator can send you messages. Read them with `dispatch.sh node inbox %s %s` between steps. Ask the coordinator with `dispatch.sh node ask %s %s "<question>"`.\n' \
    "$run_id" "$node" "$run_id" "$node"
}

# inbox_retry_prefix <run> <node>: prints the pending messages as a prompt block and marks them
# delivered via retry; prints nothing when there are none.
inbox_retry_prefix() {
  local run_id="$1" node="$2" f body=""
  for f in $(inbox_files "$run_id" "$node"); do
    [ "$(jq -r .status "$f")" = pending ] || continue
    body="$body- [$(jq -r .id "$f") from $(jq -r .from "$f")] $(jq -r .text "$f")"$'\n'
    inbox_mark_delivered "$f" retry
  done
  [ -n "$body" ] || return 0
  printf '# Messages sent while you were not running\n\n%s\n' "$body"
}
