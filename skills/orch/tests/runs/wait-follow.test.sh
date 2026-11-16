#!/usr/bin/env bash
# Tests for `run wait --follow` (lib/runs/wait.sh): every node change (running -> done, error, waiting)
# is printed within 30 seconds; the follower keeps its own cursor, so a one-shot `run wait` beside
# it does not take its events, and a restarted follower neither repeats nor skips a change.
# Temp homes only. Run with: bash wait-follow.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

scratch=$(new_tmp)
home=$(new_tmp); seed_home "$home"
export HARNESS_ORCH_HOME="$home" ORCH_WAIT_POLL_SECS=1 ORCH_HEALTH_MONITOR=0 ORCH_OWNER_CACHE_SECS=0 ORCH_OWNER_FILL=0
export ORCH_OPENCODE_DB="$scratch/none.db"
o() { bash "$SCRIPT" "$@"; }
fcursor="$home/runs/%s/wait.follow.cursor"
log="$scratch/follow.log"
start_follow() { o run wait "$R" --follow >> "$log" 2>&1 & fpid=$!; wait_until "[ -f '$(printf "$fcursor" "$R")' ]" 60; }
stop_follow() { kill "$fpid" 2>/dev/null; wait "$fpid" 2>/dev/null; }
count() { grep -c -- "$1" "$log" 2>/dev/null || true; }

R=$(o run start "follow")
for n in a b c d e; do o node add "$R" "$n" "$n" >/dev/null; o node update "$R" "$n" running --owner coordinator >/dev/null 2>&1; done

# 1. running -> done, error and waiting each show up within 30 seconds
start_follow
o node update "$R" a done >/dev/null 2>&1
wait_until "grep -q '^a running->done$' '$log'" 30; expect_exit "done printed within 30s" 0 "$?"
o node update "$R" b error --error boom >/dev/null 2>&1
wait_until "grep -q '^b running->error: boom$' '$log'" 30; expect_exit "error printed within 30s" 0 "$?"
o node update "$R" c waiting >/dev/null 2>&1
wait_until "grep -q '^c running->waiting$' '$log'" 30; expect_exit "waiting printed within 30s" 0 "$?"

# 2. a one-shot wait beside the follower does not consume its events
o node update "$R" c running --owner coordinator >/dev/null 2>&1
wait_until "grep -q '^c waiting->running$' '$log'" 30
o node update "$R" d done >/dev/null 2>&1
o run wait "$R" --timeout 10 >/dev/null 2>&1
wait_until "grep -q '^d running->done$' '$log'" 30; expect_exit "one-shot wait does not steal from the follower" 0 "$?"
stop_follow

# 3. restart: a change made while the follower is down is printed once; nothing earlier repeats
o node update "$R" e done >/dev/null 2>&1
start_follow
wait_until "grep -q '^e running->done$' '$log'" 30; expect_exit "restart: change while down printed" 0 "$?"
o node update "$R" c done >/dev/null 2>&1
wait_until "grep -q '^c running->done$' '$log'" 30
stop_follow
expect_match "restart: a done printed once" '^1$' "$(count '^a running->done$')"
expect_match "restart: d done printed once" '^1$' "$(count '^d running->done$')"
expect_match "restart: e done printed once" '^1$' "$(count '^e running->done$')"

# 4. a state change that leaves the file stamps unchanged (same size, same mtime, no event line) is
#    still caught by the periodic rescan. waiting -> skipped keeps the size.
f="$home/runs/$R/state.json"
o node add "$R" s "s" >/dev/null 2>&1
jq '.' "$f" > "$f.new" && mv -f "$f.new" "$f"
ORCH_WAIT_RESCAN_SECS=2 o run wait "$R" --follow >> "$log" 2>&1 & fpid=$!
wait_until "[ -f '$(printf "$fcursor" "$R")' ]" 60
sleep 3
size0=$(wc -c < "$f"); ref="$scratch/stamp"; touch -r "$f" "$ref"
jq '(.nodes[] | select(.id == "s") | .status) = "skipped"' "$f" > "$f.new" && cat "$f.new" > "$f"
touch -r "$ref" "$f"
expect_match "rescan: same size" "^$size0\$" "$(wc -c < "$f")"
wait_until "grep -q '^s waiting->skipped$' '$log'" 30; expect_exit "rescan: change caught" 0 "$?"
stop_follow

cleanup_dir "$scratch"; cleanup_dir "$home"
finish
