# shellcheck shell=bash
# Sourced by dispatch.sh, never executed. The saved "current run": `dispatch.sh use <run-id>` writes
# <orch-home>/current-run, and a run-id argument of `.` (node update|report|batch, run sync) reads it,
# so a coordinator does not repeat a long run id in every call.

current_run_file() { printf '%s/current-run\n' "$ORCH_HOME"; }

# `dispatch.sh use <run-id>`: save the run. `use` alone prints the saved run.
cmd_use() {
  local run_id="${1:-}" file
  file=$(current_run_file)
  if [ -z "$run_id" ]; then
    [ -s "$file" ] || { printf 'no current run; set one with: dispatch.sh use <run-id>\n' >&2; return 1; }
    cat "$file"; return 0
  fi
  case "$run_id" in */*|.|..) printf 'use: invalid run id: %s\n' "$run_id" >&2; return 2 ;; esac
  [ -f "$ORCH_HOME/runs/$run_id/state.json" ] || { printf 'use: no such run: %s\n' "$run_id" >&2; return 1; }
  mkdir -p "$ORCH_HOME" && printf '%s\n' "$run_id" > "$file"
  coordinator_auto_record "$run_id"
  printf '%s\n' "$run_id"
}

# Prints the run id to use: the argument itself, or the saved run when the argument is `.`.
current_run_resolve() {
  local arg="${1:-}" file id
  [ "$arg" = . ] || { printf '%s\n' "$arg"; return 0; }
  file=$(current_run_file)
  id=$(head -n1 "$file" 2>/dev/null)
  [ -n "$id" ] || { printf 'run id ".": no current run; set one with: dispatch.sh use <run-id>\n' >&2; return 1; }
  printf '%s\n' "$id"
}
