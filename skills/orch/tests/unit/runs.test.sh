#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/runs.sh: arg errors, node add, status transitions, usage terms,
# retry backoff and dependency cycles, called in-process on a fixture run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

# Fixture run r1: node a (waiting), no edges. Written directly, so no `run start` cost.
mkdir -p "$H/runs/r1"
printf '%s\n' '{"run_id":"r1","title":"Demo","started":"2026-01-01T00:00:00Z","finished":null,"status":"running",
 "nodes":[{"id":"a","label":"A","status":"waiting","started":null,"finished":null,"attempts":[],"usage":{}}],"edges":[]}' \
  > "$H/runs/r1/state.json"
F="$H/runs/r1/state.json"

# --- arg errors return before any state is touched
out=$(cmd_run_start 2>&1); rc=$?
expect_exit "run start with no title is a usage error" 2 "$rc"
out=$(cmd_run_start "t" --bogus 2>&1); rc=$?
expect_exit "run start rejects an unknown flag" 2 "$rc"
out=$(cmd_node_add r1 b 2>&1); rc=$?
expect_exit "node add without a label is a usage error" 2 "$rc"
out=$(cmd_node_add r1 b B --role chef 2>&1); rc=$?
expect_exit "node add rejects an unknown role" 2 "$rc"
out=$(cmd_run_finish 2>&1); rc=$?
expect_exit "run finish with no run is a usage error" 2 "$rc"
out=$(cmd_node_add nope b B 2>&1); rc=$?
expect_exit "node add on an unknown run fails" 2 "$rc"

# --- node add: self and unknown deps refused, a known dep becomes an edge
out=$(cmd_node_add r1 b B --after b 2>&1); rc=$?
expect_exit "node add refuses a self dependency" 2 "$rc"
cmd_node_add r1 b B --after a --role implementation; rc=$?
expect_exit "node add with a known dependency succeeds" 0 "$rc"
expect_match "the dependency becomes an edge and the node waits with its role" \
  '^\[\["a","b"\]\] waiting implementation$' "$(jq -r '"\(.edges | tojson) \(.nodes[1].status) \(.nodes[1].role)"' "$F")"

# --- node_deps_check: an edge back to an upstream node is a cycle
out=$(node_deps_check r1 "$F" a b 2>&1); rc=$?
expect_exit "node_deps_check refuses a cycle" 2 "$rc"
expect_match "the cycle error says so" 'would make a cycle' "$out"

# --- node_set_status: running opens a segment, done closes it
node_set_status r1 a running
node_set_status r1 a done
expect_match "running then done leaves one closed segment and stamps started/finished" '^false 1 true true$' \
  "$(jq -r '.nodes[0] | "\(.seg_open) \(.run_segments | length) \(.started != null) \(.finished != null)"' "$F")"

# --- usage terms (pure parser)
out=$(usage_parse_term --add 'tool' 2>&1); rc=$?
expect_exit "a usage term without = is refused" 2 "$rc"
out=$(usage_parse_term --add 'colour.x=1' 2>&1); rc=$?
expect_exit "a usage term with an unknown category is refused" 2 "$rc"
out=$(usage_parse_term --add 'tool.Bash=-1' 2>&1); rc=$?
expect_exit "a negative usage count is refused" 2 "$rc"
usage_parse_term --add 'mcp.mcp__gh__search=3'
expect_match "a usage term is split into category, name, count" '^mcp mcp__gh__search 3$' \
  "$USAGE_TERM_CAT $USAGE_TERM_NAME $USAGE_TERM_COUNT"

# --- retry backoff doubles and caps (pure)
expect_match "first retry waits the base delay" '^10$' "$(ORCH_AUTO_RETRY_BASE_SECS=10 retry_delay_seconds 0)"
expect_match "each attempt doubles the delay" '^40$' "$(ORCH_AUTO_RETRY_BASE_SECS=10 retry_delay_seconds 2)"
expect_match "the delay caps at RETRY_BACKOFF_CAP_SECS" "^$RETRY_BACKOFF_CAP_SECS\$" \
  "$(ORCH_AUTO_RETRY_BASE_SECS=10 retry_delay_seconds 20)"

# --- smart_auto_tier_of, valid_id (pure)
expect_match "a smart-auto model names its tier" '^balance$' "$(smart_auto_tier_of hub/smart-auto-balance)"
expect_empty "an unknown tier names nothing" "$(smart_auto_tier_of hub/smart-auto-bogus)"
valid_id '-x'; rc=$?
expect_exit "an id may not start with a dash" 1 "$rc"

cleanup_dir "$(dirname "$H")"
finish
