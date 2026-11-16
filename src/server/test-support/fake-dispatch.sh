#!/usr/bin/env bash
# Stand-in for dispatch.sh in route-wiring tests (ORCH_DISPATCH). Prints the JSON shape of the real
# `harness list --json` without probing any binary. `enabled` follows settings.disabled_harnesses.
set -u
if [ "${1:-}" = "harness" ] && [ "${2:-}" = "list" ]; then
  profiles="${HARNESS_ORCH_HOME:-}/profiles.json"
  entries=""
  for id in claude cursor-agent opencode local-llm copilot pi; do
    enabled=true
    if [ -f "$profiles" ] && tr -d ' \n' < "$profiles" | grep -q "\"disabled_harnesses\":\[[^]]*\"$id\""; then
      enabled=false
    fi
    entries="$entries${entries:+,}{\"id\":\"$id\",\"kind\":\"cli\",\"binary\":\"$id\",\"wired\":true,\"description\":\"fake $id\",\"needs\":[],\"available\":true,\"reason\":\"\",\"enabled\":$enabled}"
  done
  printf '{"probed_at":"2026-01-01T00:00:00Z","harnesses":[%s]}\n' "$entries"
  exit 0
fi
if [ "${1:-}" = "node" ] && [ "${2:-}" = "update" ] || { [ "${1:-}" = "run" ] && [ "${2:-}" = "finish" ]; }; then
  # Watchdog actions: recorded (all args) so watchdog tests can assert them; state is left alone.
  printf '%s\n' "$*" >> "${HARNESS_ORCH_HOME:-}/fake-dispatch.actions"
  exit 0
fi
if { [ "${1:-}" = "run" ] || [ "${1:-}" = "node" ]; } && [ "${2:-}" = "retry" ]; then
  [ -z "${ORCH_EVENT_BY:-}" ] || printf '%s\n' "$*" >> "${HARNESS_ORCH_HOME:-}/fake-dispatch.actions"
  # Wiring stand-in: succeeds when the run has a failed node, otherwise answers like the real usage error (exit 2).
  run_id="${3:-}"
  state="${HARNESS_ORCH_HOME:-}/runs/$run_id/state.json"
  [ -f "$state" ] || { echo "$1 retry: run $run_id not found" >&2; exit 1; }
  if ! tr -d ' \n' < "$state" | grep -q '"status":"\(error\|skipped\)"'; then
    echo "node retry: ${4:-run} is not error or skipped" >&2
    exit 2
  fi
  echo "retried ${4:-$run_id}"
  exit 0
fi
if [ "${1:-}" = "node" ] && [ "${2:-}" = "dispatch" ]; then
  # Records each start (run node profile) so auto-dispatch tests can count them.
  printf '%s %s %s\n' "${3:-}" "${4:-}" "${6:-}" >> "${HARNESS_ORCH_HOME:-}/fake-dispatch.calls"
  echo "job-fake-${4:-}"
  exit 0
fi
if [ "${1:-}" = "node" ] && [ "${2:-}" = "bind-owners" ]; then
  # Watchdog owner sync: recorded apart from the actions, so action assertions stay unchanged.
  printf '%s\n' "$*" >> "${HARNESS_ORCH_HOME:-}/fake-dispatch.owners"
  exit 0
fi
echo "fake-dispatch: unsupported: $*" >&2
exit 2
