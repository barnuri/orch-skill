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

# Must equal VERSION in core/cli.ts: tests/parity compares `--version` across both paths.
ORCH_VERSION="0.1.0"

# ORCH_TRACE_SPAWN=1: counts external-command starts (a wrapper function per command name, then
# `command`). One line per call is appended to ORCH_TRACE_SPAWN_FILE (default $TMPDIR/orch-spawn-trace).
# Builtins and subshell forks are not counted, so the count is a lower bound. Defined only when set:
# sourcing without the flag stays side-effect free.
if [ "${ORCH_TRACE_SPAWN:-0}" = 1 ]; then
  _orch_trace_file="${ORCH_TRACE_SPAWN_FILE:-${TMPDIR:-/tmp}/orch-spawn-trace}"
  for _orch_ext in jq date stat sed awk grep cut tr cat mkdir mv cp sleep cksum curl ps find head tail wc basename dirname uname sort mktemp perl python3 touch ls chmod; do
    eval "$_orch_ext() { printf '%s\n' '$_orch_ext' >> \"\$_orch_trace_file\"; command $_orch_ext \"\$@\"; }"
  done
  unset _orch_ext
fi

ORCH_HOME="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
JOBS_HOME="$ORCH_HOME/jobs"
DEFAULT_BUDGET_THRESHOLD=85
SNAPSHOT_MAX_AGE_SECS="${HARNESS_ORCH_SNAPSHOT_MAX_AGE:-900}"
USAGE_SNAPSHOT="${CLAUDE_USAGE_SNAPSHOT:-$HOME/.claude/usage-snapshot.json}"
RESOLVE_MAX_HOPS=8

usage() {
  cat <<'EOF'
dispatch.sh classify "<task description>" [--complexity trivial|small|medium|large] [--prefer-local]
    -> prints exactly one of: claude-native | local-llm | cursor-agent | opencode | copilot

dispatch.sh announce [--clear|--dry-run|--quiet|--run <id>|--ttl-sec N]
    -> shows running orch work in Herdr and the status line (see references/status-bridge.md).
       Mutating run/node commands call it automatically in the background.

dispatch.sh budget-check
    -> exit 0 = safe to route more work to Claude Code; exit 1 = avoid (near limit).
       Reason printed to stderr either way.

dispatch.sh run   (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> runs synchronously in the foreground. Exits with the harness's own exit code.
dispatch.sh start (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> self-backgrounds (nohup), prints a job-id to stdout immediately, exits 0.
       When herdr is installed (and ORCH_HERDR is not 0) the job runs in a pane of the orch skill's
       own headless herdr instance (never your live session; one tab per run), same log and exit
       file. If that instance cannot start, or has 20 panes, the job starts detached as before.
       adapters: claude-native | claude | cursor-agent | opencode | local-llm | copilot | pi
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
dispatch.sh profile unset-env <name> <VAR>...
    -> drops the named env vars from one profile; the rest of profiles.json stays as written
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

Loops and watches (detached; each prints an id; `active` summarizes all running ones):
dispatch.sh loop start --every <dur> [--max N] [--until CMD] (--profile P | <adapter>) <prompt|@file> [args...]
dispatch.sh loop list | stop <id> | tail <id> [-n N]
dispatch.sh watch start --name N "<cmd>" [--match RE] [--ignore RE] [--until RE] [--every DUR] [--on-match PROMPT --profile P]
dispatch.sh watch wait <id> [--timeout S] [--max-lines N] [--since N] | events <id> | list | stop <id>
dispatch.sh active [--json]
    -> one line per running loop or watch; --json for harnesses and the dashboard

Schedules (cron; each fires a prompt through a profile, or a shell command; the dashboard server ticks them):
dispatch.sh schedule add --name N --cron "<m h dom mon dow>" (--prompt TEXT|@file --profile P [--model M] | --command CMD [--workdir DIR] [--timeout DUR])
dispatch.sh schedule edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--model M] [--command CMD] [--workdir DIR] [--timeout DUR]
    -> changes only the given fields; keeps id, created_at, enabled and run history; --prompt/--command switch the kind
dispatch.sh schedule list [--json] | show <id> | enable <id> | disable <id> | remove <id> | run <id> | log <id> [index] | tick | next "<cron>"
EOF
  # Unquoted heredoc: these lines expand the per-subcommand usage constants the libs define, so the
  # summary here and each command's own usage line can't drift apart.
  cat <<EOF
$HERDR_USAGE
    -> on/off/auto set settings.herdr (auto = on when herdr is installed). status and attach print
       the state of the dedicated orch herdr instance and the command to look at it; ensure/stop
       start/stop that instance (serve ensures it at start). health checks the server, its socket,
       the herdr web registry file and the web plugin's listing (ok/degraded/down/off);
       --nudge re-ensures and re-registers. The user's own herdr is never touched.
$HUB_USAGE
    -> llm-hub native mode: the hub picks every model by node role and tier; orch runs the graph.
       setup makes <harness>-smart-auto (default opencode) the default and planner profile.
$MEMORY_ADD_USAGE
dispatch.sh memory list [--profile P] [-n N]

Run/node state (one orchestration run = a DAG of nodes; the dashboard reads state live):
$RUN_START_USAGE          -> prints run-id
dispatch.sh use [<run-id>]
    -> saves the current run in <orch-home>/current-run (no arg: print it). A run id of '.' in
       node update|report|batch and run sync means the saved run.
$NODE_ADD_USAGE
$NODE_DISPATCH_USAGE
    -> start + marks the node running; omit the target to use the node's own --profile.
$NODE_USAGE_USAGE
$NODE_COST_USAGE
$NODE_OUT_USAGE
    -> prints the node's handoff directory, creating it if absent
$NODE_DIGEST_USAGE
    -> bounded summary of the node's job: status, exit code, size, head+tail of its log
$NODE_SELECTIONS_USAGE
    -> appends the hub's model selections for the node's workers, idempotent by sequence
$NODE_UPDATE_USAGE
    -> status is optional with --after (replaces the node's deps; '*' = wait on every other node)
       or --needs-user (a waiting node blocked on the user is never ready; health shows needs-user)
$NODE_BATCH_USAGE
    -> applies add/report/update ops ({"op":"add","id":"x","goal":"…"}, one per line) in one process
       under one run lock. Every op is checked first; one bad op applies none (errors name the line).
$NODE_REMOVE_USAGE
    -> removes a waiting node with no running or done dependents, and its edges
$NODE_PING_USAGE
    -> heartbeat: stamps updated, keeps the last 20 notes, records progress; the first ping stamps started_at
dispatch.sh $NODE_STARTED_USAGE
    -> stamps started_at (first real activity) on a dispatched node still \`starting\`; idempotent
dispatch.sh $RUN_BACKFILL_TIMING_USAGE
    -> fills dispatched_at/started_at/run_segments on older nodes from job logs and owner events
$NODE_RETRY_USAGE
$RUN_WAIT_USAGE
    -> coordinator wake-up: blocks until the run needs you (status change, ready, needs-user, stalled,
       dead or no-report owner, dead health monitor (restarted), run ended); prints one line per event
       (--json: one object). --follow keeps printing. Exit 0 = event, 3 = nothing left to run, 124 = timeout
$RUN_STATUS_USAGE
$RUN_HEALTH_USAGE
    -> one pass: ok/stalled/unowned/dead/no-report per running node, ready nodes, free slots; records
       only changes as events. Every running run gets a health:<run-id> monitor that runs it every
       ORCH_HEALTH_EVERY_SEC (settings.health_every_sec, default 30) with --nudge unless auto_nudge is false.
    -> compact progress: counts, running nodes with ages, ready nodes, errors, dashboard link
$RUN_SYNC_USAGE     -> flips running nodes from their jobs; prints id<TAB>status per node,
                                  then "ready: a,b" (waiting nodes whose deps are all done) and "running: N"
    -> ... then "slots: N" (free places under settings.max_parallel)
$RUN_FINISH_USAGE   -> default: error if any node errored
$RUN_RETRY_USAGE
$RUN_STOP_USAGE
    -> kills the run's running jobs (SIGTERM, then SIGKILL), marks those nodes stopped and sets
       stopped=true. A stopped run never auto-resumes and sync starts nothing for it.
$RUN_RESUME_USAGE
    -> --stopped is required to resume a stopped run (the run page Resume button).
$RUN_ADVANCE_USAGE
    -> one scheduler step: sync, apply a finished plan, dispatch ready nodes that have a stored
       prompt up to settings.max_parallel. --until-done loops (and finishes the run); exit 3 = blocked.

Planned runs (a planner agent splits the goal into a task DAG):
$PLAN_USAGE
    -> adds + dispatches the planner node on settings.planner_profile; it writes plan.json.
$PLAN_APPLY_USAGE
    -> validates plan.json (ids, deps, cycles, settings.max_nodes, profiles) and adds its tasks as
       nodes with stored prompts. \`run advance\` does this on its own once the planner is done.

Run mailbox (coordinator <-> nodes; nodes get ORCH_DISPATCH, ORCH_RUN_ID, ORCH_NODE_ID):
$MSG_SEND_USAGE
$MSG_READ_USAGE
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
$ARTIFACT_USAGE
    -> emits a self-contained copy of the dashboard for one run into DIR (default
       <home>/artifacts/<run-id>), with every API document it needs embedded in the page. Renders
       with no server and no network — publish it as a Claude Code artifact. It is a snapshot, so
       re-run this to refresh it.
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
      *) path="$(path_dirname "$path")/$target" ;;
    esac
  done
  dir=$(cd "$(path_dirname "$path")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$dir" "${path##*/}"
}

# `dirname` without spawning it: every dispatch.sh call resolves its own path, and on a loaded
# machine each exec costs 20-300 ms. Same results as dirname for the paths used here.
path_dirname() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  case "$p" in
    */*) p="${p%/*}"; while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done; printf '%s\n' "${p:-/}" ;;
    *) printf '.\n' ;;
  esac
}

SELF_REAL=$(resolve_realpath "${BASH_SOURCE[0]:-$0}") || SELF_REAL="${BASH_SOURCE[0]:-$0}"
# resolve_realpath already returns a physical directory, so the parent needs no second cd/pwd.
case "$SELF_REAL" in
  /*/*) SCRIPT_DIR="${SELF_REAL%/*}" ;;
  *) SCRIPT_DIR=$(cd "$(path_dirname "$SELF_REAL")" && pwd -P 2>/dev/null) || SCRIPT_DIR="." ;;
esac
REPO_ROOT=$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd -P) || REPO_ROOT=""

if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/hooks/agent-env.sh" ]; then
  # shellcheck source=/dev/null
  . "$REPO_ROOT/hooks/agent-env.sh"
else
  agent_session_id() { printf '%s\n' "${CLAUDE_CODE_SESSION_ID:-${OPENCODE_SESSION_ID:-pid-$$}}"; }
  agent_harness() { printf 'unknown\n'; }
fi

# lib/<category>/*.sh hold the adapters, config, runs, automation and dashboard code. Resolved via
# SCRIPT_DIR so the nohup child that re-sources this file by SELF_REAL finds them through the same
# symlink-safe path. The list is explicit and keeps the old alphabetical order, because some files
# read variables another file sets at file scope. A new lib file must be added here.
ORCH_LIB_FILES="adapters/adapters runs/batch runs/carry core/config runs/current-run
  dashboard/demo adapters/harness runs/health adapters/herdr adapters/hub runs/inbox core/locks
  automation/loops runs/owners runs/pause runs/plan adapters/profile-sanity adapters/routing runs/runs
  automation/schedules dashboard/serve dashboard/suggest runs/timing runs/visibility runs/wait"
for lib_file in $ORCH_LIB_FILES; do
  lib_file="$SCRIPT_DIR/lib/$lib_file.sh"
  [ -f "$lib_file" ] || { printf 'dispatch.sh: missing %s\n' "$lib_file" >&2; continue; }
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
    elif command -v copilot >/dev/null 2>&1; then
      printf 'copilot\n'
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
  # The job may have written its exit code and exited between the first check and kill -0.
  if [ -f "$job_dir/exit_code" ]; then
    printf 'done exit=%s\n' "$(cat "$job_dir/exit_code")"
    return 0
  fi
  # A Herdr pane may still be booting: the launcher is written and the pane is set, but no pid yet.
  # Count that as running until the launcher is older than the pid wait window.
  if [ -z "$pid" ] && [ -s "$job_dir/herdr_pane" ] && [ -f "$job_dir/herdr-launch.sh" ]; then
    launched=$(file_mtime "$job_dir/herdr-launch.sh") || launched=0
    if [ $(( $(date +%s) - launched )) -lt "$HERDR_PID_WAIT_SECS" ]; then
      printf 'running\n'
      return 0
    fi
  fi
  # No exit code and no process: killed with an untrappable signal (SIGKILL) or the host rebooted.
  printf 'done exit=unknown (job process gone without an exit code: killed?)\n'
}

# Runs "$@" in a new session, so a job outlives the harness that dispatched it: quitting or
# Ctrl-C-ing that harness signals its whole process group, and nohup alone only ignores SIGHUP.
# macOS ships no setsid binary, so perl's POSIX::setsid is the fallback. exec keeps the pid, so
# the caller's $! is still the job's pid.
run_detached() {
  if command -v setsid >/dev/null 2>&1; then
    exec setsid "$@"
  fi
  if command -v perl >/dev/null 2>&1; then
    exec perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV or die "exec: $!\n"' -- "$@"
  fi
  exec nohup "$@"
}

# Self-backgrounds in a new session (run_detached), re-sourcing this same file (by its resolved real path, so a
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
    printf '%s\n' "${PROFILE_MODEL:-}" > "$job_dir/model"
    printf '%s\n' "${PROFILE_MODEL_ID:-}" > "$job_dir/model_id"
  fi

  # The harness is told which session id to use, rather than being asked afterwards what it
  # chose — that is the only way the id is knowable to us, and it makes the run resumable
  # (`claude --resume <id>`). Exported, so the backgrounded child and its adapter both see it.
  # `run` has no job dir to record it in, so this is deliberately start-only.
  ORCH_SESSION_ID="${ORCH_RESUME_SESSION:-$(new_uuid)}"
  export ORCH_SESSION_ID
  [ -z "${ORCH_RESUME_SESSION:-}" ] || export ORCH_RESUME_SESSION
  printf '%s\n' "$ORCH_SESSION_ID" > "$job_dir/session"

  # An adapter's stdout is this job's log, so anything else it wants to report — the claude
  # adapter's token/cost usage — needs somewhere else to put it. Start-only for the same reason
  # as the session id: `run` has no job dir.
  ORCH_JOB_DIR="$job_dir"
  export ORCH_JOB_DIR

  # Single quotes are deliberate: these lines must reach the child bash unexpanded. The child
  # re-resolves the profile itself — that is how it gets the profile's exported env.
  # shellcheck disable=SC2016
  # A signal that kills the wrapper still records an exit code (128+N), so `status` can tell an
  # interrupted job from one whose process vanished without a trace.
  # exit_code is written to a temp file and renamed, so a poller never reads it half-written.
  start_script=$(printf '%s\n' \
    'self="$1"; shift' \
    "write_exit() { printf '%s' \"\$1\" > \"$job_dir/exit_code.tmp\" && mv \"$job_dir/exit_code.tmp\" \"$job_dir/exit_code\"; }" \
    "trap 'write_exit 130; exit 130' INT" \
    "trap 'write_exit 143; exit 143' TERM" \
    "trap 'write_exit 129; exit 129' HUP" \
    '. "$self"' \
    'target_dispatch "$@"' \
    'rc=$?' \
    'write_exit "$rc"' \
    'exit "$rc"')

  if herdr_enabled \
    && herdr_start_job "$job_dir" "$start_script" "$SELF_REAL" "$TARGET_KIND" "$TARGET_NAME" "$TARGET_PROMPT" "$@"; then
    printf '%s\n' "$job_id"
    return 0
  fi

  run_detached bash -c "$start_script" _ "$SELF_REAL" "$TARGET_KIND" "$TARGET_NAME" "$TARGET_PROMPT" "$@" \
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
  # log.plain is the ANSI-free copy a herdr job writes; a detached job has no pty, so its log is plain.
  local logf="$job_dir/log"
  [ -f "$job_dir/log.plain" ] && logf="$job_dir/log.plain"
  [ -f "$logf" ] || { printf 'no log for job: %s\n' "$job_id" >&2; return 2; }
  tail -n "$n" "$logf"
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

# announce_hook: after a state mutation, refresh the Herdr label and status line in the background.
# Debounced (5 s), skipped for the dashboard server (ORCH_NO_ANNOUNCE=1) and outside Herdr/agent sessions.
announce_hook() {
  [ "${ORCH_NO_ANNOUNCE:-}" = 1 ] && return 0
  [ "${HERDR_ENV:-}" = 1 ] || [ -n "${CLAUDE_CODE_SESSION_ID:-}${OPENCODE_SESSION_ID:-}" ] || return 0
  [ -f "$SCRIPT_DIR/announce.sh" ] || return 0
  local stamp="$ORCH_HOME/.announce-ts" now last tmp
  now=$(date +%s); last=$(cat "$stamp" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $((now - last)) -ge 5 ] || return 0
  tmp="$stamp.$$"
  { printf '%s\n' "$now" > "$tmp" && mv -f "$tmp" "$stamp"; } 2>/dev/null || return 0
  ( bash "$SCRIPT_DIR/announce.sh" --quiet >/dev/null 2>&1 </dev/null & ) 2>/dev/null
  return 0
}

# harness list is slow (it probes every CLI): one at a time. A caller that arrives meanwhile gets the
# last finished answer, or exit 75 when there is none.
harness_list_locked() {
  local last rc tmp
  last="$(locks_dir)/harness-list.last"
  if ! orch_lock_acquire harness-list; then
    if [ -s "$last" ]; then cat "$last"; return 0; fi
    printf 'harness list: another probe is running\n' >&2
    return 75
  fi
  tmp="$last.tmp.$$"
  cmd_harness "$@" > "$tmp"; rc=$?
  cat "$tmp"
  [ "$rc" -ne 0 ] || mv -f "$tmp" "$last" 2>/dev/null
  orch_lock_release harness-list
  return $rc
}

# run_create_with_monitor <fn> [args] - creates a run (start or carry) and starts its health:<run>
# monitor (lib/runs/health.sh). The run id is the first line the function prints.
run_create_with_monitor() {
  local out rc
  out=$("$@"); rc=$?
  [ -z "$out" ] || printf '%s\n' "$out"
  [ "$rc" -ne 0 ] || coordinator_auto_record "${out%%$'\n'*}"
  [ "$rc" -ne 0 ] || health_monitor_autostart "${out%%$'\n'*}"
  return $rc
}

# Ported `<group> <verb>` pairs that run in bin/orch (Bun) instead of this bash file. Phase 0: empty.
PORTED_COMMANDS=(
  "node tell"
  "node ask"
  "node inbox"
  "node update"
  "node add"
  "node report"
  "node batch"
  "run status"
  "profile list"
  "profile show"
  "profile pick"
  "model list"
  "delegate plan"
  "delegate task"
  "delegate finding"
  "delegate show"
)

is_ported() {
  local pair="$1 $2" p
  for p in "${PORTED_COMMANDS[@]+"${PORTED_COMMANDS[@]}"}"; do
    [ "$p" = "$pair" ] && return 0
  done
  return 1
}

main() {
  local sub="${1:-}" verb rid
  # Bun is required for every command. Missing bun exits 127 with the install hint.
  if ! command -v "${ORCH_BUN:-bun}" >/dev/null 2>&1; then
    printf 'orch needs bun: install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash), then run this command again\n' >&2
    exit 127
  fi
  if [ "$sub" = doctor ] && [ "$#" -eq 1 ]; then
    exec "${ORCH_BUN:-bun}" "$SCRIPT_DIR/../bin/orch" doctor
  fi
  # ORCH_BASH=1 forces bash. ORCH_DIRECT=1 is passed to bin/orch (skip the server socket).
  # delegate takes the run id second, so its verb is the third word.
  local ported_verb="${2:-}"
  [ "$sub" = delegate ] && ported_verb="${3:-}"
  if [ "${ORCH_BASH:-0}" != 1 ] && is_ported "$sub" "$ported_verb"; then
    export ORCH_DIRECT="${ORCH_DIRECT:-0}"
    exec "${ORCH_BUN:-bun}" "$SCRIPT_DIR/../bin/orch" "$@"
  fi
  # A run id of `.` means the run saved by `dispatch.sh use` (lib/runs/current-run.sh).
  case "$sub ${2:-} ${3:-}" in
    "node update ."|"node report ."|"node batch ."|"run sync .")
      rid=$(current_run_resolve .) || exit 1
      set -- "$1" "$2" "$rid" "${@:4}" ;;
  esac
  case "$sub" in
    --version|version) printf 'orch %s\n' "$ORCH_VERSION"; exit 0 ;;
    use) shift; cmd_use "$@" ;;
    classify) shift; classify_cmd "$@" ;;
    budget-check) budget_check; exit $? ;;
    run)
      case "${2:-}" in start|finish|sync|carry) trap announce_hook EXIT ;; esac
      # `run start|finish|list|sync` is run-state; anything else is v1 `run <adapter|--profile>`.
      case "${2:-}" in
        start|carry) verb="$2"; shift 2; run_create_with_monitor "cmd_run_$verb" "$@" ;;
        pause|resume|stop|set) verb="$2"; shift 2; "cmd_run_$verb" "$@" ;;
        # A paused or stopped run (lib/runs/pause.sh) starts nothing on sync.
        sync) shift 2; pause_guard "${1:-}" || exit 0; cmd_run_sync "$@" ;;
        status)
          shift 2; cmd_run_status "$@"; rc=$?
          case " $* " in *" --json "*) ;; *) [ "$rc" -ne 0 ] || ! run_is_paused "${1:-}" || printf 'paused: true\n' ;; esac
          case " $* " in *" --json "*) ;; *) [ "$rc" -ne 0 ] || ! run_is_stopped "${1:-}" || printf 'stopped: true\n' ;; esac
          exit $rc ;;
        finish|list|advance|retry|wait|health|broadcast|rule|messages|repoint) verb="$2"; shift 2; "cmd_run_$verb" "$@" ;;
        backfill-timing) shift 2; cmd_run_backfill_timing "$@" ;;
        *) shift; cmd_run "$@" ;;
      esac
      ;;
    node)
      case "${2:-}" in update|report|ping|dispatch|batch) trap announce_hook EXIT ;; esac
      case "${2:-}" in
        dispatch) shift 2; pause_guard "${1:-}" >&2 || exit 3; cmd_node_dispatch "$@" ;;
        add|update|report|ping|remove|retry|usage|cost|out|digest|selections|brief|activity|batch|started|tell|ask|answer|inbox) verb="$2"; shift 2; "cmd_node_$verb" "$@" ;;
        cancel) shift 2; cmd_node_cancel "$@" ;;
        verify-owners) shift 2; cmd_node_verify_owners "$@" ;;
        bind-owners) shift 2; cmd_node_bind_owners "$@" ;;
        *) printf 'usage: dispatch.sh node add|update|report|batch|ping|remove|dispatch|retry|cancel|usage|cost|out|digest|selections|brief|activity|started|verify-owners|bind-owners|tell|ask|answer|inbox ...\n' >&2; exit 2 ;;
      esac
      ;;
    owner) shift; cmd_owner_event "$@" ;;
    plan) shift; cmd_plan "$@" ;;
    msg) shift; cmd_msg "$@" ;;
    start) shift; cmd_start "$@" ;;
    status) shift; cmd_status "$@" ;;
    tail) shift; cmd_tail "$@" ;;
    wait) shift; cmd_wait "$@" ;;
    list) cmd_list ;;
    init) cmd_init; owner_write_dispatch_path ;;
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
    artifact) shift; cmd_artifact "$@" ;;
    profile) shift; cmd_profile "$@" ;;
    settings) shift; cmd_settings "$@" ;;
    model) shift; cmd_model "$@" ;;
    harness)
      shift
      if [ "${1:-}" = list ]; then harness_list_locked "$@"; else cmd_harness "$@"; fi ;;
    herdr) shift; cmd_herdr "$@" ;;
    hub) shift; cmd_hub "$@" ;;
    memory) shift; cmd_memory "$@" ;;
    suggest) shift; cmd_suggest "$@" ;;
    demo) shift; cmd_demo "$@" ;;
    loop) shift; cmd_loop "$@" ;;
    watch) shift; cmd_watch "$@" ;;
    active) shift; cmd_active "$@" ;;
    announce) shift; bash "$SCRIPT_DIR/announce.sh" "$@" ;;
    schedule) shift; cmd_schedule "$@" ;;
    ""|-h|--help) usage ;;
    *) printf 'unknown subcommand: %s\n' "$sub" >&2; usage >&2; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
