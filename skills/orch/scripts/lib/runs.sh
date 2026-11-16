#!/usr/bin/env bash
# Run/node state for orch — sourced by dispatch.sh, never executed.
# A "run" is one orchestration session: a small DAG of nodes (tasks) under runs/<run-id>/state.json.
# Every mutation is a jq filter applied atomically (tmp + mv). The server reads state.json
# directly — there is no render step. The coordinating agent drives this with one short
# command per state change; nothing here re-derives its own decisions.
#
# jq programs are single-quoted on purpose — their $vars are jq's, bound with --arg.
# shellcheck disable=SC2016

NODE_STATUSES="waiting running done error skipped stopped"
RUN_STATUSES="done error cancelled"
ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]*$'
USAGE_CATEGORIES="tool mcp skill subagent agent"
# Wider than ID_PATTERN: these names come from tool ids like `mcp__github__search`, `Bash`, or a
# model slug, so `:` and `@` are legal. Length-capped so one bad log line cannot bloat state.json.
USAGE_NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'
USAGE_COUNT_MAX=1000000
LOG_TAIL_LINES=20
MAX_ATTEMPTS_DEFAULT=5
RETRY_BACKOFF_CAP_SECS=300
ADAPTER_NAMES="claude-native $VALID_HARNESSES"

RUN_START_USAGE='dispatch.sh run start "<title>" [--id <run-id>]'
RUN_FINISH_USAGE="dispatch.sh run finish <run-id> [--status $(printf '%s' "$RUN_STATUSES" | tr ' ' '|')]"
RUN_SYNC_USAGE='dispatch.sh run sync <run-id> [--no-retry]'
RUN_STOP_USAGE='dispatch.sh run stop <run-id>'
RUN_STOP_ERROR="cancelled"
RUN_RETRY_USAGE='dispatch.sh run retry <run-id> [--profile P] [--no-dispatch]'
SMART_AUTO_TIERS="efficiency balance intelligence fast"
WORK_ROLES="planning investigation implementation validation conversation"
SELECTION_PAGE_LIMIT=500
SELECTION_HISTORY_MAX=500
SELECTION_HTTP_TIMEOUT=5
NODE_SELECTIONS_USAGE='dispatch.sh node selections <run-id> <node-id>'
NODE_ADD_USAGE='dispatch.sh node add <run-id> <node-id> "<label>" [--after a,b] [--profile P] [--role R] [--tier T] [--model M] [--plan-backed] [--acceptance "<checks>"]'
NODE_REPORT_USAGE='dispatch.sh node report <run-id> <node-id> [--model M] [--input-tokens N] [--output-tokens N] [--cache-read-tokens N] [--usd X] [--note "text"]'
NODE_UPDATE_USAGE="dispatch.sh node update <run-id> <node-id> [$(printf '%s' "$NODE_STATUSES" | tr ' ' '|')] [--job J] [--error \"msg\"] [--at <iso>] [--owner <text>] [--force] [--after a,b|'*'|\"\"] [--needs-user \"reason\"|--clear-needs-user] [--hold \"reason\"|--clear-hold]"

NODE_DISPATCH_USAGE='dispatch.sh node dispatch <run-id> <node-id> (--profile <name> | <adapter>) <prompt|@file> [args...]'
NODE_RETRY_USAGE='dispatch.sh node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [<prompt|@file>]'
NODE_USAGE_USAGE='dispatch.sh node usage <run-id> <node-id> [--add c.name=N]... [--set c.name=N]... [--clear]'
NODE_COST_USAGE='dispatch.sh node cost <run-id> <node-id> (--from-job <job-id> | --clear)'
NODE_OUT_USAGE='dispatch.sh node out <run-id> <node-id>'
NODE_DIGEST_USAGE='dispatch.sh node digest <run-id> <node-id> [--lines N]'
DIGEST_LINES_DEFAULT=10
DIGEST_LINES_MAX=200
PRUNE_USAGE='dispatch.sh prune [--older-than <N>d|<N>h|<N>] [--dry-run]'

run_state_file() { printf '%s/%s/state.json\n' "$RUNS_HOME" "$1"; }

# Prints the state file path, or names the problem and returns 2.
run_require() {
  local file
  file=$(run_state_file "$1")
  [ -f "$file" ] || { printf 'run %s: unknown run\n' "$1" >&2; return 2; }
  printf '%s\n' "$file"
}

node_require() {
  local file="$1" node="$2"
  jq -e --arg n "$node" 'any(.nodes[]; .id == $n)' "$file" >/dev/null 2>&1 && return 0
  printf 'node %s: not in this run\n' "$node" >&2
  return 2
}

node_field() { jq -r --arg n "$2" --arg f "$3" '.nodes[] | select(.id == $n) | .[$f] // empty' "$1"; }

valid_id() { [[ "$1" =~ $ID_PATTERN ]]; }

# run_lock <run-id> / run_unlock <run-id>: the one per-run lock (`run-<id>`, locks.sh) that every
# read-modify-write of state.json holds from the read to the mv; `node batch` takes the same one.
# Re-entrant: when this process already holds it (node batch -> owner fill -> state_write_raw), the
# inner call neither waits nor releases. Sets RUN_LOCK_NESTED for the matching run_unlock.
RUN_LOCK_WAIT_SECS=30
run_lock() {
  local f waited=0
  f="$(locks_dir)/$(printf '%s' "run-$1" | tr -c 'A-Za-z0-9._-' '_').pid"
  if [ "$(cat "$f" 2>/dev/null)" = "$$" ]; then RUN_LOCK_NESTED=1; return 0; fi
  RUN_LOCK_NESTED=0
  while ! orch_lock_acquire "run-$1"; do
    [ "$waited" -lt $((${ORCH_RUN_LOCK_WAIT_SECS:-$RUN_LOCK_WAIT_SECS} * 20)) ] \
      || { printf 'run %s: state is locked by another writer\n' "$1" >&2; return 75; }
    sleep 0.05; waited=$((waited + 1))
  done
}
run_unlock() { [ "${RUN_LOCK_NESTED:-0}" = 1 ] || orch_lock_release "run-$1"; }

# state_write_raw <run-id> <jq-filter> [jq --arg ...]: atomic rewrite of the run's state.json. The
# read (jq) and the mv both happen under run_lock, so a concurrent writer can never base its write
# on a state that misses another writer's change (a lost node add).
state_write_raw() {
  local run_id="$1" filter="$2" file tmp rc=0 nested
  shift 2
  file=$(run_state_file "$run_id")
  tmp="$file.tmp.$$"
  run_lock "$run_id" || return $?
  nested=$RUN_LOCK_NESTED
  if ! jq "$@" "$filter" "$file" > "$tmp"; then
    printf 'run %s: state update failed\n' "$run_id" >&2
    rc=1
  else
    mv -f "$tmp" "$file" || rc=1
  fi
  RUN_LOCK_NESTED=$nested run_unlock "$run_id"
  return $rc
}

# Kept as the name every mutation calls; it no longer adds anything to the raw write.
state_write() { state_write_raw "$@"; }

run_state_files() {
  find "$RUNS_HOME" -mindepth 2 -maxdepth 2 -name state.json 2>/dev/null
}

run_job_ids() { jq -r '.nodes[].job_id // empty' "$1"; }

# Fills RUN_STATE_FILES[] (bash 3.2: no mapfile) with every run's state.json path.
load_run_state_files() {
  local f
  RUN_STATE_FILES=()
  while IFS= read -r f; do [ -n "$f" ] && RUN_STATE_FILES+=("$f"); done <<EOF
$(run_state_files)
EOF
}

new_run_id() { printf '%s-%04x\n' "$(date -u +%Y%m%d-%H%M%S)" $((RANDOM % 65536)); }

cmd_run_start() {
  local title="${1:-}" run_id="" dir
  [ -n "$title" ] || { printf 'usage: %s\n' "$RUN_START_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) shift; run_id="${1:-}" ;;
      *) printf 'run start: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run start"
  ensure_home || return 1

  [ -n "$run_id" ] || run_id=$(new_run_id)
  valid_id "$run_id" || { printf 'run start: id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  dir="$RUNS_HOME/$run_id"
  [ ! -e "$dir" ] || { printf 'run start: %s already exists\n' "$run_id" >&2; return 2; }
  mkdir -p "$dir" || return 1

  jq -n --arg id "$run_id" --arg title "$title" --arg session "$(agent_session_id)" --arg ts "$(now_iso)" \
    '{run_id: $id, title: $title, harness_session: $session, started: $ts, finished: null,
      status: "running", nodes: [], edges: []}' > "$dir/state.json"
  auto_prune
  printf '%s\n' "$run_id"
}

cmd_run_finish() {
  local run_id="${1:-}" status="" file
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_FINISH_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --status) shift; status="${1:-}" ;;
      *) printf 'run finish: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run finish"
  file=$(run_require "$run_id") || return $?

  [ -n "$status" ] || status=$(jq -r 'if any(.nodes[]; .status == "error") then "error" else "done" end' "$file")
  in_list "$status" "$RUN_STATUSES" || { printf 'run finish: status must be one of: %s\n' "$RUN_STATUSES" >&2; return 2; }
  state_write "$run_id" '.status = $s | .finished = $ts' --arg s "$status" --arg ts "$(now_iso)" || return 1
  run_event "$run_id" run "" "" "$status" ""
  learning_after_finish "$run_id" || true
  printf '%s\n' "$status"
}

# run_cancel <run-id>: ends a run for good (loops use it): kills its live jobs, marks running nodes
# error, skips waiting nodes and sets the run cancelled. `run stop` (lib/pause.sh) is the resumable stop.
# Jobs lead their own process group, so SIGTERM goes to the group. A node whose job is already gone
# is marked the same way, which is how a run abandoned by its coordinator gets closed.
run_cancel() {
  local run_id="${1:-}" file job_id pid stopped=0
  [ -n "$run_id" ] && [ $# -eq 1 ] || { printf 'usage: %s\n' "$RUN_STOP_USAGE" >&2; return 2; }
  require_jq "run cancel"
  file=$(run_require "$run_id") || return $?
  while IFS= read -r job_id; do
    [ -n "$job_id" ] || continue
    pid=$(cat "$JOBS_HOME/$job_id/pid" 2>/dev/null || printf '')
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || continue
    stopped=$((stopped + 1))
  done <<EOF
$(jq -r '.nodes[] | select(.status == "running") | .job_id // empty' "$file")
EOF
  state_write "$run_id" '
    .nodes |= map(
      if .status == "running" then .status = "error" | .error = $err | .finished = $ts | .next_retry_at = null
      elif .status == "waiting" then .status = "skipped" | .finished = $ts | .next_retry_at = null
      else . end)
    | .status = "cancelled" | .finished = $ts' \
    --arg err "$RUN_STOP_ERROR" --arg ts "$(now_iso)" || return 1
  run_event "$run_id" run "" "" cancelled ""
  printf 'cancelled (stopped %s job(s))\n' "$stopped"
}

cmd_run_list() {
  require_jq "run list"
  load_run_state_files
  [ "${#RUN_STATE_FILES[@]}" -gt 0 ] || return 0
  jq -rs 'sort_by(.started) | reverse | .[]
    | [.run_id, .status, .title, (([.nodes[] | select(.status == "done")] | length | tostring) + "/" + (.nodes | length | tostring))]
    | @tsv' "${RUN_STATE_FILES[@]}"
}

cmd_node_add() {
  local run_id="${1:-}" node_id="${2:-}" label="${3:-}" deps="" profile="" file dep
  local role="" tier="" acceptance="" plan_backed=false model=""
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ -z "$label" ]; then
    printf 'usage: %s\n' "$NODE_ADD_USAGE" >&2
    return 2
  fi
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --after) shift; deps="${1:-}" ;;
      --profile) shift; profile="${1:-}" ;;
      --role) shift; role="${1:-}" ;;
      --tier) shift; tier="${1:-}" ;;
      --model) shift; model="${1:-}" ;;
      --plan-backed) plan_backed=true ;;
      --acceptance) shift; acceptance="${1:-}" ;;
      *) printf 'node add: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [ -n "$role" ] && ! in_list "$role" "$WORK_ROLES"; then
    printf 'node add: --role must be one of: %s\n' "$WORK_ROLES" >&2
    return 2
  fi
  if [ -n "$tier" ] && ! in_list "$tier" "$SMART_AUTO_TIERS"; then
    printf 'node add: --tier must be one of: %s\n' "$SMART_AUTO_TIERS" >&2
    return 2
  fi
  require_jq "node add"
  file=$(run_require "$run_id") || return $?
  if hub_mode_on; then
    [ -n "$profile" ] || profile=$(hub_profile)
    [ -n "$tier" ] || tier=$(hub_role_tier "$role")
  fi
  valid_id "$node_id" || { printf 'node add: id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  if node_require "$file" "$node_id" 2>/dev/null; then
    printf 'node add: %s already exists\n' "$node_id" >&2
    return 2
  fi
  local kept="" origin
  for dep in $(printf '%s' "$deps" | tr ',' ' '); do
    [ "$dep" != "$node_id" ] || { printf 'node add: %s cannot depend on itself\n' "$node_id" >&2; return 2; }
    if node_require "$file" "$dep" 2>/dev/null; then
      kept="$kept${kept:+,}$dep"
    elif origin=$(node_finished_in_origin "$run_id" "$dep"); then
      printf 'dependency %s is finished in run %s\n' "$dep" "$origin" >&2
    else
      printf 'node add: dependency %s is not in run %s or in the runs it continued (searched: %s)\n' \
        "$dep" "$run_id" "$(run_chain "$run_id" | tr '\n' ' ')" >&2
      return 2
    fi
  done
  deps="$kept"

  state_write "$run_id" \
    '($deps | split(",") | map(select(length > 0))) as $d
     | .nodes += [{id: $id, label: $label, status: "waiting", profile: (if $profile == "" then null else $profile end),
                   adapter: null, model: (if $model == "" then null else $model end), model_id: null, job_id: null, session: null, started: null, finished: null,
                   error: null, log_tail: [], usage: {}, cost: null, created: $ts, updated: $ts, prompt: null, dispatch_args: [], attempts: [],
                   role: (if $role == "" then null else $role end), tier: (if $tier == "" then null else $tier end),
                   plan_backed: $plan_backed, acceptance: (if $acceptance == "" then null else $acceptance end)}]
     | .edges += ($d | map([., $id]))' \
    --arg id "$node_id" --arg label "$label" --arg deps "$deps" --arg profile "$profile" \
    --arg role "$role" --arg tier "$tier" --arg model "$model" --argjson plan_backed "$plan_backed" --arg acceptance "$acceptance" \
    --arg ts "$(now_iso)" || return 1
  run_event "$run_id" add "$node_id" "" waiting "$label"
}

# Parses one `<category>.<name>=<count>` term into the globals USAGE_TERM_{CAT,NAME,COUNT}.
# bash 3.2 has no associative arrays and no nameref, so globals are the portable channel.
usage_parse_term() {
  local flag="$1" term="$2" path count
  path="${term%%=*}"
  count="${term#*=}"
  [ "$path" != "$term" ] || { printf 'node usage: %s expects <category>.<name>=<count>, got %s\n' "$flag" "$term" >&2; return 2; }
  USAGE_TERM_CAT="${path%%.*}"
  USAGE_TERM_NAME="${path#*.}"
  [ -n "$USAGE_TERM_NAME" ] && [ "$USAGE_TERM_NAME" != "$USAGE_TERM_CAT" ] \
    || { printf 'node usage: %s expects <category>.<name>=<count>, got %s\n' "$flag" "$term" >&2; return 2; }
  in_list "$USAGE_TERM_CAT" "$USAGE_CATEGORIES" \
    || { printf 'node usage: category must be one of: %s\n' "$USAGE_CATEGORIES" >&2; return 2; }
  [[ "$USAGE_TERM_NAME" =~ $USAGE_NAME_PATTERN ]] \
    || { printf 'node usage: name must match %s\n' "$USAGE_NAME_PATTERN" >&2; return 2; }
  is_uint "$count" && [ "$count" -le "$USAGE_COUNT_MAX" ] \
    || { printf 'node usage: count must be an integer in 0..%s, got %s\n' "$USAGE_COUNT_MAX" "$count" >&2; return 2; }
  USAGE_TERM_COUNT="$count"
  return 0
}

# Every --add/--set becomes one {op,cat,name,count} object; the whole batch is applied in a
# single atomic state write, so a partially-applied usage update is not observable.
cmd_node_usage() {
  local run_id="${1:-}" node_id="${2:-}" clear=0 ops="[]" file op
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_USAGE_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --clear) clear=1 ;;
      --add|--set)
        op="${1#--}"
        shift
        [ $# -gt 0 ] || { printf 'node usage: --%s expects a value\n' "$op" >&2; return 2; }
        usage_parse_term "--$op" "$1" || return 2
        ops=$(printf '%s' "$ops" | jq -c --arg op "$op" --arg c "$USAGE_TERM_CAT" \
          --arg n "$USAGE_TERM_NAME" --argjson v "$USAGE_TERM_COUNT" \
          '. + [{op: $op, cat: $c, name: $n, count: $v}]')
        ;;
      *) printf 'node usage: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node usage"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  if [ "$clear" -eq 0 ] && [ "$ops" = "[]" ]; then
    printf 'node usage: nothing to do — pass --add, --set or --clear\n  usage: %s\n' "$NODE_USAGE_USAGE" >&2
    return 2
  fi
  usage_apply "$run_id" "$node_id" "$clear" "$ops" || return 1
  jq -c --arg n "$node_id" '.nodes[] | select(.id == $n) | .usage // {}' "$file"
}

# `--set X=0` deletes the entry rather than storing a zero, so a cleared counter disappears from
# the dashboard instead of showing "0". `--add` of 0 is a no-op on an absent entry for the same reason.
usage_apply() {
  local run_id="$1" node_id="$2" clear="$3" ops="$4"
  node_patch "$run_id" "$node_id" \
    '.updated = $ts | (if $clear == 1 then .usage = {} else .usage = (.usage // {}) end)
     | reduce $ops[] as $o (.;
         ($o.cat) as $c | ($o.name) as $n
         | (if $o.op == "add" then ((.usage[$c][$n] // 0) + $o.count) else $o.count end) as $next
         | if $next <= 0 then
             (if (.usage[$c] // {}) | has($n) then del(.usage[$c][$n]) else . end)
           else
             .usage[$c] = ((.usage[$c] // {}) + {($n): $next})
           end
         | (if (.usage[$c] // null) == {} then del(.usage[$c]) else . end))' \
    --argjson clear "$clear" --argjson ops "$ops" --arg ts "$(now_iso)"
}

# node_patch <run-id> <node-id> '<jq assignments>' [jq --arg …] — the one wrapper that rewrites a
# single node inside .nodes; $n is bound to the node id for the assignments.
node_patch() {
  local run_id="$1" node_id="$2" patch="$3"
  shift 3
  state_write_raw "$run_id" ".nodes |= map(if .id != \$n then . else ($patch) end)" --arg n "$node_id" "$@"
}

# node_set_status <run-id> <node-id> <status> [job] [error] [adapter] [profile] [session] — the one
# mutation every status change goes through: stamps started on first `running`, finished on
# terminal states.
node_set_status() {
  local run_id="$1" node_id="$2" status="$3" job="${4:-}" err="${5:-}" adapter="${6:-}" profile="${7:-}"
  local session="${8:-}" model="${9:-}" model_id="${10:-}" retry_at=""
  local old at="${NODE_EVENT_AT:-}" owner="${NODE_OWNER:-}" now
  now=$(now_iso)
  [ -n "$owner" ] || { [ "$status" != running ] || [ -z "$job" ] || owner="$job"; }
  [ -n "$at" ] || at="$now"
  old=$(node_field "$(run_state_file "$run_id")" "$node_id" status)
  [ "$status" = "error" ] && retry_at=$(node_next_retry_at "$run_id" "$node_id")
  if [ "$status" = waiting ] && [ "$old" = error ]; then
    node_archive_attempt "$run_id" "$node_id" "reset to waiting" "" "" || return 1
  fi
  node_patch "$run_id" "$node_id" \
    '.status = $s
     | .updated = $now
     | (if ($s == "done" or $s == "error") and .started == null
        then .started = (.created // $at) | .backfilled = true
        else . end)
     | (if $job != "" then .job_id = $job else . end)
     | (if $err != "" then .error = $err else . end)
     | (if $adapter != "" then .adapter = $adapter else . end)
     | (if $profile != "" then .profile = $profile else . end)
     | (if $session != "" then .session = $session else . end)
     | (if $model != "" then .model = $model else . end)
     | (if $model_id != "" then .model_id = $model_id else . end)
     | (if $s == "running" and .started == null then .started = $at else . end)
     | (if $s == "running" then .backfilled = false | .hold = null else . end)
     | (if $owner != "" then .owner = $owner else . end)
     | (if $s == "waiting" then .started = null | .finished = null | .error = null | .owner = null | .job_id = null | .owner_kind = null | .owner_id = null | .owner_state = null else . end)
     | (if $s == "done" and $by != "owner-liveness" then .unverified = null | .auto = null else . end)
     | (if ($s == "done" or $s == "error" or $s == "skipped") then .finished = $at else . end)
     | (if $s == "error" then .next_retry_at = $retry_at
        elif ($s == "running" or $s == "waiting" or $s == "done" or $s == "skipped") then .next_retry_at = null
        else . end)' \
    --arg s "$status" --arg job "$job" --arg err "$err" \
    --arg adapter "$adapter" --arg profile "$profile" --arg session "$session" \
    --arg model "$model" --arg model_id "$model_id" \
    --arg retry_at "$retry_at" --arg at "$at" --arg now "$now" --arg owner "$owner" --arg by "${ORCH_EVENT_BY:-cli}" || return 1
  owner_register "$run_id" "$node_id" || true
  run_event "$run_id" status "$node_id" "$old" "$status" "$err"
}

node_reopen_run() {
  local run_id="$1"
  state_write "$run_id" 'if .finished != null then .status = "running" | .finished = null else . end'
}

setting_max_attempts() {
  local value
  value=$(setting_get max_attempts "$MAX_ATTEMPTS_DEFAULT")
  if [ "$value" = "-1" ] || { is_uint "$value" && [ "$value" -ge 1 ]; }; then
    printf '%s\n' "$value"
    return 0
  fi
  printf 'settings.max_attempts must be -1 or an integer >= 1\n' >&2
  return 2
}

epoch_to_iso() {
  local epoch="$1" iso
  iso=$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) && { printf '%s\n' "$iso"; return 0; }
  date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

retry_delay_seconds() {
  local attempt_count="$1" base="${ORCH_AUTO_RETRY_BASE_SECS:-$ADVANCE_INTERVAL_DEFAULT}" delay i
  is_uint "$base" && [ "$base" -ge 1 ] || base="$ADVANCE_INTERVAL_DEFAULT"
  delay="$base"
  i=0
  while [ "$i" -lt "$attempt_count" ] && [ "$delay" -lt "$RETRY_BACKOFF_CAP_SECS" ]; do
    delay=$((delay * 2))
    [ "$delay" -le "$RETRY_BACKOFF_CAP_SECS" ] || delay="$RETRY_BACKOFF_CAP_SECS"
    i=$((i + 1))
  done
  printf '%s\n' "$delay"
}

node_next_retry_at() {
  local run_id="$1" node_id="$2" file attempts delay
  file=$(run_state_file "$run_id")
  attempts=$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | (.attempts // []) | length' "$file")
  delay=$(retry_delay_seconds "$attempts")
  epoch_to_iso "$(($(date -u +%s) + delay))"
}

# node_deps_check <run> <file> <node> <list> - validates an `--after` list for an existing node: each
# id is in the run, not the node itself, and the new edges make no cycle. `*` (alone or in the list)
# marks a gate node that waits on every other non-gate node. Prints the normalized list.
node_deps_check() {
  local run_id="$1" file="$2" node_id="$3" list="$4" dep out="" parts
  IFS=',' read -r -a parts <<< "$list"
  for dep in ${parts[@]+"${parts[@]}"}; do
    dep="${dep// /}"
    [ -n "$dep" ] || continue
    if [ "$dep" = '*' ]; then out="$out${out:+,}*"; continue; fi
    [ "$dep" != "$node_id" ] || { printf 'node update: %s cannot depend on itself\n' "$node_id" >&2; return 2; }
    node_require "$file" "$dep" 2>/dev/null \
      || { printf 'node update: dependency %s is not in run %s\n' "$dep" "$run_id" >&2; return 2; }
    out="$out${out:+,}$dep"
  done
  # A cycle: some new dependency already (transitively) depends on this node.
  local cyc
  cyc=$(jq -r --arg n "$node_id" --arg d "$out" '
    (.edges // []) as $e
    | def reach: . as $seen | ([$seen[] as $s | $e[] | select(.[0] == $s) | .[1]] + $seen | unique) as $next
        | if $next == $seen then $seen else ($next | reach) end;
    ([$n] | reach) as $reach
    | [$d | split(",")[] | select(. != "*" and . != "") | select(. as $x | $reach | index($x))] | join(",")' "$file") || return 2
  [ -z "$cyc" ] || { printf 'node update: --after %s would make a cycle (%s already waits on %s)\n' "$out" "$cyc" "$node_id" >&2; return 2; }
  printf '%s\n' "$out"
}

# node_set_deps_block <run> <node> <deps_set> <deps> <needs_set> <needs> [<hold_set> <hold>] - replaces
# the node's incoming edges (and its `after_all` gate flag) and/or sets or clears `needs_user` and/or
# `hold` (why the coordinator holds a ready node back). One state write; one `deps`, `needs-user`
# and/or `hold` event.
node_set_deps_block() {
  local run_id="$1" node_id="$2" deps_set="$3" deps="$4" needs_set="$5" needs="$6" hold_set="${7:-0}" hold="${8:-}"
  state_write "$run_id" '
    ($deps | split(",") | map(select(length > 0))) as $d
    | (if $ds == 1 then
         .edges = ([(.edges // [])[] | select(.[1] != $n)] + [$d[] | select(. != "*") | [., $n]])
         | .nodes |= map(if .id == $n then .after_all = ($d | index("*") != null) | .updated = $ts else . end)
       else . end)
    | (if $ns == 1 then
         .nodes |= map(if .id == $n then .needs_user = (if $needs == "" then null else $needs end) | .updated = $ts else . end)
       else . end)
    | (if $hs == 1 then
         .nodes |= map(if .id == $n then .hold = (if $hold == "" then null else $hold end) | .updated = $ts else . end)
       else . end)' \
    --arg n "$node_id" --arg deps "$deps" --argjson ds "$deps_set" --argjson ns "$needs_set" \
    --arg needs "$needs" --argjson hs "$hold_set" --arg hold "$hold" --arg ts "$(now_iso)" || return 1
  [ "$deps_set" = 0 ] || run_event "$run_id" deps "$node_id" "" "" "after: ${deps:-none}"
  [ "$needs_set" = 0 ] || run_event "$run_id" needs-user "$node_id" "" "" "${needs:-cleared}"
  [ "$hold_set" = 0 ] || run_event "$run_id" hold "$node_id" "" "" "${hold:-cleared}"
  return 0
}

cmd_node_update() {
  local run_id="${1:-}" node_id="${2:-}" status="${3:-}" job="" err="" at="" owner="" force=0 epoch old allowed file
  local deps="" deps_set=0 needs="" needs_set=0 hold="" hold_set=0
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_UPDATE_USAGE" >&2
    return 2
  fi
  # The status is optional when only deps or the user block change.
  case "$status" in -*|'') status=""; shift 2 ;; *) shift 3 ;; esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --job) shift; job="${1:-}" ;;
      --error) shift; err="${1:-}" ;;
      --at) shift; at="${1:-}" ;;
      --owner) shift; owner="${1:-}" ;;
      --force) force=1 ;;
      --after) [ $# -ge 2 ] || { printf 'node update: --after expects a,b or "*" (or "" to clear)\n' >&2; return 2; }
        shift; deps="$1"; deps_set=1 ;;
      --needs-user) shift; needs="${1:-}"; needs_set=1
        [ -n "$needs" ] || { printf 'node update: --needs-user expects a reason (use --clear-needs-user to clear)\n' >&2; return 2; } ;;
      --clear-needs-user) needs=""; needs_set=1 ;;
      --hold) shift; hold="${1:-}"; hold_set=1
        [ -n "$hold" ] || { printf 'node update: --hold expects a reason (use --clear-hold to clear)\n' >&2; return 2; } ;;
      --clear-hold) hold=""; hold_set=1 ;;
      *) printf 'node update: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [ -z "$status" ] && [ "$deps_set$needs_set$hold_set" = 000 ]; then
    printf 'usage: %s\n' "$NODE_UPDATE_USAGE" >&2
    return 2
  fi
  require_jq "node update"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  [ -z "$status" ] || in_list "$status" "$NODE_STATUSES" || { printf 'node update: status must be one of: %s\n' "$NODE_STATUSES" >&2; return 2; }
  if [ "$deps_set" = 1 ]; then deps=$(node_deps_check "$run_id" "$file" "$node_id" "$deps") || return 2; fi
  if [ -z "$status" ]; then
    node_set_deps_block "$run_id" "$node_id" "$deps_set" "$deps" "$needs_set" "$needs" "$hold_set" "$hold"
    return $?
  fi
  old=$(node_field "$file" "$node_id" status)
  if [ "$old" != "$status" ] && [ "$force" = 0 ]; then
    case "$old" in
      waiting) allowed="running done error skipped" ;;
      running) allowed="done error waiting skipped" ;;
      error) allowed="waiting running skipped" ;;
      skipped) allowed="waiting running" ;;
      done) allowed="" ;;
      *) allowed="$NODE_STATUSES" ;;
    esac
    in_list "$status" "$allowed" || {
      printf 'node update: %s is %s; it can move to: %s%s\n' "$node_id" "$old" "${allowed:-nothing}" \
        "$([ "$old" = done ] && printf ' (done -> waiting needs --force)' || printf ' (--force overrides)')" >&2
      return 2
    }
  fi
  if [ -n "$job" ] && [ "$force" = 0 ] && [ ! -d "$JOBS_HOME/$job" ]; then
    printf 'node update: job %s not found (--force records it anyway)\n' "$job" >&2
    return 2
  fi
  if [ -n "$at" ]; then
    case "$at" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
      *) printf 'node update: --at must be an ISO time like 2026-01-02T03:04:05Z\n' >&2; return 2 ;;
    esac
    epoch=$(to_epoch_iso "$at") || { printf 'node update: --at is not a valid time\n' >&2; return 2; }
    [ "$epoch" -le "$(date -u +%s)" ] || { printf 'node update: --at is in the future\n' >&2; return 2; }
  fi
  NODE_EVENT_AT="$at" NODE_OWNER="$owner" node_set_status "$run_id" "$node_id" "$status" "$job" "$err" || return $?
  [ "$status" != done ] || [ "$old" = done ] || node_done_verify "$run_id" "$node_id" || true
  if [ "$deps_set" = 1 ] || [ "$needs_set" = 1 ] || [ "$hold_set" = 1 ]; then
    node_set_deps_block "$run_id" "$node_id" "$deps_set" "$deps" "$needs_set" "$needs" "$hold_set" "$hold" || return 1
  fi
  # A session-bound node that just ended takes its final session totals now: the reconciler may
  # never look at the run again once its last node is done.
  case "$status" in
    done|error|skipped) [ "${ORCH_OWNER_FILL:-1}" = 0 ] || [ ! -f "$(opencode_db_path)" ] || owners_fill_index_run "$run_id" >/dev/null 2>&1 || true ;;
  esac
}

# node report <run-id> <node-id> [--model M] [--input-tokens N] [--output-tokens N]
#   [--cache-read-tokens N] [--usd X] [--note "text"] — records what a node done inline (claude-native)
# or by a subagent used. An omitted flag keeps the earlier reported value, else null: nothing is
# estimated.
cmd_node_report() {
  local run_id="${1:-}" node_id="${2:-}" model="" in_tok="" out_tok="" cache_tok="" usd="" note="" file
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_REPORT_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) shift; model="${1:-}" ;;
      --input-tokens) shift; in_tok="${1:-}" ;;
      --output-tokens) shift; out_tok="${1:-}" ;;
      --cache-read-tokens) shift; cache_tok="${1:-}" ;;
      --usd) shift; usd="${1:-}" ;;
      --note) shift; note="${1:-}" ;;
      *) printf 'node report: unknown argument %s\n  usage: %s\n' "$1" "$NODE_REPORT_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  local tok
  for tok in "$in_tok" "$out_tok" "$cache_tok"; do
    [ -z "$tok" ] || is_uint "$tok" || { printf 'node report: token counts must be whole numbers\n' >&2; return 2; }
  done
  case "$usd" in
    ''|*[!0-9.]*|*.*.*|.) [ -z "$usd" ] || { printf 'node report: --usd must be a non-negative number\n' >&2; return 2; } ;;
  esac
  if [ -z "$model$in_tok$out_tok$cache_tok$usd$note" ]; then
    printf 'node report: nothing to record\n  usage: %s\n' "$NODE_REPORT_USAGE" >&2
    return 2
  fi
  require_jq "node report"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  node_patch "$run_id" "$node_id" \
    '(.report // {}) as $o
     | .updated = $ts
     | (if $model != "" then .model = $model else . end)
     | .report = {reported_by: "inline",
                  model: (if $model == "" then ($o.model // null) else $model end),
                  input_tokens: (if $in == "" then ($o.input_tokens // null) else ($in | tonumber) end),
                  output_tokens: (if $out == "" then ($o.output_tokens // null) else ($out | tonumber) end),
                  cache_read_tokens: (if $cache == "" then ($o.cache_read_tokens // null) else ($cache | tonumber) end),
                  usd: (if $usd == "" then ($o.usd // null) else ($usd | tonumber) end),
                  note: (if $note == "" then ($o.note // null) else $note end),
                  at: $ts,
                  # Fields captured from the session (owner-fill), not given here: the filler keeps
                  # refreshing them, and they never count as figures the coordinator gave.
                  auto: ((if ($o.reported_by // "") | IN("owner-fill", "owner-liveness")
                          then ["input_tokens", "output_tokens", "cache_read_tokens", "usd"] | map(select($o[.] != null))
                          else ($o.auto // []) end)
                         - [(if $in != "" then "input_tokens" else empty end), (if $out != "" then "output_tokens" else empty end),
                            (if $cache != "" then "cache_read_tokens" else empty end), (if $usd != "" then "usd" else empty end)]
                         | if length == 0 then null else . end)}' \
    --arg model "$model" --arg in "$in_tok" --arg out "$out_tok" --arg cache "$cache_tok" \
    --arg usd "$usd" --arg note "$note" --arg ts "$(now_iso)" || return 1
  [ -z "$note" ] || run_event "$run_id" note "$node_id" "" "" "$note"
}

# node dispatch <run> <node> (--profile P | <adapter> | <prompt-using-node-profile>) [<prompt>] [args…]
cmd_node_dispatch() {
  local run_id="${1:-}" node_id="${2:-}" file status node_profile job_id raw_prompt args_json start i
  local -a dispatch_argv pass_args
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ -z "${3:-}" ]; then
    printf 'usage: %s\n' "$NODE_DISPATCH_USAGE" >&2
    return 2
  fi
  shift 2
  require_jq "node dispatch"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  status=$(node_field "$file" "$node_id" status)
  [ "$status" = "waiting" ] || { printf 'node dispatch: %s is %s, not waiting\n' "$node_id" "$status" >&2; return 2; }

  # Neither --profile nor an adapter name first → the node's own profile (from `node add`) applies.
  if [ "$1" != "--profile" ] && ! in_list "$1" "$ADAPTER_NAMES"; then
    node_profile=$(node_field "$file" "$node_id" profile)
    [ -n "$node_profile" ] || { printf 'node dispatch: %s has no profile; pass --profile or an adapter\n' "$node_id" >&2; return 2; }
    set -- --profile "$node_profile" "$@"
  fi
  dispatch_argv=("$@")
  pass_args=()
  if [ "${dispatch_argv[0]}" = "--profile" ]; then
    raw_prompt="${dispatch_argv[2]:-}"
    start=3
  else
    raw_prompt="${dispatch_argv[1]:-}"
    start=2
  fi
  for ((i = start; i < ${#dispatch_argv[@]}; i++)); do
    pass_args+=("${dispatch_argv[$i]}")
  done
  if [ "${#pass_args[@]}" -eq 0 ]; then
    args_json='[]'
  else
    args_json=$(printf '%s\n' "${pass_args[@]}" | jq -R -s 'split("\n")[:-1]')
  fi

  # The node is told where to put its handoff through the environment, so its prompt can stay
  # about the task rather than carrying a path.
  ORCH_NODE_OUT=$(node_out_dir "$run_id" "$node_id")
  mkdir -p "$ORCH_NODE_OUT" || { printf 'node dispatch: cannot create %s\n' "$ORCH_NODE_OUT" >&2; return 1; }
  ORCH_RUN_ID="$run_id"
  ORCH_NODE_ID="$node_id"
  # ORCH_DISPATCH + HARNESS_ORCH_HOME let the node reach this same CLI and state dir — that is
  # how it sends and reads run messages (`msg send|read`) without knowing where orch lives.
  ORCH_DISPATCH="$SELF_REAL"
  HARNESS_ORCH_HOME="$ORCH_HOME"
  export ORCH_NODE_OUT ORCH_RUN_ID ORCH_NODE_ID ORCH_DISPATCH HARNESS_ORCH_HOME
  # The attempt is the count of archived attempts plus one, so retries get their own worker id.
  ORCH_NODE_ATTEMPT=$(( $(jq -r --arg n "$node_id" '(.nodes[] | select(.id == $n) | (.attempts // []) | length)' "$file") + 1 ))
  ORCH_NODE_ROLE=$(node_field "$file" "$node_id" role)
  ORCH_NODE_TIER=$(node_field "$file" "$node_id" tier)
  ORCH_NODE_ACCEPTANCE=$(node_field "$file" "$node_id" acceptance)
  export ORCH_NODE_ATTEMPT ORCH_NODE_ROLE ORCH_NODE_TIER ORCH_NODE_ACCEPTANCE
  hub_node_expect "$run_id" "$node_id" "$ORCH_NODE_TIER" "$ORCH_NODE_ROLE" \
    "$run_id/$node_id/$ORCH_NODE_ATTEMPT" || true

  job_id=$(cmd_start "$@") || return $?
  node_record_worker "$run_id" "$node_id" "$job_id" || return 1
  node_set_status "$run_id" "$node_id" running "$job_id" "" "$(cat "$JOBS_HOME/$job_id/adapter" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/profile" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/session" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/model" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/model_id" 2>/dev/null)" || return 1
  node_patch "$run_id" "$node_id" '.prompt = $prompt | .dispatch_args = $args' \
    --arg prompt "$raw_prompt" --argjson args "$args_json" || return 1
  printf '%s\n' "$job_id"
  # With herdr on, name the node's pane so the coordinator and sibling nodes can reach it.
  if [ -s "$JOBS_HOME/$job_id/herdr_pane" ]; then
    printf 'node dispatch: %s runs in herdr pane %s; reach it with HOME=%s herdr pane read|send-text %s\n' \
      "$node_id" "$(cat "$JOBS_HOME/$job_id/herdr_pane")" "$(cat "$JOBS_HOME/$job_id/herdr_home" 2>/dev/null)" \
      "$(cat "$JOBS_HOME/$job_id/herdr_pane")" >&2
  fi
}

# Records how this dispatch's worker identity travels. The Claude and opencode adapters send the Smart Auto
# headers; every other harness gets the preset model id, so its worker identity is recorded as absent.
node_record_worker() {
  local run_id="$1" node_id="$2" job_id="$3" adapter transport="" worker=""
  adapter=$(cat "$JOBS_HOME/$job_id/adapter" 2>/dev/null)
  case "$adapter" in
    claude|opencode) transport=headers; worker="$run_id/$node_id/$ORCH_NODE_ATTEMPT" ;;
    claude-native) ;;
    *) transport=preset-model ;;
  esac
  node_patch "$run_id" "$node_id" \
    '.metadata_transport = (if $t == "" then null else $t end) | .worker_identity = (if $w == "" then null else $w end)' \
    --arg t "$transport" --arg w "$worker"
}

# Pulls the hub's selection events for every attempt of this node and appends the new ones.
# Events at or below the stored hub sequence are dropped, so a repeated call is a no-op.
cmd_node_selections() {
  local run_id="${1:-}" node_id="${2:-}" file since attempts attempt body page events="[]" count
  local -a auth=()
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ $# -gt 2 ]; then
    printf 'usage: %s\n' "$NODE_SELECTIONS_USAGE" >&2
    return 2
  fi
  require_jq "node selections"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  orch_load_env_file
  [ -n "${LLM_HUB_URL:-}" ] || { printf 'node selections: LLM_HUB_URL not set\n' >&2; return 2; }
  [ -z "${LLM_HUB_KEY:-}" ] || auth=(-H "Authorization: Bearer $LLM_HUB_KEY")
  since=$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | .last_event_sequence // 0' "$file")
  attempts=$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | ((.attempts // []) | length) + 1' "$file")
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    body=$(curl -sS --max-time "$SELECTION_HTTP_TIMEOUT" -G ${auth[@]+"${auth[@]}"} \
      --data-urlencode "worker=$run_id/$node_id/$attempt" \
      --data-urlencode "since_seq=$since" \
      --data-urlencode "limit=$SELECTION_PAGE_LIMIT" \
      "${LLM_HUB_URL%/}/api/smart-auto/history") \
      || { printf 'node selections: request to %s failed\n' "$LLM_HUB_URL" >&2; return 1; }
    page=$(printf '%s' "$body" | jq -c 'if type == "array" then . else (.events // []) end' 2>/dev/null) \
      || { printf 'node selections: hub answered with something other than history\n' >&2; return 1; }
    events=$(jq -cn --argjson a "$events" --argjson p "$page" '$a + $p')
  done
  count=$(printf '%s' "$events" | jq -r --argjson since "$since" '[.[] | select(.seq > $since)] | length')
  node_patch "$run_id" "$node_id" '
      (.last_event_sequence // 0) as $last
      | ((.selection_history // []) + [$events[] | select(.seq > $last)]
        | unique_by(.seq) | sort_by(.seq)) as $all
      | (if ($all | length) > $max then $all[($all | length) - $max:] else $all end) as $hist
      | .selection_history = $hist
      | .last_event_sequence = (if ($hist | length) > 0 then ($hist | last | .seq) else .last_event_sequence end)
      | .requested_selector = (if ($hist | length) > 0 then ($hist | last | .requested_selector) else .requested_selector end)
      | .main_model = (([$hist[] | select(.stage == "solver" and .model != null)] | last | .model) // .main_model)
      | .active_stages = ([$hist[] | {k: [.attempt_key, .stage], s: .}] | group_by(.k)
          | map(last | .s) | map(select(.state == "selected" or .state == "started") | .stage) | unique)' \
    --argjson events "$events" --argjson max "$SELECTION_HISTORY_MAX" || return 1
  printf 'selections: %s new\n' "$count"
}

node_retry_target_args() {
  local override="$1" current_profile="$2" adapter="$3"
  if [ -n "$override" ]; then
    if in_list "$override" "$ADAPTER_NAMES"; then
      printf '%s\n' "$override"
    else
      printf '%s\n%s\n' "--profile" "$override"
    fi
    return 0
  fi
  if [ -n "$current_profile" ]; then
    printf '%s\n%s\n' "--profile" "$current_profile"
    return 0
  fi
  if [ -n "$adapter" ]; then
    printf '%s\n' "$adapter"
    return 0
  fi
  return 1
}

node_archive_attempt() {
  local run_id="$1" node_id="$2" reason="$3" retry_mode="$4" retry_session="$5"
  node_patch "$run_id" "$node_id" \
    '.attempts = ((.attempts // []) + [{
       job_id: .job_id,
       error: .error,
       finished: .finished,
       log_tail: (.log_tail // []),
       profile: .profile,
       adapter: .adapter,
       model: (.model // null),
       model_id: (.model_id // null),
       actual_model: (.actual_model // null),
       cost: (.cost // null),
       session: (.session // null),
       reason: (if $reason == "" then null else $reason end),
       retry_mode: (if $retry_mode == "" then null else $retry_mode end),
       retry_session: (if $retry_session == "" then null else $retry_session end)
     }])' \
    --arg reason "$reason" --arg retry_mode "$retry_mode" --arg retry_session "$retry_session"
}

node_reset_for_retry() {
  local run_id="$1" node_id="$2" profile="$3" adapter="$4"
  node_patch "$run_id" "$node_id" \
    '.status = "waiting"
     | .job_id = null
     | .adapter = (if $adapter == "" then null else $adapter end)
     | .profile = (if $profile == "" then null else $profile end)
     | .session = null
     | .started = null
     | .finished = null
     | .error = null
     | .log_tail = []
     | .cost = null
     | .actual_model = null
     | .updated = $ts
     | .next_retry_at = null' \
    --arg profile "$profile" --arg adapter "$adapter" --arg ts "$(now_iso)" || return 1
  run_event "$run_id" retry "$node_id" "" waiting ""
}

node_retry_dispatch() {
  local run_id="$1" node_id="$2" override="$3" no_dispatch="$4" reason="$5" supplied_prompt="${6:-}" file status prompt profile adapter
  local old_profile old_adapter previous_session target_adapter summary retry_mode="" resume_session="" dispatch_prompt original_text job_id
  file=$(run_state_file "$run_id")
  status=$(node_field "$file" "$node_id" status)
  case "$status" in
    error|skipped|stopped) ;;
    *) printf 'node retry: %s is %s, not error or skipped\n' "$node_id" "$status" >&2; return 2 ;;
  esac
  prompt=$(node_field "$file" "$node_id" prompt)
  [ -n "$prompt" ] || prompt="$supplied_prompt"
  profile=$(node_field "$file" "$node_id" profile)
  adapter=$(node_field "$file" "$node_id" adapter)
  old_profile="$profile"
  old_adapter="$adapter"
  previous_session=$(node_field "$file" "$node_id" session)
  [ -n "$old_adapter" ] || { [ -n "$old_profile" ] && old_adapter=$(profile_harness "$old_profile"); }
  if [ -n "$override" ]; then
    if in_list "$override" "$ADAPTER_NAMES"; then
      profile=""
      adapter="$override"
    else
      profile="$override"
      adapter=""
      profile_require "$profile" >/dev/null || return 2
    fi
  fi
  target_adapter="$adapter"
  [ -n "$target_adapter" ] || { [ -n "$profile" ] && target_adapter=$(profile_harness "$profile"); }
  summary=$(node_error_summary "$file" "$node_id")
  if [ "$no_dispatch" -eq 0 ] && [ -n "$prompt" ] && [ -n "$previous_session" ] \
      && [ "$target_adapter" = "$old_adapter" ] && adapter_supports_resume "$target_adapter" "$previous_session"; then
    retry_mode="resumed"
    resume_session="$previous_session"
    dispatch_prompt=$(retry_continue_prompt "$summary")
  elif [ "$no_dispatch" -eq 0 ] && [ -n "$prompt" ]; then
    retry_mode="restarted"
    original_text=$(resolve_prompt "$prompt") || return 1
    dispatch_prompt=$(retry_restart_prompt "$old_profile" "$summary" "$original_text")
  else
    dispatch_prompt="$prompt"
  fi
  node_archive_attempt "$run_id" "$node_id" "$reason" "$retry_mode" "$resume_session" || return 1
  node_reset_for_retry "$run_id" "$node_id" "$profile" "$adapter" || return 1
  node_reopen_run "$run_id" || return 1
  if [ "$no_dispatch" -eq 1 ] || [ -z "$prompt" ]; then
    [ -z "$prompt" ] || node_patch "$run_id" "$node_id" '.prompt = $prompt' --arg prompt "$prompt" || return 1
    printf 'waiting: %s\n' "$node_id"
    return 0
  fi
  local -a target extra
  target=()
  extra=()
  while IFS= read -r arg; do target+=("$arg"); done <<EOF
$(node_retry_target_args "$override" "$profile" "$adapter")
EOF
  if [ "${#target[@]}" -eq 0 ]; then
    printf 'node retry: %s has no profile or adapter; pass --profile or an adapter\n' "$node_id" >&2
    return 2
  fi
  while IFS= read -r arg; do [ -n "$arg" ] && extra+=("$arg"); done <<EOF
$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | (.dispatch_args // [])[]' "$file")
EOF
  if [ "${#extra[@]}" -eq 0 ]; then
    job_id=$(ORCH_RESUME_SESSION="$resume_session" cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$dispatch_prompt") || return $?
    node_patch "$run_id" "$node_id" '.prompt = $prompt' --arg prompt "$prompt" || return 1
    printf '%s\n' "$job_id"
    return $?
  fi
  job_id=$(ORCH_RESUME_SESSION="$resume_session" cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$dispatch_prompt" "${extra[@]}") || return $?
  node_patch "$run_id" "$node_id" '.prompt = $prompt' --arg prompt "$prompt" || return 1
  printf '%s\n' "$job_id"
}

node_dispatch_stored() {
  local run_id="$1" node_id="$2" prompt="$3" file profile adapter
  local -a target extra
  file=$(run_state_file "$run_id")
  profile=$(node_field "$file" "$node_id" profile)
  adapter=$(node_field "$file" "$node_id" adapter)
  target=()
  extra=()
  while IFS= read -r arg; do target+=("$arg"); done <<EOF
$(node_retry_target_args "" "$profile" "$adapter")
EOF
  while IFS= read -r arg; do [ -n "$arg" ] && extra+=("$arg"); done <<EOF
$(jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | (.dispatch_args // [])[]' "$file")
EOF
  if [ "${#target[@]}" -eq 0 ]; then
    cmd_node_dispatch "$run_id" "$node_id" "$prompt"
    return $?
  fi
  if [ "${#extra[@]}" -eq 0 ]; then
    cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$prompt"
    return $?
  fi
  cmd_node_dispatch "$run_id" "$node_id" "${target[@]}" "$prompt" "${extra[@]}"
}

cmd_node_retry() {
  local run_id="${1:-}" node_id="${2:-}" override="" no_dispatch=0 prompt="" file
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_RETRY_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; override="${1:-}" ;;
      --no-dispatch) no_dispatch=1 ;;
      --*) printf 'node retry: unknown argument %s\n  usage: %s\n' "$1" "$NODE_RETRY_USAGE" >&2; return 2 ;;
      *)
         if [ -z "$override" ] && in_list "$1" "$ADAPTER_NAMES"; then
           override="$1"
         elif [ -z "$prompt" ]; then
           prompt="$1"
         else
           printf 'node retry: pass at most one prompt\n  usage: %s\n' "$NODE_RETRY_USAGE" >&2
           return 2
         fi ;;
    esac
    shift
  done
  require_jq "node retry"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  node_retry_dispatch "$run_id" "$node_id" "$override" "$no_dispatch" "manual retry" "$prompt"
}

cmd_run_retry() {
  local run_id="${1:-}" override="" no_dispatch=0 file max_parallel running slots id retried="" queued=""
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_RETRY_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; override="${1:-}" ;;
      --no-dispatch) no_dispatch=1 ;;
      *) printf 'run retry: unknown argument %s\n  usage: %s\n' "$1" "$RUN_RETRY_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run retry"
  file=$(run_require "$run_id") || return $?
  [ -z "$override" ] || profile_require "$override" >/dev/null || return 2
  max_parallel=$(setting_uint max_parallel "$MAX_PARALLEL_DEFAULT")
  running=$(jq '[.nodes[] | select(.status == "running")] | length' "$file")
  slots=$((max_parallel - running))
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ "$no_dispatch" -eq 0 ] && [ "$slots" -gt 0 ]; then
      node_retry_dispatch "$run_id" "$id" "$override" 0 "manual run retry" >/dev/null || return $?
      retried="$retried${retried:+,}$id"
      slots=$((slots - 1))
    else
      node_retry_dispatch "$run_id" "$id" "$override" 1 "manual run retry" >/dev/null || return $?
      queued="$queued${queued:+,}$id"
    fi
  done <<EOF
$(jq -r '.nodes[] | select(.status == "error") | .id' "$file")
EOF
  printf 'retried: %s\n' "$retried"
  printf 'waiting: %s\n' "$queued"
}

profile_usable() {
  local profile="$1"
  jq -e --arg p "$profile" '
    (.settings.disabled_harnesses // []) as $disabled
    | (.profiles[$p] // null) as $prof
    | $prof != null and ($prof.enabled // true) != false and (($disabled | index($prof.harness)) == null)
  ' "$PROFILES_FILE" >/dev/null 2>&1
}

profile_fallback() {
  jq -r --arg p "$1" '.profiles[$p].fallback // empty' "$PROFILES_FILE" 2>/dev/null
}

profile_harness() {
  jq -r --arg p "$1" '.profiles[$p].harness // empty' "$PROFILES_FILE" 2>/dev/null
}

adapter_supports_resume() {
  case "$1" in
    claude|copilot|opencode) return 0 ;;
    cursor-agent)
      case "$2" in cursor:*) return 0 ;; esac
      return 1
      ;;
    *) return 1 ;;
  esac
}

node_error_summary() {
  local file="$1" node_id="$2"
  jq -r --arg n "$node_id" '
    .nodes[] | select(.id == $n)
    | if ((.error // "") != "") then .error
      else ((.log_tail // []) | join(" | "))
      end
    | .[0:500]
  ' "$file"
}

retry_continue_prompt() {
  local summary="$1"
  cat <<EOF
The previous attempt stopped with: ${summary:-unknown error}.
Continue the same task from where you left off; check \$ORCH_NODE_OUT for any partial handoff or notes from the previous attempt.
EOF
}

retry_restart_prompt() {
  local old_profile="$1" summary="$2" original="$3"
  cat <<EOF
Previous attempt on ${old_profile:-unknown profile} failed with: ${summary:-unknown error}.
Partial work may already exist in the repo and in \$ORCH_NODE_OUT. Inspect before changing files and continue carefully.

$original
EOF
}

node_error_is_quota_like() {
  local file="$1" node_id="$2"
  jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | [(.error // ""), ((.log_tail // [])[])] | join("\n")' "$file" \
    | grep -Eiq 'exceeded your monthly quota|rate limit|429|quota|usage limit|401|auth'
}

node_auto_retry_override() {
  local file="$1" node_id="$2" profile fallback
  profile=$(node_field "$file" "$node_id" profile)
  if [ -n "$profile" ] && node_error_is_quota_like "$file" "$node_id"; then
    fallback=$(profile_fallback "$profile")
    if [ -n "$fallback" ] && profile_usable "$fallback"; then
      printf '%s\n' "$fallback"
      return 0
    fi
  fi
  printf '\n'
}

node_auto_retry_reason() {
  local file="$1" node_id="$2" override="$3" profile
  profile=$(node_field "$file" "$node_id" profile)
  if [ -n "$override" ] && [ "$override" != "$profile" ]; then
    printf 'auto retry: quota/rate/auth matched; fallback profile %s\n' "$override"
    return 0
  fi
  if node_error_is_quota_like "$file" "$node_id"; then
    printf 'auto retry: quota/rate/auth matched; no usable fallback\n'
    return 0
  fi
  printf 'auto retry\n'
}

run_auto_retry_errors() {
  local run_id="$1" file="$2" max_attempts max_parallel running slots id override reason retried="" now retry_at
  [ "$(jq -r '.status' "$file")" != "cancelled" ] || return 0
  max_attempts=$(setting_max_attempts) || return $?
  [ "$max_attempts" = "-1" ] || [ "$max_attempts" -gt 1 ] || return 0
  max_parallel=$(setting_uint max_parallel "$MAX_PARALLEL_DEFAULT")
  running=$(jq '[.nodes[] | select(.status == "running")] | length' "$file")
  slots=$((max_parallel - running))
  [ "$slots" -gt 0 ] || return 0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    retry_at=$(node_next_retry_at "$run_id" "$id")
    node_patch "$run_id" "$id" '.next_retry_at = $retry_at' --arg retry_at "$retry_at" || return 1
  done <<EOF
$(jq -r '.nodes[]
  | select(.status == "error")
  | select((.prompt // "") != "")
  | select((.next_retry_at // "") == "")
  | .id' "$file")
EOF
  now=$(date -u +%s)
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    [ "$slots" -gt 0 ] || break
    override=$(node_auto_retry_override "$file" "$id")
    reason=$(node_auto_retry_reason "$file" "$id" "$override")
    node_retry_dispatch "$run_id" "$id" "$override" 0 "$reason" >/dev/null || return $?
    retried="$retried${retried:+,}$id"
    slots=$((slots - 1))
  done <<EOF
$(jq -r --argjson max "$max_attempts" --argjson now "$now" '
  def due:
    (.next_retry_at // "") as $next
    | $next != "" and (($next | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) <= $now);
  .nodes[]
  | select(.status == "error")
  | select((.prompt // "") != "")
  | select(due)
  | select($max == -1 or (((.attempts // []) | length) + 1 < $max))
  | .id' "$file")
EOF
  [ -z "$retried" ] || printf 'auto-retried: %s\n' "$retried" >&2
}

# A node moved by `run carry` keeps its handoff folder in the run it came from (a running job already holds
# that path), recorded as `out_dir`; every other node's folder is under its own run.
node_out_dir() {
  local recorded=""
  [ -f "$(run_state_file "$1")" ] && recorded=$(jq -r --arg n "$2" '.nodes[]? | select(.id == $n) | .out_dir // empty' "$(run_state_file "$1")" 2>/dev/null)
  if [ -n "$recorded" ]; then printf '%s\n' "$recorded"; else printf '%s/%s/out/%s\n' "$RUNS_HOME" "$1" "$2"; fi
}

# node_done_verify <run> <node> - called right after a node turns done (node update, run sync). A done
# node must leave a non-empty handoff.md in its output dir; when it did not, print one warning line
# on stderr and mark the node `unverified`, so "done" is never reported on trust alone.
node_done_verify() {
  local run_id="$1" node_id="$2" handoff
  handoff="$(node_out_dir "$run_id" "$node_id")/handoff.md"
  [ -s "$handoff" ] && return 0
  printf 'done without handoff: %s (%s missing or empty), marked unverified\n' "$node_id" "$handoff" >&2
  node_patch "$run_id" "$node_id" '.unverified = true' || return 1
  run_event "$run_id" note "$node_id" "" "" "done without handoff: marked unverified" || true
}

# The handoff channel between nodes: a node writes what the next one must read here, and the
# orchestrator passes the path rather than the contents.
cmd_node_out() {
  local run_id="${1:-}" node_id="${2:-}" file dir
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ $# -gt 2 ]; then
    printf 'usage: %s\n' "$NODE_OUT_USAGE" >&2
    return 2
  fi
  require_jq "node out"
  file=$(run_require "$run_id") || return $?
  valid_id "$node_id" || { printf 'node out: id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  node_require "$file" "$node_id" || return 2
  dir=$(node_out_dir "$run_id" "$node_id")
  mkdir -p "$dir" || { printf 'node out: cannot create %s\n' "$dir" >&2; return 1; }
  printf '%s\n' "$dir"
}

# What the orchestrator reads instead of the log itself, so its context stays flat however much
# a node printed.
cmd_node_digest() {
  local run_id="${1:-}" node_id="${2:-}" lines="$DIGEST_LINES_DEFAULT"
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_DIGEST_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --lines)
        shift
        lines="${1:-}"
        is_uint "$lines" && [ "$lines" -ge 1 ] && [ "$lines" -le "$DIGEST_LINES_MAX" ] \
          || { printf 'node digest: --lines expects 1..%s\n' "$DIGEST_LINES_MAX" >&2; return 2; }
        ;;
      *) printf 'node digest: unknown argument %s\n  usage: %s\n' "$1" "$NODE_DIGEST_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node digest"
  local file
  file=$(run_require "$run_id") || return $?
  valid_id "$node_id" || { printf 'node digest: id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  node_require "$file" "$node_id" || return 2

  local status job log bytes total elided
  status=$(node_field "$file" "$node_id" status)
  job=$(node_field "$file" "$node_id" job_id)
  printf 'node: %s (%s)\n' "$node_id" "$status"
  printf 'out: %s\n' "$(node_out_dir "$run_id" "$node_id")"
  jq -r --arg n "$node_id" '.nodes[] | select(.id == $n) | .report // empty
    | "reported: \(.reported_by) model=\(.model // "-") in=\(.input_tokens // "-") out=\(.output_tokens // "-") usd=\(.usd // "-")"' "$file"
  if [ -z "$job" ]; then
    printf 'log: not dispatched\n'
    return 0
  fi
  printf 'job: %s\n' "$job"
  local job_st
  job_st=$(job_status "$job" 2>/dev/null || printf 'unknown')
  printf 'exit: %s\n' "${job_st#done exit=}"
  log="$JOBS_HOME/$job/log"
  [ -f "$log" ] || { printf 'log: none on disk\n'; return 0; }
  bytes=$(wc -c < "$log" | tr -d ' ')
  total=$(wc -l < "$log" | tr -d ' ')
  printf 'log: %s bytes, %s lines\n' "$bytes" "$total"
  if [ "$total" -le $((lines * 2)) ]; then
    cat "$log"
    return 0
  fi
  elided=$((total - lines * 2))
  printf -- '--- first %s ---\n' "$lines"
  head -n "$lines" "$log"
  printf -- '--- %s lines elided ---\n' "$elided"
  printf -- '--- last %s ---\n' "$lines"
  tail -n "$lines" "$log"
}

# node_cost_from_job <run-id> <node-id> <job-id> — copies a job's cost sidecar onto its node.
# Silent no-op when the job wrote none: only the claude adapter reports cost, and only when jq
# was available, so an absent sidecar is the common case rather than a fault.
node_cost_from_job() {
  local run_id="$1" node_id="$2" job_id="$3"
  # Separate statement: `local` has its arguments expanded before any of them is assigned, so a
  # path built from job_id in the same declaration reads it while it is still unset (set -u).
  local file="$JOBS_HOME/$job_id/usage.json"
  [ -f "$file" ] || return 0
  jq -e 'type == "object" and has("usd")' "$file" >/dev/null 2>&1 || return 0
  node_patch "$run_id" "$node_id" '.cost = $c' --argjson c "$(cat "$file")"
}

# node cost <run-id> <node-id> (--from-job <job-id> | --clear) — the explicit route. `run sync`
# does this automatically when a node's own job finishes; this is for a caller driving the state
# itself, and for tests.
cmd_node_cost() {
  local run_id="${1:-}" node_id="${2:-}" job_id="" clear=0
  if [ -z "$run_id" ] || [ -z "$node_id" ]; then
    printf 'usage: %s\n' "$NODE_COST_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --from-job)
        shift
        job_id="${1:-}"
        [ -n "$job_id" ] || { printf 'node cost: --from-job expects a job id\n  usage: %s\n' "$NODE_COST_USAGE" >&2; return 2; }
        ;;
      --clear) clear=1 ;;
      *) printf 'node cost: unknown argument %s\n  usage: %s\n' "$1" "$NODE_COST_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node cost"
  local file
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  if [ "$clear" -eq 1 ] && [ -n "$job_id" ]; then
    printf 'node cost: pass either --from-job or --clear, not both\n  usage: %s\n' "$NODE_COST_USAGE" >&2
    return 2
  fi
  if [ "$clear" -eq 1 ]; then
    node_patch "$run_id" "$node_id" '.cost = null'
    return $?
  fi
  if [ -z "$job_id" ]; then
    printf 'node cost: nothing to do — pass --from-job or --clear\n  usage: %s\n' "$NODE_COST_USAGE" >&2
    return 2
  fi
  [ -f "$JOBS_HOME/$job_id/usage.json" ] || {
    printf 'node cost: job %s recorded no usage\n' "$job_id" >&2
    return 1
  }
  node_cost_from_job "$run_id" "$node_id" "$job_id"
}

# Re-reads each running node's job and flips it to done/error; prints one `id<TAB>status` line per
# node, then `ready: …` (waiting nodes whose deps are all done) and `running: <count>`.
# --lock (or ORCH_SYNC_LOCK=1, set by the reconciler and watches): at most one sync per run at a time.
cmd_run_sync() {
  local a lock="${ORCH_SYNC_LOCK:-0}" rc
  for a in "$@"; do [ "$a" = --lock ] && lock=1; done
  if [ "$lock" = 1 ] && [ -n "${1:-}" ]; then
    if ! orch_lock_acquire "sync-$1"; then
      printf 'run sync: a previous sync of %s is still running, skipped\n' "$1" >&2
      return 0
    fi
    run_sync_body "$@"; rc=$?
    orch_lock_release "sync-$1"
    return $rc
  fi
  run_sync_body "$@"
}

run_sync_body() {
  local run_id="${1:-}" file node job st tail_json retry=1 stale owner_lines=""
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_SYNC_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-retry) retry=0 ;;
      --verify-owners|--lock) ;;
      *) printf 'run sync: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run sync"
  file=$(run_require "$run_id") || return $?

  while IFS=$'\t' read -r node job; do
    [ -n "$node" ] && [ -n "$job" ] || continue
    st=$(job_status "$job" 2>/dev/null || printf 'done exit=unknown')
    tail_json=$(tail -n "$LOG_TAIL_LINES" "$JOBS_HOME/$job/log" 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0))')
    case "$st" in
      running) ;;
      "done exit=0") node_set_status "$run_id" "$node" "done"; node_done_verify "$run_id" "$node" || true
        hub_node_settle "$run_id" "$node" done || true ;;
      done*)
        case "$st" in "done exit=unknown"*) run_event "$run_id" note "$node" "" "" "$(herdr_job_gone_note "$JOBS_HOME/$job")" ;; esac
        node_set_status "$run_id" "$node" error "" "${st#done }"; hub_node_settle "$run_id" "$node" error || true ;;
    esac
    node_patch "$run_id" "$node" '.log_tail = $t' --argjson t "${tail_json:-[]}"
    # The adapter writes its cost beside the log; this is the only place it reaches the node.
    node_cost_from_job "$run_id" "$node" "$job"
  done <<EOF
$(jq -r '.nodes[] | select(.status == "running" and .job_id != null) | "\(.id)\t\(.job_id)"' "$file")
EOF

  owner_lines=$(owners_verify_run "$run_id" 1 | owner_report_lines)

  if [ "$retry" = 1 ]; then run_auto_retry_errors "$run_id" "$file" || return $?; fi

  jq -r '.nodes[] | "\(.id)\t\(.status)"' "$file"
  [ -z "$owner_lines" ] || printf '%s\n' "$owner_lines"
  stale=$(run_stale_nodes "$run_id" "$(run_activity_rows "$run_id")")
  # One jq for every summary line after the owner lines (it used to be five plus one per stale check).
  jq -r --argjson max "$(setting_uint max_parallel "$MAX_PARALLEL_DEFAULT")" --arg stale "$stale" "$NODE_READY_JQ_DEF"'. as $r
    | ([.nodes[] | select(.status == "running")] | length) as $running
    | "ready: " + ([ .nodes[] | select(.status == "waiting") | .id as $n
        | select(node_ready($r))
        | .id ] | join(",")),
      "running: \($running)",
      # Free dispatch slots under settings.max_parallel: dispatch at most this many of `ready:`.
      "slots: \([0, $max - $running] | max)",
      (if $stale != "" then "stale: " + $stale else empty end),
      ([.nodes[] | select(.status == "running" and .stalled == true) | .id] | if length > 0 then "stalled: " + join(",") else empty end),
      ([.nodes[] | select(.status == "running" and ((.owner // "") == "") and ((.job_id // "") == "")) | .id]
        | if length > 0 then "unowned: " + join(",") else empty end),
      (.nodes[] | select(.report != null) | .report as $p
        | "reported: \(.id) \($p.reported_by) model=\($p.model // "-") in=\($p.input_tokens // "-") out=\($p.output_tokens // "-") usd=\($p.usd // "-")")' "$file"
}

# --- retention ---------------------------------------------------------------------------------

RETENTION_DEFAULT_DAYS=7
SECS_PER_DAY=86400
SECS_PER_HOUR=3600

# parse_age <N>d | <N>h | <N> (days) → seconds.
parse_age() {
  local spec="$1" num unit
  case "$spec" in
    *d) num="${spec%d}"; unit=$SECS_PER_DAY ;;
    *h) num="${spec%h}"; unit=$SECS_PER_HOUR ;;
    *)  num="$spec";     unit=$SECS_PER_DAY ;;
  esac
  is_uint "$num" || { printf 'prune: --older-than expects <N>d, <N>h or <N>\n  usage: %s\n' "$PRUNE_USAGE" >&2; return 2; }
  printf '%s\n' $((num * unit))
}

# Never deletes: `trash` when it works, otherwise a move under .trash/<stamp>/ inside the config home.
recoverable_remove() {
  local path="${1%/}" dest
  [ -e "$path" ] || return 0
  if command -v trash >/dev/null 2>&1 && trash "$path" 2>/dev/null; then
    return 0
  fi
  dest="$TRASH_FALLBACK_DIR/${PRUNE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  mkdir -p "$dest" && mv "$path" "$dest/"
}

# prune_path <path> <dry-run 0|1>
prune_path() {
  local path="${1%/}"
  [ -e "$path" ] || return 0
  if [ "$2" -eq 1 ]; then
    printf 'would prune: %s\n' "$path"
    return 0
  fi
  recoverable_remove "$path" && printf 'pruned: %s\n' "$path"
}

prune_run() {
  local run_id="$1" file="$2" dry="$3" job
  for job in $(run_job_ids "$file"); do
    prune_path "$JOBS_HOME/$job" "$dry"
  done
  prune_path "$RUNS_HOME/$run_id" "$dry"
}

run_is_expired() {
  local file="$1" cutoff="$2" status finished epoch
  status=$(jq -r '.status' "$file")
  in_list "$status" "$RUN_STATUSES" || return 1
  finished=$(jq -r '.finished // empty' "$file")
  [ -n "$finished" ] || return 1
  epoch=$(to_epoch_iso "$finished") || return 1
  [ "$epoch" -lt "$cutoff" ]
}

cmd_prune() {
  local spec="" dry=0 max_age cutoff file run_id kept_jobs=" " job_dir job pruned=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --older-than) shift; spec="${1:-}" ;;
      --dry-run) dry=1 ;;
      *) printf 'prune: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "prune"
  ensure_home || return 1
  [ -n "$spec" ] || spec="$(setting_get retention_days "$RETENTION_DEFAULT_DAYS")d"
  max_age=$(parse_age "$spec") || return $?
  cutoff=$(( $(date -u +%s) - max_age ))
  PRUNE_STAMP=$(date -u +%Y%m%dT%H%M%SZ)

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    run_id=$(jq -r '.run_id' "$file")
    if run_is_expired "$file" "$cutoff"; then
      prune_run "$run_id" "$file" "$dry"
      pruned=$((pruned + 1))
      continue
    fi
    for job in $(run_job_ids "$file"); do kept_jobs="$kept_jobs$job "; done
  done <<EOF
$(run_state_files)
EOF

  # Orphan finished jobs: not referenced by any surviving run, and finished before the cutoff.
  for job_dir in "$JOBS_HOME"/*/; do
    [ -f "$job_dir/exit_code" ] || continue
    job=$(basename "$job_dir")
    case "$kept_jobs" in *" $job "*) continue ;; esac
    [ "$(file_mtime "$job_dir/exit_code")" -lt "$cutoff" ] || continue
    prune_path "$job_dir" "$dry"
  done

  loops_prune "$cutoff" "$dry"

  if [ "$dry" -eq 1 ]; then
    printf 'would prune %s run(s) older than %s\n' "$pruned" "$spec"
    return 0
  fi
  printf 'pruned %s run(s) older than %s\n' "$pruned" "$spec"
}

# Called from `run start`; a retention setting of 0 disables it. Never fails the caller.
auto_prune() {
  local days
  days=$(setting_get retention_days "$RETENTION_DEFAULT_DAYS")
  is_uint "$days" && [ "$days" -gt 0 ] || return 0
  cmd_prune --older-than "${days}d" >/dev/null 2>&1 || true
}
