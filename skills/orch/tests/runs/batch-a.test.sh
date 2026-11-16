#!/usr/bin/env bash
# Tests for `node batch`, part a: mixed ops, done-verify, all-or-nothing validation, --dry-run, --file, usage errors.
# Run with: bash batch-a.test.sh
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


# mixed ops, stdin, blank lines skipped
R=$(o run start "batch demo")
out=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"Alpha"}' \
  '' \
  '{"op":"add","id":"b","label":"Beta","after":["a"],"role":"planning","tier":"balance"}' \
  '{"op":"update","id":"a","status":"running","owner":"coordinator"}' \
  '{"op":"report","id":"a","note":"halfway","input_tokens":12,"usd":0.5}' \
  '{"op":"update","id":"a","status":"done"}' | o node batch "$R" 2>&1); rc=$?
expect_exit "mixed batch exits 0" 0 "$rc"
expect_match "summary per op" '^line 1: add a "Alpha" ok' "$out"
expect_match "summary keeps input line numbers" 'line 6: update a -> done ok' "$out"
expect_match "final summary" 'applied 5 op\(s\)' "$out"
expect_match "a done" '^done$' "$(st "$R" '.nodes[] | select(.id == "a") | .status')"
expect_match "owner recorded" '^coordinator$' "$(st "$R" '.nodes[] | select(.id == "a") | .owner')"
expect_match "report recorded" '^halfway 12 0.5$' "$(st "$R" '.nodes[] | select(.id == "a") | "\(.report.note) \(.report.input_tokens) \(.report.usd)"')"
expect_match "b role and tier" '^planning balance$' "$(st "$R" '.nodes[] | select(.id == "b") | "\(.role) \(.tier)"')"
expect_match "edge a->b" '^a b$' "$(st "$R" '.edges[0] | join(" ")')"
expect_match "events like single commands" '^add add status note status note$' \
  "$(jq -rs 'map(.kind) | join(" ")' "$home/runs/$R/events.jsonl")"
# done without a handoff: the batch runs done-verify like `node update` (fast path and fallback)
expect_match "batch done without handoff is unverified" '^true$' "$(st "$R" '.nodes[] | select(.id == "a") | .unverified')"
expect_match "batch done-verify warns" 'done without handoff: a ' "$out"
RV=$(o run start "verify fallback")
out=$(printf '%s\n' '{"op":"add","id":"v","goal":"V"}' '{"op":"add","id":"w","goal":"W"}' '{"op":"update","id":"v","status":"done"}' \
  | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RV" 2>&1)
mkdir -p "$home/runs/$RV/out/w" && echo handoff > "$home/runs/$RV/out/w/handoff.md"
printf '%s\n' '{"op":"update","id":"w","status":"done"}' | o node batch "$RV" >/dev/null 2>&1
expect_match "fallback done without handoff is unverified" '^true$' "$(st "$RV" '.nodes[] | select(.id == "v") | .unverified')"
expect_match "done with a handoff stays verified" '^null$' "$(st "$RV" '.nodes[] | select(.id == "w") | .unverified')"

# invalid op rejects all, every error reported with its line number
before=$(cat "$home/runs/$R/state.json")
ev_before=$(wc -l < "$home/runs/$R/events.jsonl")
out=$(printf '%s\n' \
  '{"op":"add","id":"c","goal":"Gamma"}' \
  'not json' \
  '{"op":"update","id":"a","status":"waiting"}' \
  '{"op":"add","id":"d","goal":"Delta","bogus":1}' \
  '{"op":"report","id":"zz","note":"x"}' \
  '{"op":"frob","id":"c"}' | o node batch "$R" 2>&1); rc=$?
expect_exit "invalid batch exits 2" 2 "$rc"
expect_match "bad JSON names line 2" '^line 2: ' "$out"
expect_match "illegal move names line 3" '^line 3: node update: a is done' "$out"
expect_match "unknown field names line 4" '^line 4: unknown field\(s\) for add: bogus' "$out"
expect_match "unknown node names line 5" '^line 5: node zz: not in this run' "$out"
expect_match "unknown op names line 6" '^line 6: "op" must be add, report or update' "$out"
expect_match "nothing applied" '5 invalid op\(s\) of 6; nothing applied' "$out"
out2=$(printf '%s\n' '{"op":"add","id":"c","goal":"Gamma"}' 'not json' '{"op":"update","id":"a","status":"waiting"}' \
  '{"op":"add","id":"d","goal":"Delta","bogus":1}' '{"op":"report","id":"zz","note":"x"}' '{"op":"frob","id":"c"}' \
  | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$R" 2>&1)
if [ "$out" = "$out2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fallback errors differ\n%s\n---\n%s\n' "$out" "$out2" >&2; fi
if [ "$before" = "$(cat "$home/runs/$R/state.json")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: rejected batch changed state.json\n' >&2; fi
expect_match "no events written" "^ *$ev_before\$" "$(wc -l < "$home/runs/$R/events.jsonl")"
# A later op that depends on an earlier one in the same batch validates in order.
out=$(printf '%s\n' '{"op":"add","id":"c","goal":"Gamma"}' '{"op":"add","id":"d","goal":"Delta","after":"c"}' \
  | o node batch "$R" --dry-run 2>&1); rc=$?
expect_exit "in-batch dependency is valid" 0 "$rc"

# dry run: validates, prints, writes nothing
printf '%s\n' '{"op":"add","id":"e","goal":"Eps"}' '{"op":"update","id":"e","status":"skipped"}' > "$home/ops.jsonl"
before=$(cat "$home/runs/$R/state.json")
out=$(o node batch "$R" --file "$home/ops.jsonl" --dry-run 2>&1); rc=$?
expect_exit "dry run exits 0" 0 "$rc"
expect_match "dry run prints would" '^line 2: would update e -> skipped' "$out"
expect_match "dry run summary" 'dry run, nothing applied' "$out"
if [ "$before" = "$(cat "$home/runs/$R/state.json")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: dry run changed state.json\n' >&2; fi
o node batch "$R" --file "$home/ops.jsonl" >/dev/null 2>&1; rc=$?
expect_exit "--file applies" 0 "$rc"
expect_match "--file result" '^skipped$' "$(st "$R" '.nodes[] | select(.id == "e") | .status')"
o node batch "$R" --bogus </dev/null >/dev/null 2>&1; expect_exit "unknown flag rejected" 2 "$?"
printf '' | o node batch "$R" >/dev/null 2>&1; expect_exit "empty input rejected" 2 "$?"
o node batch no-such-run </dev/null >/dev/null 2>&1; expect_exit "unknown run rejected" 2 "$?"

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
