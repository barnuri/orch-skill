#!/usr/bin/env bash
# dispatch.sh tests: node messaging (lib/runs/inbox.sh): node tell, node ask [--wait], node answer,
# node inbox, run broadcast, run rule add|list, run messages. Delivery goes through the orch herdr pane
# of the node's job when one exists (a fake herdr records the push) and stays in the inbox file when not.
# Run: bash inbox.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
fake=$(new_tmp)
cat > "$fake/herdr" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ORCH_HERDR_FAKE_LOG"
FAKE
chmod +x "$fake/herdr"
fake_log="$fake/calls.log"
: > "$fake_log"
# No herdr on PATH: delivery falls back to the inbox file.
orch() { env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 bash "$SCRIPT" "$@"; }
# The fake herdr on PATH: a node with a herdr pane gets the push.
orch_h() { env HARNESS_ORCH_HOME="$home" ORCH_HERDR=1 PATH="$fake:$PATH" ORCH_HERDR_FAKE_LOG="$fake_log" bash "$SCRIPT" "$@"; }
seed_home "$home"
state="$home/runs/msg-1/state.json"

orch run start "Messaging test" --id msg-1 >/dev/null 2>&1
orch node add msg-1 a "pane node" >/dev/null 2>&1
orch node add msg-1 b "inbox node" >/dev/null 2>&1
orch node add msg-1 c "waiting node" >/dev/null 2>&1
mkdir -p "$home/jobs/job-a" "$home/jobs/job-b"
printf 'w1:p7\n' > "$home/jobs/job-a/herdr_pane"
orch node update msg-1 a running --job job-a >/dev/null 2>&1
orch node update msg-1 b running --job job-b >/dev/null 2>&1

# tell: pane push when the job has a herdr pane.
out=$(orch_h node tell msg-1 a "stop editing x.ts" 2>&1); rc=$?
expect_exit "tell exits 0" 0 "$rc"
expect_match "tell to a pane node is delivered" '^m1 a delivered$' "$out"
expect_match "the push went to the node pane" '^pane send-text w1:p7 \[orch message m1 from orch\] stop editing x.ts$' "$(cat "$fake_log")"
expect_match "the push ends with Enter" '^pane send-keys w1:p7 Enter$' "$(cat "$fake_log")"
expect_match "the message file says via herdr" '^delivered herdr$' "$(jq -r '"\(.status) \(.via)"' "$home/runs/msg-1/inbox/a/1.json")"

# tell without a pane: pending in the inbox file, read once by node inbox.
out=$(orch node tell msg-1 b "use the new DTO" --from planner 2>&1)
expect_match "tell without a pane stays pending" '^m2 b pending$' "$out"
out=$(orch node inbox msg-1 b 2>&1)
expect_match "node inbox prints the message" '^\[m2 from planner\] use the new DTO$' "$out"
expect_match "node inbox marks it delivered" '^delivered inbox$' "$(jq -r '"\(.status) \(.via)"' "$home/runs/msg-1/inbox/b/2.json")"
expect_no_match "a second node inbox is empty" "." "$(orch node inbox msg-1 b 2>&1)"
orch node tell msg-1 b "peek me" >/dev/null 2>&1
expect_match "--peek leaves the message pending" 'peek me' "$(orch node inbox msg-1 b --json --peek 2>&1)"
orch node inbox msg-1 b --ack m3 --via plugin >/dev/null 2>&1
expect_match "--ack marks it delivered via the plugin" '^delivered plugin$' "$(jq -r '"\(.status) \(.via)"' "$home/runs/msg-1/inbox/b/3.json")"
out=$(orch node tell msg-1 nope "x" 2>&1); rc=$?
expect_exit "tell to an unknown node fails" 2 "$rc"

# broadcast: every running node, none of the waiting ones.
out=$(orch run broadcast msg-1 "freeze the API" 2>&1)
expect_match "broadcast reaches 2 running nodes" 'broadcast 2' "$out"
expect_no_match "the waiting node got nothing" "." "$(orch node inbox msg-1 c 2>&1)"

# rules: stored on the run, broadcast, and listed.
out=$(orch run rule add msg-1 "never run the full suite" 2>&1)
expect_match "rule add prints its id" 'rule r1 added' "$out"
expect_match "rule list shows it" '^r1 never run the full suite$' "$(orch run rule list msg-1 2>&1)"
expect_match "rule is broadcast to the nodes" 'New run rule: never run the full suite' "$(orch node inbox msg-1 b 2>&1)"

# ask + answer: the ask lands in inbox/orch, wakes run wait, the answer goes to the node.
out=$(orch node ask msg-1 b "which DTO name?" 2>&1)
expect_match "ask prints its id" '^m[0-9]+ asked$' "$out"
ask=${out%% *}
expect_match "the ask event names the id" "\"kind\":\"ask\".*$ask: which DTO name" "$(cat "$home/runs/msg-1/events.jsonl")"
out=$(orch node answer msg-1 b "NodeMessage" 2>&1)
expect_match "answer names the ask" "^$ask answered b pending$" "$out"
expect_match "the ask records the answer" '^NodeMessage$' "$(jq -r .answer "$home/runs/msg-1/inbox/orch/${ask#m}.json")"
expect_match "the node reads the answer" "Answer to $ask: NodeMessage" "$(orch node inbox msg-1 b 2>&1)"
out=$(orch node answer msg-1 b "again" 2>&1); rc=$?
expect_exit "answer with no open ask fails" 2 "$rc"

# ask --wait blocks until the answer, then prints it.
( env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 ORCH_ASK_POLL_SECS=1 bash "$SCRIPT" node ask msg-1 b "go on?" --wait --timeout 30 > "$home/wait.out" 2>&1; echo $? > "$home/wait.rc" ) &
waiter=$!
for _ in $(seq 1 20); do
  grep -q '"text":"go on?"' "$home"/runs/msg-1/inbox/orch/*.json 2>/dev/null && break
  sleep 0.5
done
orch node answer msg-1 b "yes" >/dev/null 2>&1
wait "$waiter"
expect_match "ask --wait exits 0" '^0$' "$(cat "$home/wait.rc")"
expect_match "ask --wait prints the answer" '^yes$' "$(cat "$home/wait.out")"
expect_no_match "the waiter consumed the answer message" "." "$(orch node inbox msg-1 b 2>&1)"
out=$(env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 ORCH_ASK_POLL_SECS=1 bash "$SCRIPT" node ask msg-1 b "late?" --wait --timeout 1 2>&1); rc=$?
expect_exit "ask --wait times out with 4" 4 "$rc"

# dispatch: the run rules and the messages sent while the node waited ride on its prompt.
cat > "$fake/opencode" <<'FAKE'
#!/usr/bin/env bash
printf 'ARGS %s\n' "$*"
FAKE
chmod +x "$fake/opencode"
orch node tell msg-1 c "read this first" >/dev/null 2>&1
job=$(env HARNESS_ORCH_HOME="$home" ORCH_HERDR=0 PATH="$fake:$PATH" bash "$SCRIPT" node dispatch msg-1 c opencode "do c" 2>/dev/null)
orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
log=$(cat "$home/jobs/$job/log" 2>/dev/null)
expect_match "the prompt carries the run rules" 'never run the full suite' "$log"
expect_match "the prompt carries the pending message" 'read this first' "$log"
expect_match ".prompt keeps the raw text" '^do c$' "$(jq -r '.nodes[] | select(.id == "c") | .prompt' "$state")"
expect_no_match "the pending message was consumed" "." "$(orch node inbox msg-1 c 2>&1)"

# messages: the run-wide list.
expect_match "run messages lists the ask" '\[ask\]' "$(orch run messages msg-1 2>&1)"
expect_match "run messages --json is an array" '^\[' "$(orch run messages msg-1 --json 2>&1)"

cleanup_dir "$home"
cleanup_dir "$fake"
finish
