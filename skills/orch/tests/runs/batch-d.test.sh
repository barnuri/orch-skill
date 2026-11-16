#!/usr/bin/env bash
# Tests for `node batch`, part d: hold / clear_hold: fast path vs fallback vs single calls.
# Run with: bash batch-d.test.sh
set -u
export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0
# The equivalence checks compare whole state files: pin the session id (else each call records its
# own pid-N harness_session) and drop the identity a calling orch node or opencode session exports.
export CLAUDE_CODE_SESSION_ID=batch-test
unset OPENCODE_SESSION_ID ORCH_EVENT_BY ORCH_SESSION_ID ORCH_RUN_ID ORCH_NODE_ID ORCH_NODE_OUT ORCH_JOB_DIR

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
o() { HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }

# norm/evk: compare whole state files and events across runs.
norm() {
  jq -S 'del(.run_id, .title, .started) | walk(if type == "object" then
    with_entries(select(.key | IN("created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked") | not))
    else . end)' "$home/runs/$1/state.json"
}
evk() { jq -c '[.kind, .node, .from, .to, .note, .by]' "$home/runs/$1/events.jsonl"; }

# hold / clear_hold: fast path vs fallback vs single calls; running clears the hold
hops=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"A"}' \
  '{"op":"add","id":"b","goal":"B"}' \
  '{"op":"update","id":"a","hold":"until load < 4"}' \
  '{"op":"update","id":"b","hold":"later"}' \
  '{"op":"update","id":"b","clear_hold":true}' \
  '{"op":"update","id":"b","hold":"again"}' \
  '{"op":"update","id":"b","status":"running","owner":"coordinator"}')
HF=$(o run start "hold fast" --id hold-fast)
HB=$(o run start "hold fallback" --id hold-fallback)
HS=$(o run start "hold single" --id hold-single)
hfo=$(printf '%s\n' "$hops" | o node batch "$HF" 2>&1); rc=$?
expect_exit "hold batch (fast) exits 0" 0 "$rc"
hbo=$(printf '%s\n' "$hops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$HB" 2>&1); rc=$?
expect_exit "hold batch (fallback) exits 0" 0 "$rc"
o node add "$HS" a A >/dev/null; o node add "$HS" b B >/dev/null
o node update "$HS" a --hold "until load < 4" >/dev/null
o node update "$HS" b --hold later >/dev/null
o node update "$HS" b --clear-hold >/dev/null
o node update "$HS" b --hold again >/dev/null
o node update "$HS" b running --owner coordinator >/dev/null
if [ "$hfo" = "$hbo" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: hold fast and fallback output differ\n%s\n---\n%s\n' "$hfo" "$hbo" >&2; fi
expect_match "hold set" '^until load < 4$' "$(st "$HF" '.nodes[] | select(.id == "a") | .hold')"
expect_match "running cleared the hold" '^null$' "$(st "$HF" '.nodes[] | select(.id == "b") | .hold')"
expect_match "hold events" '^until load < 4,later,cleared,again$' "$(jq -rs '[.[] | select(.kind == "hold") | .note] | join(",")' "$home/runs/$HF/events.jsonl")"
for other in "$HB" "$HS"; do
  if [ "$(norm "$HF")" = "$(norm "$other")" ] && [ "$(evk "$HF")" = "$(evk "$other")" ]; then pass_count=$((pass_count + 1)); else
    failures=$((failures + 1)); printf 'FAIL: hold batch differs from %s\n' "$other" >&2
    diff <(norm "$HF") <(norm "$other") >&2; diff <(evk "$HF") <(evk "$other") >&2; fi
done
hbad=$(printf '%s\n' '{"op":"update","id":"a","hold":""}' '{"op":"update","id":"a","hold":"x","clear_hold":true}')
h1=$(printf '%s\n' "$hbad" | o node batch "$HF" 2>&1)
h2=$(printf '%s\n' "$hbad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$HF" 2>&1)
expect_match "empty hold refused" '^line 1: node update: --hold expects a reason' "$h1"
expect_match "hold with clear_hold refused" 'line 2: "hold" and "clear_hold" cannot be combined' "$h1"
if [ "$h1" = "$h2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: hold fast and fallback errors differ\n%s\n---\n%s\n' "$h1" "$h2" >&2; fi

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
