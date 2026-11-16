#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/visibility.sh: age formatting, staleness from activity rows,
# unowned nodes, the continued_from chain, node remove/ping errors and the event line, in-process.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

expect_match "seconds under a minute" '^5s$' "$(fmt_age 5)"
expect_match "minutes under an hour" '^2m$' "$(fmt_age 125)"
expect_match "hours and minutes" '^1h2m$' "$(fmt_age 3725)"
expect_match "a negative age is zero" '^0s$' "$(fmt_age -3)"

now=$(date -u +%s)
rows=$(printf 'old\037%s\037-\037-\nfresh\037%s\037-\037-\nnone\037\037-\037-\n' $((now - 1200)) $((now - 30)))
expect_match "only the node quiet past the default ten minutes is stale" '^old$' "$(run_stale_nodes rX "$rows")"

mkdir -p "$H/runs/r0" "$H/runs/r1"
cat > "$H/runs/r0/state.json" <<'EOF'
{"run_id":"r0","title":"origin","status":"done","edges":[],"nodes":[{"id":"z","status":"done"}]}
EOF
cat > "$H/runs/r1/state.json" <<'EOF'
{"run_id":"r1","title":"t","status":"running","continued_from":"r0","edges":[["a","b"],["w","x"]],
 "nodes":[{"id":"a","status":"waiting"},{"id":"b","status":"running","owner":"job-1","job_id":"job-1"},
          {"id":"u","status":"running"},{"id":"w","status":"waiting"},{"id":"x","status":"waiting"},
          {"id":"d","status":"done"}]}
EOF
expect_match "a running node with no owner and no job is unowned" '^u$' "$(run_unowned_nodes r1)"
expect_match "the chain follows continued_from" '^r1 r0$' "$(run_chain r1 | tr '\n' ' ' | sed 's/ $//')"
expect_match "a dependency done in the origin run names that run" '^r0$' "$(node_finished_in_origin r1 z)"
node_finished_in_origin r1 nope >/dev/null; rc=$?
expect_exit "a dependency done nowhere is not found" 1 "$rc"

out=$(cmd_node_remove r1 d 2>&1); rc=$?
expect_exit "a done node is not removed without --force" 2 "$rc"
expect_match "the refusal names the status" "is done" "$out"
out=$(cmd_node_remove r1 a 2>&1); rc=$?
expect_exit "a node with a running dependent is not removed" 2 "$rc"
expect_match "the refusal names the dependent" "dependents: b" "$out"
out=$(cmd_node_remove r1 w --bogus 2>&1); rc=$?
expect_exit "an unknown remove flag is a usage error" 2 "$rc"
out=$(cmd_node_remove r1 w 2>&1); rc=$?
expect_exit "a waiting node with waiting dependents is removed" 0 "$rc"
expect_match "the node and its edges are gone" '^false 1$' \
  "$(jq -r '"\(any(.nodes[]; .id == "w")) \(.edges | length)"' "$H/runs/r1/state.json")"
expect_match "the removal is an event with null empty fields" '^remove w waiting null$' \
  "$(tail -n 1 "$H/runs/r1/events.jsonl" | jq -r '"\(.kind) \(.node) \(.from) \(.to)"')"

out=$(cmd_node_ping r1 b --bogus 2>&1); rc=$?
expect_exit "an unknown ping flag is a usage error" 2 "$rc"
out=$(cmd_node_ping r1 2>&1); rc=$?
expect_exit "a ping with no node is a usage error" 2 "$rc"

run_event r1 note b "" "" "hello"
expect_match "run_event writes one JSON line" '^note b null hello cli$' \
  "$(tail -n 1 "$H/runs/r1/events.jsonl" | jq -r '"\(.kind) \(.node) \(.from) \(.note) \(.by)"')"
run_event missing note; rc=$?
expect_exit "run_event on a missing run never fails" 0 "$rc"

cleanup_dir "$(dirname "$H")"
finish
