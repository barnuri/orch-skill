#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/batch.sh: the op parser, op summaries, arg errors and one
# all-or-nothing batch, called in-process on a fixture run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
printf '%s\n' '{"run_id":"r1","title":"Demo","started":"2026-01-01T00:00:00Z","finished":null,"status":"running","nodes":[],"edges":[]}' \
  > "$H/runs/r1/state.json"
F="$H/runs/r1/state.json"
T=$(new_tmp)

# --- node_batch_parse: one record per non-blank line, errors kept per line
cat > "$T/ops" <<'EOF'
{"op":"add","id":"x","label":"Node X","after":["a","b"],"plan_backed":true}

{"op":"update","id":"x","status":"done"}
not json
{"op":"add","id":"y","label":"Y","colour":"red"}
{"op":"remove","id":"x"}
{"op":"update","id":"x","hold":"h","clear_hold":true}
EOF
node_batch_parse "$T/ops"
expect_match "blank lines are skipped and line numbers kept" '^1 3 4 5 6 7$' "${BATCH_LINE[*]}"
node_batch_op 0
expect_match "an add op becomes node add args" '^add x Node X --after a,b --plan-backed$' "${BATCH_OP_ARGS[*]}"
expect_match "invalid JSON is an error for its line" "while parsing 'not json'" "${BATCH_ERR[2]}"
expect_match "an unknown field is named" 'unknown field\(s\) for add: colour' "${BATCH_ERR[3]}"
expect_match "an unknown op is refused" '"op" must be add, report or update' "${BATCH_ERR[4]}"
expect_match "hold and clear_hold cannot be combined" 'cannot be combined' "${BATCH_ERR[5]}"

# --- node_batch_summary
node_batch_op 0; expect_match "add summary" '^add x "Node X"$' "$(node_batch_summary)"
node_batch_op 1; expect_match "update summary shows the new status" '^update x -> done$' "$(node_batch_summary)"

# --- arg errors
out=$(cmd_node_batch 2>&1); rc=$?
expect_exit "batch with no run is a usage error" 2 "$rc"
out=$(cmd_node_batch r1 --bogus 2>&1); rc=$?
expect_exit "batch rejects an unknown flag" 2 "$rc"
out=$(cmd_node_batch r1 --file "$T/missing" 2>&1); rc=$?
expect_exit "batch refuses an unreadable --file" 2 "$rc"

# --- all or nothing: one bad op applies none, a good batch applies all
printf '%s\n' '{"op":"add","id":"p","label":"P"}' '{"op":"add","id":"q","label":"Q","after":"ghost"}' > "$T/bad"
out=$(cmd_node_batch r1 --file "$T/bad" 2>&1); rc=$?
expect_exit "a batch with one bad op fails" 2 "$rc"
expect_match "nothing of a failed batch is applied" '^0$' "$(jq '.nodes | length' "$F")"
printf '%s\n' '{"op":"add","id":"p","label":"P"}' '{"op":"add","id":"q","label":"Q","after":"p"}' > "$T/good"
out=$(cmd_node_batch r1 --file "$T/good" 2>&1); rc=$?
expect_exit "a valid batch succeeds" 0 "$rc"
expect_match "every op of a valid batch is applied" '^p,q \[\["p","q"\]\]$' \
  "$(jq -r '"\([.nodes[].id] | join(",")) \(.edges | tojson)"' "$F")"

cleanup_dir "$T"
cleanup_dir "$(dirname "$H")"
finish
