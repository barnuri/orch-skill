#!/usr/bin/env bash
# Mock demo data for orch — sourced by dispatch.sh, never executed.
#
# Seeds runs that look like real orchestration so the dashboard has something to show: DAG
# shapes, every node status, per-profile colours, harness glyphs, and full job transcripts.
# Nothing here spawns a harness or spends a token — every log is written, not earned.
#
# Adapters are passed explicitly rather than resolved from profiles.json, so a seeded demo
# renders correctly in a state dir whose profiles the user has since renamed or removed.
#
# jq programs are single-quoted on purpose — their $vars are jq's, bound with --arg.
# shellcheck disable=SC2016

DEMO_USAGE='dispatch.sh demo seed [--force] | demo reset [--force] | demo advance [--run <id>]'
# Written into every seeded run dir so `reset` removes exactly what `seed` created and never
# touches a real run that happens to share a title.
DEMO_MARKER_FILE='demo.marker'
DEMO_DEFAULT_HOME="$HOME/.harness-orch"

# Seeding writes fake runs. Doing that to the state dir the user actually orchestrates from is
# almost never what they meant, so it takes --force.
demo_guard_home() {
  local forced="$1"
  [ "$forced" = "1" ] && return 0
  [ "$ORCH_HOME" != "$DEMO_DEFAULT_HOME" ] && return 0
  printf 'demo: %s is your real state dir — pass --force, or set HARNESS_ORCH_HOME to a scratch dir\n' \
    "$ORCH_HOME" >&2
  return 2
}

demo_is_seeded_run() {
  [ -f "$RUNS_HOME/$1/$DEMO_MARKER_FILE" ]
}

# A transcript with the shape of a real headless session: the prompt, a long tail of tool calls,
# then a result. Long on purpose — a 20-line log would not show why the panel reads the whole
# session instead of the tail.
demo_mock_log() {
  local label="$1" profile="$2" adapter="$3" session="$4" file="$5" step round
  {
    printf '$ %s -p "%s" --output-format text --session-id %s\n' "$adapter" "$label" "$session"
    printf '\n> %s\n\n' "$label"
    for round in 1 2 3; do
      printf -- '--- pass %s ---\n' "$round"
      for step in \
        'Read   src/payments/config.ts' \
        'Grep   "createCharge" (23 matches across 9 files)' \
        'Read   src/payments/charge.ts' \
        'Read   src/payments/refund.ts' \
        'Edit   src/payments/charge.ts' \
        'Edit   src/payments/types.ts' \
        'Bash   bun test payments/ --silent' \
        'Read   tests/payments/charge.test.ts' \
        'Edit   tests/payments/charge.test.ts' \
        'Bash   bun test payments/ --silent' \
        'Bash   bun run typecheck'; do
        printf '● %s\n' "$step"
      done
      printf '\n  %s tests passed, 0 failed  (%ss)\n\n' $((28 + round * 4)) $((3 + round))
    done
    printf 'Notes\n'
    printf '  · charge.ts split into validate/authorise/capture so each is testable alone\n'
    printf '  · the refund path shared a currency assertion; extracted to types.ts\n'
    printf '  · one flake in charge.test.ts came from a shared clock; frozen per test\n'
    printf '\n%s\n' "$label — done. 4 files touched, 40 tests green, typecheck clean."
    printf '\n[%s · profile %s · session %s]\n' "$adapter" "$profile" "$session"
  } > "$file"
}

# Creates a job dir shaped exactly like a real one (adapter/profile/session/log/exit_code) so
# the transcript endpoint, `orch tail` and the resume command all work against demo data.
demo_job_create() {
  local adapter="$1" profile="$2" label="$3" exit_code="$4" job_id session dir
  job_id="demo-$(date -u +%H%M%S)-$RANDOM"
  dir="$JOBS_HOME/$job_id"
  mkdir -p "$dir" || return 1
  session=$(new_uuid)
  printf '%s\n' "$adapter" > "$dir/adapter"
  printf '%s\n' "$profile" > "$dir/profile"
  printf '%s\n' "$session" > "$dir/session"
  demo_mock_log "$label" "$profile" "$adapter" "$session" "$dir/log"
  [ "$exit_code" = "-" ] || printf '%s' "$exit_code" > "$dir/exit_code"
  printf '%s\n' "$job_id"
}

# demo_node <run> <id> <label> <profile> <adapter> <status> [deps] [error]
#
# Writes the node's end state through `node_set_status` — the same single mutation every real
# status change goes through — and copies the log tail `run sync` would have copied.
#
# It deliberately does NOT call `run sync`. Sync resolves a running job through its pid and is
# run-wide, so with mock jobs (no live process) it declares every running node dead, and one
# node's sync would clobber another's state.
demo_node() {
  local run="$1" id="$2" label="$3" profile="$4" adapter="$5" status="$6" deps="${7:-}" err="${8:-}"
  local job exit_code
  cmd_node_add "$run" "$id" "$label" ${deps:+--after "$deps"} --profile "$profile" >/dev/null || return 1
  [ "$status" = "waiting" ] && return 0
  if [ "$status" = "skipped" ]; then
    node_set_status "$run" "$id" skipped "" "$err" "$adapter" "$profile"
    return $?
  fi
  case "$status" in
    error) exit_code=1 ;;
    running) exit_code='-' ;;
    *) exit_code=0 ;;
  esac
  job=$(demo_job_create "$adapter" "$profile" "$label" "$exit_code") || return 1
  node_set_status "$run" "$id" "$status" "$job" "$err" "$adapter" "$profile" \
    "$(cat "$JOBS_HOME/$job/session" 2>/dev/null)" || return 1
  demo_copy_log_tail "$run" "$id" "$job"
}

demo_copy_log_tail() {
  local run="$1" id="$2" job="$3" tail_json
  tail_json=$(tail -n "$LOG_TAIL_LINES" "$JOBS_HOME/$job/log" 2>/dev/null \
    | jq -R -s 'split("\n") | map(select(length > 0))') || return 0
  node_patch "$run" "$id" '.log_tail = $t' --argjson t "${tail_json:-[]}"
}

demo_run_begin() {
  local title="$1" run
  run=$(cmd_run_start "$title") || return 1
  : > "$RUNS_HOME/$run/$DEMO_MARKER_FILE"
  printf '%s\n' "$run"
}

# --- the seeded runs -----------------------------------------------------------------------
# Four runs chosen to cover what the dashboard can show: a live fan-out/fan-in mid-flight, a
# clean finish, a failure with a real error, and a run with skipped work.

demo_run_payments() {
  local run
  run=$(demo_run_begin "Ship the payments service") || return 1
  demo_node "$run" survey   "Survey the existing checkout flow" claude-opus   claude       done
  demo_node "$run" design   "Design the payments API contract"  claude-opus   claude       done    survey
  demo_node "$run" schema   "Write the schema + migrations"     claude-sub    claude       done    design
  demo_node "$run" handlers "Implement the payment handlers"     claude-sub    claude       running design
  demo_node "$run" fmt      "Format and lint the new files"      claude-haiku  claude       done    design
  demo_node "$run" review   "Review the diff on cursor"          cursor-default cursor-agent waiting handlers,schema
  demo_node "$run" verify   "Typecheck and run the suite"        claude-sub    claude       waiting review,fmt
  printf '%s\n' "$run"
}

demo_run_bench() {
  local run
  run=$(demo_run_begin "Nightly benchmark sweep") || return 1
  demo_node "$run" warmup "Warm the llama_swap model cache" claude-llm-hub claude       done
  demo_node "$run" bench  "Benchmark lfm2.5-8b on 40 prompts" claude-llm-hub claude      done warmup
  demo_node "$run" report "Summarise latency and cost"        claude-haiku   claude       done bench
  cmd_run_finish "$run" >/dev/null || return 1
  printf '%s\n' "$run"
}

demo_run_migration() {
  local run
  run=$(demo_run_begin "Migrate the llm-hub profiles") || return 1
  demo_node "$run" rename "Rename hub profiles to llm-hub" claude-sub     claude       done
  demo_node "$run" probe  "Probe the hub endpoint"          cursor-llm-hub cursor-agent error rename \
    "LLM_HUB_URL is not set in this environment"
  demo_node "$run" rollout "Roll the change out to profiles.json" claude-sub claude     waiting probe
  cmd_run_finish "$run" >/dev/null || return 1
  printf '%s\n' "$run"
}

demo_run_docs() {
  local run
  run=$(demo_run_begin "Docs pass on the adapter contract") || return 1
  demo_node "$run" draft   "Draft the adapter contract page" claude-haiku claude done
  demo_node "$run" screens "Recapture the dashboard screenshots" claude-haiku claude skipped draft \
    "no display available on this host"
  cmd_run_finish "$run" >/dev/null || return 1
  printf '%s\n' "$run"
}

demo_seed_memory() {
  memory_add --profile claude-haiku --outcome success --kind format \
    --note "Formatting and lint passes are reliably fast here." >/dev/null 2>&1 || return 0
  memory_add --profile claude-opus --outcome success --kind architecture \
    --note "Worth the cost on schema design; caught a missing index." >/dev/null 2>&1 || return 0
  memory_add --profile cursor-llm-hub --outcome failure --kind review \
    --note "Needs LLM_HUB_URL exported; failed fast without it." >/dev/null 2>&1 || return 0
}

cmd_demo_seed() {
  local forced=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) forced=1 ;;
      *) printf 'demo seed: unknown argument %s\n  usage: %s\n' "$1" "$DEMO_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "demo seed"
  demo_guard_home "$forced" || return $?
  ensure_home || return 1
  demo_run_payments >/dev/null || return 1
  demo_run_bench >/dev/null || return 1
  demo_run_migration >/dev/null || return 1
  demo_run_docs >/dev/null || return 1
  demo_seed_memory
  printf 'demo: seeded 4 runs in %s\n' "$ORCH_HOME"
}

cmd_demo_reset() {
  local forced=0 dir run removed=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) forced=1 ;;
      *) printf 'demo reset: unknown argument %s\n  usage: %s\n' "$1" "$DEMO_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  demo_guard_home "$forced" || return $?
  [ -d "$RUNS_HOME" ] || { printf 'demo: nothing to reset\n'; return 0; }
  for dir in "$RUNS_HOME"/*/; do
    [ -d "$dir" ] || continue
    run="${dir%/}"; run="${run##*/}"
    demo_is_seeded_run "$run" || continue
    recoverable_remove "$dir" || return 1
    removed=$((removed + 1))
  done
  for dir in "$JOBS_HOME"/demo-*/; do
    [ -d "$dir" ] || continue
    recoverable_remove "$dir" || return 1
  done
  printf 'demo: removed %s seeded run(s)\n' "$removed"
}

# Moves one seeded run forward by a single step, so a recording has motion to capture: the
# first running node finishes, then the first ready waiting node starts.
cmd_demo_advance() {
  local run="" file node profile adapter label job
  while [ $# -gt 0 ]; do
    case "$1" in
      --run) shift; run="${1:-}" ;;
      *) printf 'demo advance: unknown argument %s\n  usage: %s\n' "$1" "$DEMO_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "demo advance"
  [ -n "$run" ] || run=$(demo_first_seeded_run) || return 1
  file=$(run_require "$run") || return $?

  node=$(jq -r 'first(.nodes[] | select(.status == "running") | .id) // ""' "$file")
  if [ -n "$node" ]; then
    node_set_status "$run" "$node" done
    printf '%s\tdone\n' "$node"
    return 0
  fi
  node=$(jq -r '. as $r
    | first(.nodes[] | select(.status == "waiting") | .id as $n
        | select(all($r.edges[] | select(.[1] == $n) | .[0] as $d
            | ($r.nodes[] | select(.id == $d) | .status); . == "done"))
        | .id) // ""' "$file")
  [ -n "$node" ] || { printf 'demo: %s has nothing left to advance\n' "$run"; return 0; }
  label=$(jq -r --arg n "$node" 'first(.nodes[] | select(.id == $n) | .label)' "$file")
  profile=$(jq -r --arg n "$node" 'first(.nodes[] | select(.id == $n) | .profile) // ""' "$file")
  adapter=$(demo_adapter_for_profile "$profile")
  job=$(demo_job_create "$adapter" "$profile" "$label" '-') || return 1
  node_set_status "$run" "$node" running "$job" "" "$adapter" "$profile" \
    "$(cat "$JOBS_HOME/$job/session" 2>/dev/null)"
  demo_copy_log_tail "$run" "$node" "$job"
  printf '%s\trunning\n' "$node"
}

# Seeded runs are all created within the same second, so their random id suffixes make
# directory order arbitrary — picking "the first" would advance a finished run at random.
# Prefer a run that actually has something left to move.
demo_run_has_work() {
  local file
  file=$(run_state_file "$1")
  [ -f "$file" ] || return 1
  [ "$(jq -r '[.nodes[] | select(.status == "running" or .status == "waiting")] | length' "$file")" != "0" ]
}

demo_first_seeded_run() {
  local dir run fallback=""
  for dir in "$RUNS_HOME"/*/; do
    [ -d "$dir" ] || continue
    run="${dir%/}"; run="${run##*/}"
    demo_is_seeded_run "$run" || continue
    [ -n "$fallback" ] || fallback="$run"
    if demo_run_has_work "$run"; then
      printf '%s\n' "$run"
      return 0
    fi
  done
  [ -n "$fallback" ] && { printf '%s\n' "$fallback"; return 0; }
  printf 'demo: no seeded run found — run `demo seed` first\n' >&2
  return 2
}

# Demo profiles are named after their harness, so the prefix is enough — and unlike a
# profiles.json lookup it still works when the target home has different profiles.
demo_adapter_for_profile() {
  case "$1" in
    cursor-*) printf 'cursor-agent\n' ;;
    opencode-*) printf 'opencode\n' ;;
    local-*) printf 'local-llm\n' ;;
    *) printf 'claude\n' ;;
  esac
}

cmd_demo() {
  local verb="${1:-}"
  [ $# -gt 0 ] && shift
  case "$verb" in
    seed) cmd_demo_seed "$@" ;;
    reset) cmd_demo_reset "$@" ;;
    advance) cmd_demo_advance "$@" ;;
    *) printf 'usage: %s\n' "$DEMO_USAGE" >&2; return 2 ;;
  esac
}
