#!/usr/bin/env bash
# Tests for visibility: node ping, events, backfill, --at, stale, run wait, run status.
# Self-contained; run with: bash visibility.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$want" "$got" >&2
  failures=$((failures + 1))
}

home=$(mktemp -d)
o() { HARNESS_ORCH_HOME="$home" ORCH_WAIT_POLL_SECS=1 bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }
. "$SCRIPT_DIR/test-home.sh"; seed_home "$home"

R=$(o run start "visibility demo")
o node add "$R" a "Alpha" >/dev/null
o node add "$R" b "Beta" --after a >/dev/null
o node add "$R" c "Gamma" >/dev/null
expect_match "node add records created" '^20' "$(st "$R" '.nodes[0].created')"

# heartbeat
o node update "$R" a running >/dev/null
o node ping "$R" a --note "reading files" --progress "1/4" >/dev/null; rc=$?
expect_exit "ping exits 0" 0 "$rc"
expect_match "ping sets progress" '^1/4$' "$(st "$R" '.nodes[0].progress')"
expect_match "ping appends a note" '^reading files$' "$(st "$R" '.nodes[0].notes[-1].text')"
for i in $(seq 1 25); do o node ping "$R" a --note "n$i" >/dev/null; done
expect_match "notes keep the last 20" '^20$' "$(st "$R" '.nodes[0].notes | length')"
expect_match "newest note kept" '^n25$' "$(st "$R" '.nodes[0].notes[-1].text')"
o node ping "$R" a --bogus >/dev/null 2>&1; expect_exit "ping rejects unknown flag" 2 "$?"
o node report "$R" a --note "reported" >/dev/null
expect_match "report stamps updated" '^20' "$(st "$R" '.nodes[0].updated')"

# events feed
ev="$home/runs/$R/events.jsonl"
expect_match "events record status change" '"kind":"status".*"to":"running"' "$(cat "$ev")"
expect_match "events record notes" '"kind":"note".*"note":"n25"' "$(cat "$ev")"

# backfill
o node update "$R" c done >/dev/null
expect_match "backfilled flag set" '^true$' "$(st "$R" '.nodes[2].backfilled')"
expect_match "backfilled started = created" '^20' "$(st "$R" '.nodes[2].started')"
expect_match "normal node not backfilled" '^(null|false)$' "$(st "$R" '.nodes[0].backfilled')"

# --at
out=$(o node update "$R" a done --at 2099-01-01T00:00:00Z 2>&1); rc=$?
expect_exit "--at in the future rejected" 2 "$rc"
out=$(o node update "$R" a done --at yesterday 2>&1); rc=$?
expect_exit "--at not ISO rejected" 2 "$rc"
o node update "$R" a done --at 2026-01-02T03:04:05Z >/dev/null
expect_match "--at sets finished" '^2026-01-02T03:04:05Z$' "$(st "$R" '.nodes[0].finished')"

# stale
o node add "$R" s "Silent" >/dev/null
o node update "$R" s running >/dev/null
old=2020-01-01T00:00:00Z
jq --arg o "$old" '(.nodes[] | select(.id == "s")) |= (.started = $o | .updated = $o)' "$home/runs/$R/state.json" > "$home/x" && mv "$home/x" "$home/runs/$R/state.json"
expect_match "sync prints stale line" '^stale: s$' "$(o run sync "$R" --no-retry)"
o node ping "$R" s --note alive >/dev/null
out=$(o run sync "$R" --no-retry)
if printf '%s' "$out" | grep -q '^stale:'; then failures=$((failures + 1)); echo "FAIL: ping clears stale" >&2; else pass_count=$((pass_count + 1)); fi

# run status
expect_match "status header" 'visibility demo \[running\] 2/4 done' "$(o run status "$R")"
expect_match "status running line" 'running s:' "$(o run status "$R")"
expect_match "status link" '^http://127.0.0.1:[0-9]+/#/run/' "$(o run status "$R")"
expect_match "status json" '"done": ?2|"done":2' "$(o run status "$R" --json)"

# run wait: change, then cursor, then timeout, then settled
(sleep 2; o node update "$R" s done >/dev/null) &
out=$(o run wait "$R" --timeout 20); rc=$?
expect_exit "wait wakes on change" 0 "$rc"
expect_match "wait prints the change" '^s running->done$' "$out"
R2=$(o run start "wait timeout")
o node add "$R2" x "X" >/dev/null; o node update "$R2" x running >/dev/null
o run wait "$R2" --timeout 2 >/dev/null 2>&1; expect_exit "wait times out" 124 "$?"
o node update "$R2" x done >/dev/null
o run wait "$R2" --timeout 5 >/dev/null 2>&1; expect_exit "wait reports change once" 0 "$?"
o run wait "$R2" --timeout 5 >/dev/null 2>&1; expect_exit "wait settled" 3 "$?"

# L1 ownership
RO=$(o run start "ownership")
o node add "$RO" u "Unowned" >/dev/null; o node add "$RO" w "Owned" >/dev/null
o node update "$RO" u running >/dev/null
o node update "$RO" w running --owner coordinator >/dev/null
expect_match "L1 owner stored" '^coordinator$' "$(jq -r '.nodes[] | select(.id=="w") | .owner' "$home/runs/$RO/state.json")"
expect_match "L1 sync prints unowned" '^unowned: u$' "$(o run sync "$RO" --no-retry)"
expect_match "L1 status marks unowned" 'running u:.*UNOWNED' "$(o run status "$RO")"
expect_match "L1 owned node is not marked" 'running w: [^U]*$' "$(o run status "$RO")"
mkdir -p "$home/jobs/job-9"
o node add "$RO" j "Job" >/dev/null
o node update "$RO" j running --job job-9 >/dev/null
expect_match "L1 job id becomes owner" '^job-9$' "$(jq -r '.nodes[] | select(.id=="j") | .owner' "$home/runs/$RO/state.json")"

# L2 transitions
RT=$(o run start "transitions")
o node add "$RT" t "T" >/dev/null
o node update "$RT" t running --owner coordinator >/dev/null
o node update "$RT" t error --error boom >/dev/null
o node update "$RT" t waiting >/dev/null; expect_exit "L2 error->waiting" 0 "$?"
expect_match "L2 waiting clears started/finished/error/owner/job" '^null null null null null$' \
  "$(st "$RT" '.nodes[0] | [.started, .finished, .error, .owner, .job_id] | map(tostring) | join(" ")')"
expect_match "L2 failed attempt archived" '^boom$' "$(st "$RT" '.nodes[0].attempts[-1].error')"
o node update "$RT" t running --owner coordinator >/dev/null; o node update "$RT" t done >/dev/null
out=$(o node update "$RT" t running 2>&1); rc=$?
expect_exit "L2 done->running refused" 2 "$rc"
expect_match "L2 message names targets" 'can move to: nothing' "$out"
o node update "$RT" t waiting >/dev/null 2>&1; expect_exit "L2 done->waiting needs force" 2 "$?"
o node update "$RT" t waiting --force >/dev/null; expect_exit "L2 force allows" 0 "$?"
expect_match "L2 transitions land in events" '"from":"done","to":"waiting"' "$(cat "$home/runs/$RT/events.jsonl")"
o node update "$RT" t skipped >/dev/null
expect_match "L2 skipped->done refused with targets" 'can move to: waiting running' "$(o node update "$RT" t done 2>&1)"

# L5 job ids
out=$(o node update "$RT" t running --job nope 2>&1); rc=$?
expect_exit "L5 unknown job refused" 2 "$rc"
expect_match "L5 message" 'job nope not found' "$out"

# L3 dependencies across a carry
RC=$(o run start "origin")
o node add "$RC" fin "Finished" >/dev/null; o node update "$RC" fin running --owner coordinator >/dev/null; o node update "$RC" fin done >/dev/null
o node add "$RC" open "Open" >/dev/null
o run carry "$RC" >/dev/null 2>&1
N=$(grep -l "\"continued_from\": \"$RC\"" "$home"/runs/*/state.json | head -1 | xargs dirname | xargs basename)
out=$(o node add "$N" later "Later" --after fin 2>&1 >/dev/null); rc=$?
expect_exit "L3 finished origin dependency accepted" 0 "$rc"
expect_match "L3 note names origin" "dependency fin is finished in run $RC" "$out"
expect_match "L3 no edge created" '^0$' "$(st "$N" '[.edges[] | select(.[1] == "later")] | length')"
out=$(o node add "$N" bad "Bad" --after ghost 2>&1); rc=$?
expect_exit "L3 missing dependency refused" 2 "$rc"
expect_match "L3 error names searched runs" "searched: $N $RC" "$out"

# L4 node remove
RR=$(o run start "remove")
o node add "$RR" p "P" >/dev/null; o node add "$RR" q "Q" --after p >/dev/null; o node add "$RR" r "R" >/dev/null
o node remove "$RR" r >/dev/null; expect_exit "L4 removes waiting node" 0 "$?"
expect_match "L4 node gone" '^2$' "$(st "$RR" '.nodes | length')"
o node update "$RR" p running --owner coordinator >/dev/null
o node remove "$RR" p >/dev/null 2>&1; expect_exit "L4 refuses running node" 2 "$?"
o node update "$RR" p done >/dev/null
o node update "$RR" q running --owner coordinator >/dev/null
o node remove "$RR" p >/dev/null 2>&1; expect_exit "L4 refuses done node" 2 "$?"
o node remove "$RR" p --force >/dev/null; expect_exit "L4 force removes" 0 "$?"
expect_match "L4 edges removed" '^0$' "$(st "$RR" '.edges | length')"
expect_match "L4 event written" '"kind":"remove"' "$(cat "$home/runs/$RR/events.jsonl")"

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
