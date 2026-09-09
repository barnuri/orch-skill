#!/usr/bin/env bash
# Dispatches a task to one of several LLM/agent harnesses, backgrounds it, and lets a caller
# check on it across separate invocations. Callable standalone (not only via the
# orch skill) — see `dispatch.sh -h` for the subcommand surface.
#
# Two backgrounding modes exist because callers differ in what already backgrounds them:
#   run    runs an adapter SYNCHRONOUSLY. Use this when something else already backgrounds the
#          whole invocation (e.g. Claude Code's own Bash run_in_background + Monitor).
#   start  self-backgrounds via nohup and prints a job-id immediately. Use this when nothing
#          else will background the call (opencode, pi, a bare shell).
#
# This file is safe to `source`: sourcing only defines functions. `main` runs only when the file
# is executed directly (BASH_SOURCE[0] == $0) — this is also how a backgrounded `start` job gets
# access to the adapter functions in a fresh bash -c process: it sources this same file by its
# resolved real path, then calls adapter_dispatch directly.
#
# Requires: bash, coreutils. curl+jq only for the local-llm adapter and the budget check
# (missing either degrades to a clear error / a safe default, never a crash). bun 1.3+ only for
# `serve`/`ui` (`ORCH_BUN` overrides the binary) — a missing bun exits 127.

set -u

ORCH_HOME="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
JOBS_HOME="$ORCH_HOME/jobs"
DEFAULT_BUDGET_THRESHOLD=85
SNAPSHOT_MAX_AGE_SECS="${HARNESS_ORCH_SNAPSHOT_MAX_AGE:-900}"
USAGE_SNAPSHOT="${CLAUDE_USAGE_SNAPSHOT:-$HOME/.claude/usage-snapshot.json}"
RESOLVE_MAX_HOPS=8

usage() {
  cat <<'EOF'
dispatch.sh classify "<task description>" [--complexity trivial|small|medium|large] [--prefer-local]
    -> prints exactly one of: claude-native | local-llm | cursor-agent | opencode

dispatch.sh budget-check
    -> exit 0 = safe to route more work to Claude Code; exit 1 = avoid (near limit).
       Reason printed to stderr either way.

dispatch.sh run   (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> runs synchronously in the foreground. Exits with the harness's own exit code.
dispatch.sh start (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> self-backgrounds (nohup), prints a job-id to stdout immediately, exits 0.
       adapters: claude-native | claude | cursor-agent | opencode | local-llm
       --profile supplies harness + model + flags + env from profiles.json instead of <adapter>.

dispatch.sh status <job-id>       -> prints "running" | "done exit=<n>"
dispatch.sh tail <job-id> [-n N]  -> prints the last N (default 20) log lines
dispatch.sh wait <job-id> [--timeout SECS(default 300)] [--interval SECS(default 5)]
    -> polls status until done or timeout; exit 0 if finished, 124 on timeout.
dispatch.sh list                  -> job-id, status, profile — newest first.

dispatch.sh init                  -> creates the config home (default ~/.harness-orch) with template
                                     profiles.json + empty memory.json; prints the path.
dispatch.sh profile list          -> name, harness, model per profile (* = default)
dispatch.sh profile show <name>   -> the profile JSON as written (env refs unresolved)
dispatch.sh profile pick "<task>" [--complexity trivial|small|medium|large] [--kind K]
    -> profile=…, model=…, reason=… (metadata + memory weighted pick)
dispatch.sh profile sanity [--profile NAME]
    -> JSON {generated_at, results:[{profile, ok, ms, harness, model_id, slug, exit_code, bytes, error}]}
dispatch.sh model list [--profile P] [--harness H]
dispatch.sh harness list [--json]
    -> probes each adapter (CLI on PATH or env for local-llm); JSON includes enabled flag
       from settings.disabled_harnesses.
    -> model-id, slug, description, cost, quality (whitelist when --profile is set)
dispatch.sh demo seed | reset | advance [--run <id>]
    -> seeds (or clears) mock runs, DAGs and job transcripts for the dashboard. Never spawns a
       harness. Refuses the default state dir without --force: point HARNESS_ORCH_HOME at a
       scratch dir instead. `advance` steps one seeded run forward, for recordings.

dispatch.sh suggest scan | list [--pending] | apply <id> | dismiss <id>
    -> learning loop: scan runs/memory, surface pending suggestions, apply/dismiss
EOF
  # Unquoted heredoc: these lines expand the per-subcommand usage constants the libs define, so the
  # summary here and each command's own usage line can't drift apart.
  cat <<EOF
$MEMORY_ADD_USAGE
dispatch.sh memory list [--profile P] [-n N]

Run/node state (one orchestration run = a DAG of nodes; the dashboard reads state live):
$RUN_START_USAGE          -> prints run-id
$NODE_ADD_USAGE
$NODE_DISPATCH_USAGE
$NODE_USAGE_USAGE
    -> start + marks the node running; omit the target to use the node's own --profile.
$NODE_UPDATE_USAGE
$RUN_SYNC_USAGE     -> flips running nodes from their jobs; prints id<TAB>status per node,
                                  then "ready: a,b" (waiting nodes whose deps are all done) and "running: N"
$RUN_FINISH_USAGE   -> default: error if any node errored
dispatch.sh run list              -> run-id, status, title, done/total — newest first

$UI_USAGE
    -> opens the live dashboard: reuses the running server (markers under <home>/serve/) or starts one
       in the background on 0.0.0.0:6724, restarts it if the skill changed, then opens
       http://127.0.0.1:<port>/?token=… (ORCH_NO_OPEN=1 prints only; --stop stops it).
$SERVE_USAGE
    -> runs the dashboard server in the foreground over plain HTTP (Bun). Bind address, port and
       auth policy are read from <home>/serve.json (see serve config). CLI --host/--port override
       for one shot. /api/* needs the bearer token from <home>/serve.token unless serve.json
       opts out (0600; trash it to rotate).
$SERVE_CONFIG_USAGE
    -> show, get or persist the dashboard bind/auth settings in <home>/serve.json.
$SERVE_STATUS_USAGE
    -> dashboard health: running / down / zombie / stale sources / bun missing.
$SERVE_RECOVER_USAGE
    -> fix a stale or zombie server and optionally start it (--start is the default).
$SYNC_USAGE
    -> offline catch-up: recover the dashboard when possible, run sync on active runs,
       scan suggestions and auto-apply safe memory rows.
$PRUNE_USAGE
    -> recoverably removes finished runs (+ their jobs, data js) and orphan finished jobs older than
       the cutoff (default settings.retention_days). Uses trash, else moves under .trash/<stamp>/.
       Also runs automatically at run start. Running runs/jobs are never touched.
EOF
}

# Follows a bounded chain of symlinks and resolves the containing directory physically — needed
# because this repo's skills are symlinked whole into ~/.agents/skills/ for opencode/pi, so a
# naive $0 would point at the symlink, not the real file a background job can re-source later.
resolve_realpath() {
  local path="$1" hops=0 target dir
  while [ -L "$path" ] && [ "$hops" -lt "$RESOLVE_MAX_HOPS" ]; do
    hops=$((hops + 1))
    target=$(readlink "$path" 2>/dev/null) || break
    case "$target" in
      /*) path="$target" ;;
      *) path="$(dirname "$path")/$target" ;;
    esac
  done
  dir=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$dir" "${path##*/}"
}

SELF_REAL=$(resolve_realpath "${BASH_SOURCE[0]:-$0}") || SELF_REAL="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=$(cd "$(dirname "$SELF_REAL")" && pwd -P 2>/dev/null) || SCRIPT_DIR="."
REPO_ROOT=$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd -P) || REPO_ROOT=""

if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/hooks/agent-env.sh" ]; then
  # shellcheck source=/dev/null
  . "$REPO_ROOT/hooks/agent-env.sh"
else
  agent_session_id() { printf 'pid-%s\n' "$$"; }
  agent_harness() { printf 'unknown\n'; }
fi

# lib/*.sh hold the adapters (and config/runs/dashboard). Resolved via SCRIPT_DIR so the nohup
# child that re-sources this file by SELF_REAL finds them through the same symlink-safe path.
for lib_file in "$SCRIPT_DIR"/lib/*.sh; do
  [ -f "$lib_file" ] || continue
  # shellcheck source=/dev/null
  . "$lib_file"
done

# Converts a `date -u +%Y-%m-%dT%H:%M:%SZ`-shaped timestamp to epoch seconds, trying BSD date
# (macOS) then GNU date, since usage-snapshot.sh's captured_at must be readable on both.
to_epoch_iso() {
  local iso="$1" epoch
  epoch=$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" '+%s' 2>/dev/null) && { printf '%s\n' "$epoch"; return 0; }
  epoch=$(date -u -d "$iso" '+%s' 2>/dev/null) && { printf '%s\n' "$epoch"; return 0; }
  return 1
}

# Prints diagnostic reason to stderr either way. Every degraded path (no jq, no snapshot, stale
# snapshot, non-subscription account) defaults to "safe" — matches usage-snapshot.sh's own
# "never block the caller" philosophy.
budget_check() {
  # Precedence: env override > settings.budget_threshold in profiles.json > built-in default.
  local threshold
  threshold="${HARNESS_ORCH_BUDGET_THRESHOLD:-$(setting_get budget_threshold "$DEFAULT_BUDGET_THRESHOLD")}"
  if ! command -v jq >/dev/null 2>&1; then
    printf 'budget-check: jq not found — defaulting to safe (route to Claude)\n' >&2
    return 0
  fi
  if [ ! -f "$USAGE_SNAPSHOT" ]; then
    printf 'budget-check: no snapshot at %s — defaulting to safe\n' "$USAGE_SNAPSHOT" >&2
    return 0
  fi

  local api_type
  api_type=$(jq -r '.api.type // empty' "$USAGE_SNAPSHOT" 2>/dev/null)
  if [ "$api_type" != "subscription" ]; then
    printf 'budget-check: api.type=%s (not subscription) — no budget gating\n' "${api_type:-unknown}" >&2
    return 0
  fi

  local captured_at now age snap_epoch mtime
  captured_at=$(jq -r '.captured_at // empty' "$USAGE_SNAPSHOT" 2>/dev/null)
  now=$(date -u +%s)
  if [ -n "$captured_at" ] && snap_epoch=$(to_epoch_iso "$captured_at"); then
    age=$((now - snap_epoch))
  else
    mtime=$(file_mtime "$USAGE_SNAPSHOT") || mtime="$now"
    age=$((now - mtime))
  fi

  if [ "$age" -gt "$SNAPSHOT_MAX_AGE_SECS" ]; then
    printf 'budget-check: snapshot is %ss old (>%ss) — defaulting to safe\n' "$age" "$SNAPSHOT_MAX_AGE_SECS" >&2
    return 0
  fi

  local window pct
  for window in five_hour day week seven_day; do
    pct=$(jq -r --arg w "$window" '.rate_limits[$w].used_percentage // empty' "$USAGE_SNAPSHOT" 2>/dev/null)
    [ -n "$pct" ] || continue
    if awk -v p="$pct" -v t="$threshold" 'BEGIN { exit !(p >= t) }'; then
      printf 'budget-check: %s window at %s%% (>= %s%%) — avoid routing more to Claude\n' \
        "$window" "$pct" "$threshold" >&2
      return 1
    fi
  done

  printf 'budget-check: all windows below %s%% — safe to route to Claude\n' "$threshold" >&2
  return 0
}

classify_cmd() {
  local description="" complexity="" prefer_local=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --complexity) shift; complexity="${1:-}" ;;
      --prefer-local) prefer_local=1 ;;
      *) [ -n "$description" ] || description="$1" ;;
    esac
    shift
  done

  if [ -z "$complexity" ]; then
    local words
    words=$(printf '%s' "$description" | wc -w | tr -d ' ')
    if [ "${words:-0}" -le 15 ]; then complexity="small"; else complexity="medium"; fi
  fi

  local budget_ok=0
  budget_check || budget_ok=1

  if { [ "$complexity" = "trivial" ] || [ "$complexity" = "small" ]; } && [ "$budget_ok" -eq 0 ]; then
    printf 'claude-native\n'
    return 0
  fi

  if [ "$budget_ok" -ne 0 ]; then
    if command -v cursor-agent >/dev/null 2>&1; then
      printf 'cursor-agent\n'
    elif command -v opencode >/dev/null 2>&1; then
      printf 'opencode\n'
    elif [ -n "${LLM_HUB_URL:-}" ]; then
      printf 'local-llm\n'
    else
      printf 'classify: no alternate harness available — routing to claude-native despite budget pressure\n' >&2
      printf 'claude-native\n'
    fi
    return 0
  fi

  if [ "$prefer_local" -eq 1 ] || { [ "$complexity" = "medium" ] && [ -n "${LLM_HUB_URL:-}" ]; }; then
    printf 'local-llm\n'
    return 0
  fi

  printf 'claude-native\n'
}

# Shared head of run/start: `(--profile <name> | <adapter>) <prompt|@file>`. Sets TARGET_KIND
# (profile|adapter), TARGET_NAME, TARGET_PROMPT (resolved), and TARGET_ARGC (how many leading
# args the caller must shift to reach the pass-through args).
parse_target() {
  local sub="$1" raw_prompt
  if [ "${2:-}" = "--profile" ]; then
    TARGET_KIND=profile
    TARGET_NAME="${3:-}"
    raw_prompt="${4:-}"
    TARGET_ARGC=3
  else
    TARGET_KIND=adapter
    TARGET_NAME="${2:-}"
    raw_prompt="${3:-}"
    TARGET_ARGC=2
  fi
  if [ -z "$TARGET_NAME" ] || [ -z "$raw_prompt" ]; then
    printf 'usage: dispatch.sh %s (--profile <name> | <adapter>) <prompt|@file> [args...]\n' "$sub" >&2
    return 2
  fi
  TARGET_PROMPT=$(resolve_prompt "$raw_prompt") || return 1
}

# target_dispatch <kind> <name> <prompt> [args…] — the one place profile vs adapter branches;
# used by the foreground `run` and by the backgrounded `start` child alike.
target_dispatch() {
  local kind="$1" name="$2" prompt="$3"
  shift 3
  if [ "$kind" = profile ]; then
    dispatch_with_profile "$name" "$prompt" "$@"
  else
    adapter_dispatch "$name" "$prompt" "$@"
  fi
}

cmd_run() {
  parse_target run "$@" || return $?
  shift "$TARGET_ARGC"
  target_dispatch "$TARGET_KIND" "$TARGET_NAME" "$TARGET_PROMPT" "$@"
}

job_status() {
  local job_id="$1" job_dir="$JOBS_HOME/$1" pid
  [ -d "$job_dir" ] || { printf 'unknown job: %s\n' "$job_id" >&2; return 2; }
  if [ -f "$job_dir/exit_code" ]; then
    printf 'done exit=%s\n' "$(cat "$job_dir/exit_code")"
    return 0
  fi
  pid=$(cat "$job_dir/pid" 2>/dev/null || printf '')
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf 'running\n'
    return 0
  fi
  printf 'done exit=unknown\n'
}

# Self-backgrounds via nohup, re-sourcing this same file (by its resolved real path, so a
# symlinked skill directory still finds the real source) inside a fresh bash -c process to reach
# adapter_dispatch — that keeps the adapters in one place instead of duplicating them into a
# standalone wrapper script.
cmd_start() {
  parse_target start "$@" || return $?
  shift "$TARGET_ARGC"

  # A bad profile must fail here, synchronously, before anything is backgrounded.
  local adapter="$TARGET_NAME"
  if [ "$TARGET_KIND" = profile ]; then
    profile_load "$TARGET_NAME" || return $?
    adapter="$PROFILE_HARNESS"
  fi

  mkdir -p "$JOBS_HOME" || { printf 'cmd_start: cannot create %s\n' "$JOBS_HOME" >&2; return 1; }
  local job_id job_dir start_script
  job_id="$(date -u +%Y%m%d%H%M%S)-$(agent_session_id)-$$-$RANDOM"
  job_dir="$JOBS_HOME/$job_id"
  mkdir -p "$job_dir"
  printf '%s\n' "$adapter" > "$job_dir/adapter"
  if [ "$TARGET_KIND" = profile ]; then
    printf '%s\n' "$TARGET_NAME" > "$job_dir/profile"
  fi

  # The harness is told which session id to use, rather than being asked afterwards what it
  # chose — that is the only way the id is knowable to us, and it makes the run resumable
  # (`claude --resume <id>`). Exported, so the backgrounded child and its adapter both see it.
  # `run` has no job dir to record it in, so this is deliberately start-only.
  ORCH_SESSION_ID="$(new_uuid)"
  export ORCH_SESSION_ID
  printf '%s\n' "$ORCH_SESSION_ID" > "$job_dir/session"

  # Single quotes are deliberate: these lines must reach the child bash unexpanded. The child
  # re-resolves the profile itself — that is how it gets the profile's exported env.
  # shellcheck disable=SC2016
  start_script=$(printf '%s\n' \
    'self="$1"; shift' \
    '. "$self"' \
    'target_dispatch "$@"' \
    'rc=$?' \
    "printf '%s' \"\$rc\" > \"$job_dir/exit_code\"" \
    'exit "$rc"')

  nohup bash -c "$start_script" _ "$SELF_REAL" "$TARGET_KIND" "$TARGET_NAME" "$TARGET_PROMPT" "$@" \
    >"$job_dir/log" 2>&1 </dev/null &
  local bg_pid=$!
  disown "$bg_pid" 2>/dev/null || true
  printf '%s\n' "$bg_pid" > "$job_dir/pid"
  printf '%s\n' "$job_id"
}

cmd_status() {
  local job_id="${1:-}"
  [ -n "$job_id" ] || { printf 'usage: dispatch.sh status <job-id>\n' >&2; return 2; }
  job_status "$job_id"
}

cmd_tail() {
  local job_id="${1:-}" n=20
  [ -n "$job_id" ] || { printf 'usage: dispatch.sh tail <job-id> [-n N]\n' >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) shift; n="${1:-20}" ;;
    esac
    shift
  done
  local job_dir="$JOBS_HOME/$job_id"
  [ -f "$job_dir/log" ] || { printf 'no log for job: %s\n' "$job_id" >&2; return 2; }
  tail -n "$n" "$job_dir/log"
}

cmd_wait() {
  local job_id="${1:-}" timeout=300 interval=5
  [ -n "$job_id" ] || { printf 'usage: dispatch.sh wait <job-id> [--timeout SECS] [--interval SECS]\n' >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) shift; timeout="${1:-300}" ;;
      --interval) shift; interval="${1:-5}" ;;
    esac
    shift
  done

  local elapsed=0 st
  while :; do
    st=$(job_status "$job_id") || return $?
    case "$st" in
      done*) printf '%s\n' "$st"; return 0 ;;
    esac
    if [ "$elapsed" -ge "$timeout" ]; then
      printf 'wait: timed out after %ss (job still running)\n' "$timeout" >&2
      return 124
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}

cmd_list() {
  [ -d "$JOBS_HOME" ] || { printf 'no jobs\n'; return 0; }
  local job_dir job_dir_name st profile
  for job_dir in "$JOBS_HOME"/*/; do
    [ -d "$job_dir" ] || continue
    job_dir_name=$(basename "$job_dir")
    st=$(job_status "$job_dir_name" 2>/dev/null)
    profile=$(cat "$job_dir/profile" 2>/dev/null || printf '-')
    printf '%s\t%s\t%s\n' "$job_dir_name" "$st" "$profile"
  done | sort -r
}

main() {
  local sub="${1:-}" verb
  case "$sub" in
    classify) shift; classify_cmd "$@" ;;
    budget-check) budget_check; exit $? ;;
    run)
      # `run start|finish|list|sync` is run-state; anything else is v1 `run <adapter|--profile>`.
      case "${2:-}" in
        start|finish|list|sync) verb="$2"; shift 2; "cmd_run_$verb" "$@" ;;
        *) shift; cmd_run "$@" ;;
      esac
      ;;
    node)
      case "${2:-}" in
        add|update|dispatch|usage) verb="$2"; shift 2; "cmd_node_$verb" "$@" ;;
        *) printf 'usage: dispatch.sh node add|update|dispatch|usage ...\n' >&2; exit 2 ;;
      esac
      ;;
    start) shift; cmd_start "$@" ;;
    status) shift; cmd_status "$@" ;;
    tail) shift; cmd_tail "$@" ;;
    wait) shift; cmd_wait "$@" ;;
    list) cmd_list ;;
    init) cmd_init ;;
    prune) shift; cmd_prune "$@" ;;
    serve)
      shift
      case "${1:-}" in
        config) shift; cmd_serve_config "$@" ;;
        status) shift; cmd_serve_status "$@" ;;
        recover) shift; cmd_serve_recover "$@" ;;
        *) cmd_serve "$@" ;;
      esac
      ;;
    sync) shift; cmd_sync "$@" ;;
    ui) shift; cmd_ui "$@" ;;
    profile) shift; cmd_profile "$@" ;;
    model) shift; cmd_model "$@" ;;
    harness) shift; cmd_harness "$@" ;;
    memory) shift; cmd_memory "$@" ;;
    suggest) shift; cmd_suggest "$@" ;;
    demo) shift; cmd_demo "$@" ;;
    ""|-h|--help) usage ;;
    *) printf 'unknown subcommand: %s\n' "$sub" >&2; usage >&2; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
