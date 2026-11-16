#!/usr/bin/env bash
# Tests for visibility, part b: backfill, --at, stale, run status, run wait.
# Self-contained; run with: bash visibility-b.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
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
. "$SCRIPT_DIR/../tests/test-home.sh"; seed_home "$home"

R=$(o run start "visibility demo")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"a","label":"Alpha"}
{"op":"add","id":"b","label":"Beta","after":"a"}
{"op":"add","id":"c","label":"Gamma"}
{"op":"update","id":"a","status":"running"}
OPS

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
(while [ ! -f "$home/runs/$R/wait.cursor" ]; do sleep 0.3; done; o node update "$R" s done >/dev/null) &
out=$(o run wait "$R" --timeout 20); rc=$?
expect_exit "wait wakes on change" 0 "$rc"
expect_match "wait prints the change" '^s running->done$' "$out"
R2=$(o run start "wait timeout")
o node add "$R2" x "X" >/dev/null; o node update "$R2" x running >/dev/null
o run wait "$R2" --timeout 2 >/dev/null 2>&1; expect_exit "wait times out" 124 "$?"
o node update "$R2" x done >/dev/null
o run wait "$R2" --timeout 5 >/dev/null 2>&1; expect_exit "wait reports change once" 0 "$?"
o run wait "$R2" --timeout 5 >/dev/null 2>&1; expect_exit "wait settled" 3 "$?"

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
