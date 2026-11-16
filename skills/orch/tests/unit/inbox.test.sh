#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/inbox.sh: argument parsing, message seq, tell/inbox/ack,
# ask/answer, run rules, the retry prefix and the run message list, called in-process (herdr off).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

inbox_take_args "U" r1 a hello there --from bob
expect_match "take_args splits run, node, text and sender" '^r1\|a\|hello there\|bob$' "$IT_RUN|$IT_NODE|$IT_TEXT|$IT_FROM"
out=$(inbox_take_args "U" r1 a 2>&1); rc=$?
expect_exit "take_args without text is a usage error" 2 "$rc"

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'EOF'
{"run_id":"r1","title":"t","status":"running","edges":[],
 "nodes":[{"id":"a","status":"running"},{"id":"b","status":"waiting"}]}
EOF
p1=$(inbox_new r1 b orch tell one)
p2=$(inbox_new r1 b orch tell two)
expect_match "message ids follow the run seq" '^m1 m2 pending$' "$(jq -rs '"\(.[0].id) \(.[1].id) \(.[1].status)"' "$p1" "$p2")"

expect_match "tell with no herdr pane leaves the message pending" '^m3 a pending$' "$(cmd_node_tell r1 a ping me --from c)"
out=$(cmd_node_tell r1 zz hi 2>&1); rc=$?
expect_exit "tell to an unknown node is refused" 2 "$rc"

expect_match "peek shows the pending message" '^\["m3"\]$' "$(cmd_node_inbox r1 a --peek --json | jq -c 'map(.id)')"
expect_match "a peek does not mark it delivered" '^pending$' "$(jq -r .status "$H/runs/r1/inbox/a/3.json")"
expect_match "a read prints the message" '^\[m3 from c\] ping me$' "$(cmd_node_inbox r1 a)"
expect_match "a read marks it delivered via inbox" '^delivered inbox$' "$(jq -r '"\(.status) \(.via)"' "$H/runs/r1/inbox/a/3.json")"
expect_match "the inbox is then empty" '^\[\]$' "$(cmd_node_inbox r1 a --json)"
expect_match "ack of a known message" '^acked m1$' "$(cmd_node_inbox r1 b --ack m1)"
out=$(cmd_node_inbox r1 b --ack m99 2>&1); rc=$?
expect_exit "ack of an unknown message is refused" 2 "$rc"

expect_match "an ask without --wait returns at once" '^m4 asked$' "$(cmd_node_ask r1 a which db)"
out=$(cmd_node_ask r1 a q --timeout x 2>&1); rc=$?
expect_exit "a non-number ask timeout is a usage error" 2 "$rc"
expect_match "answer finds the open ask and pushes the copy" '^m4 answered a pending$' "$(cmd_node_answer r1 a postgres)"
expect_match "the ask holds the answer" '^postgres delivered$' "$(jq -r '"\(.answer) \(.status)"' "$H/runs/r1/inbox/orch/4.json")"
out=$(cmd_node_answer r1 a again --ask m4 2>&1); rc=$?
expect_exit "a second answer is refused" 2 "$rc"
out=$(cmd_node_answer r1 b nope 2>&1); rc=$?
expect_exit "an answer with no open ask is refused" 2 "$rc"

out=$(cmd_run_rule add r1 use tabs)
expect_match "a rule is added and broadcast to running nodes" 'rule r1 added' "$out"
expect_match "the broadcast reached the one running node" '^broadcast 1$' "${out##*$'\n'}"
expect_match "rule list" '^r1 use tabs$' "$(cmd_run_rule list r1)"
blk=$(inbox_rules_block r1 a)
expect_match "the prompt block lists the rule" '^- use tabs$' "$blk"
expect_match "the prompt block names the inbox command" 'node inbox r1 a' "$blk"
out=$(cmd_run_rule bogus r1 2>&1); rc=$?
expect_exit "an unknown rule verb is a usage error" 2 "$rc"

pre=$(inbox_retry_prefix r1 b)
expect_match "the retry prefix lists only pending messages" '^- \[m2 from orch\] two$' "$pre"
expect_no_match "an acked message is not in the retry prefix" 'm1' "$pre"
expect_empty "a second retry prefix is empty" "$(inbox_retry_prefix r1 b)"

expect_match "inbox_all is sorted by seq" '^1,2,3,4,5,6$' "$(inbox_all r1 | jq -r 'map(.seq) | map(tostring) | join(",")')"
expect_match "messages text line" '^m3 c->a \[tell\] delivered via inbox: ping me$' "$(cmd_run_messages r1)"
out=$(cmd_run_messages r1 bogus 2>&1); rc=$?
expect_exit "an unknown messages verb is a usage error" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
