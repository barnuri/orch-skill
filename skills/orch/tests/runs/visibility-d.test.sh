#!/usr/bin/env bash
# Tests for visibility, part d: L3 dependencies across a carry, L4 node remove.
# Self-contained; run with: bash visibility-d.test.sh
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

# L3 dependencies across a carry
RC=$(o run start "origin")
o node batch "$RC" >/dev/null <<'OPS'
{"op":"add","id":"fin","label":"Finished"}
{"op":"update","id":"fin","status":"running","owner":"coordinator"}
{"op":"update","id":"fin","status":"done"}
{"op":"add","id":"open","label":"Open"}
OPS
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
o node batch "$RR" >/dev/null <<'OPS'
{"op":"add","id":"p","label":"P"}
{"op":"add","id":"q","label":"Q","after":"p"}
{"op":"add","id":"r","label":"R"}
OPS
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
