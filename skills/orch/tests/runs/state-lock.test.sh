#!/usr/bin/env bash
# Lost-update test for runs/<id>/state.json: `node batch` adds nodes while other writers (node ping,
# node update, owner-fill / owner-liveness patches: all node_patch / state_write_raw) rewrite the
# same file. Every writer must hold the run lock across its read-modify-write, or a write computed
# from an older read drops a node that a batch just added. Self-contained; run with: bash state-lock.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

home=$(new_tmp)
seed_home "$home"
o() { HARNESS_ORCH_HOME="$home" ORCH_OWNER_FILL=0 bash "$SCRIPT" "$@"; }

R=$(o run start "state lock")
o node add "$R" base "Base" >/dev/null
o node update "$R" base running >/dev/null

ADDS=${ORCH_TEST_LOCK_ADDS:-25}
stop="$home/stop-writers"

# Two writers that never touch the batch lock path: node ping (node_patch) and a status flip
# (node_set_status -> node_patch). Each loops until the batch side is done.
writer() {
  while [ ! -e "$stop" ]; do
    o node ping "$R" base --progress "p$RANDOM" >/dev/null 2>&1
  done
}
writer & w1=$!
writer & w2=$!

batch_rc=0
for i in $(seq 1 "$ADDS"); do
  err=$(printf '{"op":"add","id":"n%s","goal":"node %s"}\n' "$i" "$i" | o node batch "$R" 2>&1 >/dev/null) || { batch_rc=$?; printf 'batch n%s: %s\n' "$i" "$err" >&2; }
done
: > "$stop"
wait "$w1" "$w2" 2>/dev/null

expect_exit "every batch add exited 0" 0 "$batch_rc"
file="$home/runs/$R/state.json"
missing=""
for i in $(seq 1 "$ADDS"); do
  jq -e --arg n "n$i" 'any(.nodes[]; .id == $n)' "$file" >/dev/null || missing="$missing n$i"
done
if [ -z "$missing" ]; then pass_count=$((pass_count + 1)); else
  printf 'FAIL: nodes added by node batch were lost by a concurrent write:%s\n' "$missing" >&2
  failures=$((failures + 1))
fi
expect_match "state.json is still valid json with the base node" '^base$' "$(jq -r '.nodes[0].id' "$file")"
expect_match "no tmp files left behind" '^0$' "$(find "$home/runs/$R" -name 'state.json.tmp.*' | wc -l | tr -d ' ')"
expect_match "the run lock is released at the end" '^free$' "$(cat "$home/locks/run-$R.pid" 2>/dev/null)free"

# A nested write while the same process already holds the run lock (node batch -> owner fill) must
# not deadlock nor release the outer lock early.
out=$(HARNESS_ORCH_HOME="$home" bash -c '. "$1"; orch_lock_acquire "run-$2" || exit 9
  state_write_raw "$2" ".title = \"nested\"" || exit 8
  [ "$(cat "$(locks_dir)/run-$2.pid")" = "$$" ] || exit 7
  orch_lock_release "run-$2"; echo ok' _ "$SCRIPT" "$R" 2>&1)
expect_match "nested state write under a held run lock: no deadlock, outer lock kept" '^ok$' "$out"
expect_match "nested write applied" '^nested$' "$(jq -r .title "$file")"

finish
