#!/usr/bin/env bash
# Run/node state for orch — sourced by dispatch.sh, never executed.
# A "run" is one orchestration session: a small DAG of nodes (tasks) under runs/<run-id>/state.json.
# Every mutation is a jq filter applied atomically (tmp + mv). The server reads state.json
# directly — there is no render step. The coordinating agent drives this with one short
# command per state change; nothing here re-derives its own decisions.
#
# jq programs are single-quoted on purpose — their $vars are jq's, bound with --arg.
# shellcheck disable=SC2016

NODE_STATUSES="waiting running done error skipped"
RUN_STATUSES="done error"
ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]*$'
USAGE_CATEGORIES="tool mcp skill subagent agent"
# Wider than ID_PATTERN: these names come from tool ids like `mcp__github__search`, `Bash`, or a
# model slug, so `:` and `@` are legal. Length-capped so one bad log line cannot bloat state.json.
USAGE_NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'
USAGE_COUNT_MAX=1000000
LOG_TAIL_LINES=20
ADAPTER_NAMES="claude-native $VALID_HARNESSES"

RUN_START_USAGE='dispatch.sh run start "<title>" [--id <run-id>]'
RUN_FINISH_USAGE='dispatch.sh run finish <run-id> [--status done|error]'
RUN_SYNC_USAGE='dispatch.sh run sync <run-id>'
NODE_ADD_USAGE='dispatch.sh node add <run-id> <node-id> "<label>" [--after a,b] [--profile P]'
NODE_UPDATE_USAGE="dispatch.sh node update <run-id> <node-id> $(printf '%s' "$NODE_STATUSES" | tr ' ' '|') [--job J] [--error \"msg\"]"
NODE_DISPATCH_USAGE='dispatch.sh node dispatch <run-id> <node-id> (--profile <name> | <adapter>) <prompt|@file> [args...]'
NODE_USAGE_USAGE='dispatch.sh node usage <run-id> <node-id> [--add c.name=N]... [--set c.name=N]... [--clear]'
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

# state_write_raw <run-id> <jq-filter> [jq --arg ...]: atomic rewrite of the run's state.json.
state_write_raw() {
  local run_id="$1" filter="$2" file tmp
  shift 2
  file=$(run_state_file "$run_id")
  tmp="$file.tmp.$$"
  if ! jq "$@" "$filter" "$file" > "$tmp"; then
    printf 'run %s: state update failed\n' "$run_id" >&2
    return 1
  fi
  mv -f "$tmp" "$file"
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
  learning_after_finish "$run_id" || true
  printf '%s\n' "$status"
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
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ -z "$label" ]; then
    printf 'usage: %s\n' "$NODE_ADD_USAGE" >&2
    return 2
  fi
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --after) shift; deps="${1:-}" ;;
      --profile) shift; profile="${1:-}" ;;
      *) printf 'node add: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node add"
  file=$(run_require "$run_id") || return $?
  valid_id "$node_id" || { printf 'node add: id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  if node_require "$file" "$node_id" 2>/dev/null; then
    printf 'node add: %s already exists\n' "$node_id" >&2
    return 2
  fi
  for dep in $(printf '%s' "$deps" | tr ',' ' '); do
    [ "$dep" != "$node_id" ] || { printf 'node add: %s cannot depend on itself\n' "$node_id" >&2; return 2; }
    node_require "$file" "$dep" || return 2
  done

  state_write "$run_id" \
    '($deps | split(",") | map(select(length > 0))) as $d
     | .nodes += [{id: $id, label: $label, status: "waiting", profile: (if $profile == "" then null else $profile end),
                   adapter: null, job_id: null, session: null, started: null, finished: null,
                   error: null, log_tail: [], usage: {}}]
     | .edges += ($d | map([., $id]))' \
    --arg id "$node_id" --arg label "$label" --arg deps "$deps" --arg profile "$profile"
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
    '(if $clear == 1 then .usage = {} else .usage = (.usage // {}) end)
     | reduce $ops[] as $o (.;
         ($o.cat) as $c | ($o.name) as $n
         | (if $o.op == "add" then ((.usage[$c][$n] // 0) + $o.count) else $o.count end) as $next
         | if $next <= 0 then
             (if (.usage[$c] // {}) | has($n) then del(.usage[$c][$n]) else . end)
           else
             .usage[$c] = ((.usage[$c] // {}) + {($n): $next})
           end
         | (if (.usage[$c] // null) == {} then del(.usage[$c]) else . end))' \
    --argjson clear "$clear" --argjson ops "$ops"
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
  local session="${8:-}"
  node_patch "$run_id" "$node_id" \
    '.status = $s
     | (if $job != "" then .job_id = $job else . end)
     | (if $err != "" then .error = $err else . end)
     | (if $adapter != "" then .adapter = $adapter else . end)
     | (if $profile != "" then .profile = $profile else . end)
     | (if $session != "" then .session = $session else . end)
     | (if $s == "running" and .started == null then .started = $ts else . end)
     | (if ($s == "done" or $s == "error" or $s == "skipped") then .finished = $ts else . end)' \
    --arg s "$status" --arg job "$job" --arg err "$err" \
    --arg adapter "$adapter" --arg profile "$profile" --arg session "$session" --arg ts "$(now_iso)"
}

cmd_node_update() {
  local run_id="${1:-}" node_id="${2:-}" status="${3:-}" job="" err="" file
  if [ -z "$run_id" ] || [ -z "$node_id" ] || [ -z "$status" ]; then
    printf 'usage: %s\n' "$NODE_UPDATE_USAGE" >&2
    return 2
  fi
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --job) shift; job="${1:-}" ;;
      --error) shift; err="${1:-}" ;;
      *) printf 'node update: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node update"
  file=$(run_require "$run_id") || return $?
  node_require "$file" "$node_id" || return 2
  in_list "$status" "$NODE_STATUSES" || { printf 'node update: status must be one of: %s\n' "$NODE_STATUSES" >&2; return 2; }
  node_set_status "$run_id" "$node_id" "$status" "$job" "$err"
}

# node dispatch <run> <node> (--profile P | <adapter> | <prompt-using-node-profile>) [<prompt>] [args…]
cmd_node_dispatch() {
  local run_id="${1:-}" node_id="${2:-}" file status node_profile job_id
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

  job_id=$(cmd_start "$@") || return $?
  node_set_status "$run_id" "$node_id" running "$job_id" "" "$(cat "$JOBS_HOME/$job_id/adapter" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/profile" 2>/dev/null)" \
    "$(cat "$JOBS_HOME/$job_id/session" 2>/dev/null)" || return 1
  printf '%s\n' "$job_id"
}

# Re-reads each running node's job and flips it to done/error; prints one `id<TAB>status` line per
# node, then `ready: …` (waiting nodes whose deps are all done) and `running: <count>`.
cmd_run_sync() {
  local run_id="${1:-}" file node job st tail_json
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_SYNC_USAGE" >&2; return 2; }
  require_jq "run sync"
  file=$(run_require "$run_id") || return $?

  while IFS=$'\t' read -r node job; do
    [ -n "$node" ] && [ -n "$job" ] || continue
    st=$(job_status "$job" 2>/dev/null || printf 'done exit=unknown')
    tail_json=$(tail -n "$LOG_TAIL_LINES" "$JOBS_HOME/$job/log" 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0))')
    case "$st" in
      running) ;;
      "done exit=0") node_set_status "$run_id" "$node" "done" ;;
      done*) node_set_status "$run_id" "$node" error "" "${st#done }" ;;
    esac
    node_patch "$run_id" "$node" '.log_tail = $t' --argjson t "${tail_json:-[]}"
  done <<EOF
$(jq -r '.nodes[] | select(.status == "running" and .job_id != null) | "\(.id)\t\(.job_id)"' "$file")
EOF

  jq -r '.nodes[] | "\(.id)\t\(.status)"' "$file"
  jq -r '. as $r
    | [ .nodes[] | select(.status == "waiting") | .id as $n
        | select(all($r.edges[] | select(.[1] == $n) | .[0] as $d | ($r.nodes[] | select(.id == $d) | .status); . == "done"))
        | .id ]
    | "ready: " + join(",")' "$file"
  jq -r '"running: " + ([.nodes[] | select(.status == "running")] | length | tostring)' "$file"
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
