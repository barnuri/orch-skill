#!/usr/bin/env bash
# Tests for visibility, part a: node add, node ping (heartbeat), node report, events.
# Self-contained; run with: bash visibility-a.test.sh
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

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
