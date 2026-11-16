#!/usr/bin/env bash
# dispatch.sh tests: demo seeding, part b: demo seed --graph.
# Run: bash demo-seeding-b.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

graph_demo=$(new_tmp)
seed_home "$graph_demo"
out=$(env HARNESS_ORCH_HOME="$graph_demo" PATH="$(path_without claude cursor-agent opencode copilot)" \
  bash "$SCRIPT" demo seed --graph 2>&1); rc=$?
expect_exit "demo seed --graph exits 0 with no harness CLI present" 0 "$rc"
expect_match "demo seed --graph names its run" 'seeded graph run' "$out"
graph_state=$(cat "$graph_demo"/runs/*/state.json)
expect_match "graph demo seeds one 13-node run" '^13$' "$(printf '%s' "$graph_state" | jq '.nodes | length')"
expect_match "graph demo covers every node status" '^done,error,running,skipped,waiting$' \
  "$(printf '%s' "$graph_state" | jq -r '[.nodes[].status] | unique | join(",")')"
expect_match "graph demo nodes carry a reported cost" '^3.12$' \
  "$(printf '%s' "$graph_state" | jq '.nodes[] | select(.id == "design") | .cost.usd')"
expect_match "graph demo records a retried attempt" '^1$' \
  "$(printf '%s' "$graph_state" | jq '.nodes[] | select(.id == "ui") | .attempts | length')"
cleanup_dir "$graph_demo"

finish
