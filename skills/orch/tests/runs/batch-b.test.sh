#!/usr/bin/env bash
# Tests for `node batch`, part b: equivalence with the same ops run one by one, timing, fast path vs per-op fallback.
# Run with: bash batch-b.test.sh
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

# equivalence + timing: the same 10 ops as one batch and as 10 single calls
ops=$(printf '%s\n' \
  '{"op":"add","id":"p","goal":"Plan"}' \
  '{"op":"add","id":"i","goal":"Implement","after":"p","profile":"local-llm-fast","model":"m1"}' \
  '{"op":"add","id":"t","goal":"Tests","after":["p"],"plan_backed":true,"acceptance":"green"}' \
  '{"op":"update","id":"p","status":"running","owner":"coordinator"}' \
  '{"op":"report","id":"p","model":"opus","output_tokens":7,"note":"planned"}' \
  '{"op":"update","id":"p","status":"done"}' \
  '{"op":"update","id":"i","status":"running","owner":"pid 1"}' \
  '{"op":"update","id":"i","status":"error","error":"boom"}' \
  '{"op":"update","id":"t","status":"skipped"}' \
  '{"op":"report","id":"i","usd":1.25}')
# p ends done: give it a handoff in every equivalence run, so done-verify adds no note there.
ho() { mkdir -p "$home/runs/$1/out/p" && echo handoff > "$home/runs/$1/out/p/handoff.md"; }
RB=$(o run start "eq batch" --id eq-batch); ho "$RB"
RS=$(o run start "eq single" --id eq-single); ho "$RS"
t0=$(date +%s)
printf '%s\n' "$ops" | o node batch "$RB" >/dev/null 2>&1; rc=$?
t1=$(date +%s)
expect_exit "10-op batch exits 0" 0 "$rc"
o node add "$RS" p "Plan" >/dev/null
o node add "$RS" i "Implement" --after p --profile local-llm-fast --model m1 >/dev/null
o node add "$RS" t "Tests" --after p --plan-backed --acceptance green >/dev/null
o node update "$RS" p running --owner coordinator >/dev/null
o node report "$RS" p --model opus --output-tokens 7 --note planned >/dev/null
o node update "$RS" p done >/dev/null
o node update "$RS" i running --owner "pid 1" >/dev/null
o node update "$RS" i error --error boom >/dev/null
o node update "$RS" t skipped >/dev/null
o node report "$RS" i --usd 1.25 >/dev/null
t2=$(date +%s)
norm() {
  jq -S 'del(.run_id, .title, .started) | walk(if type == "object" then
    with_entries(select(.key | IN("created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked") | not))
    else . end)' "$home/runs/$1/state.json"
}
if [ "$(norm "$RB")" = "$(norm "$RS")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: batch state differs from single calls\n' >&2
  diff <(norm "$RB") <(norm "$RS") >&2; fi
evk() { jq -c '[.kind, .node, .from, .to, .note, .by]' "$home/runs/$1/events.jsonl"; }
if [ "$(evk "$RB")" = "$(evk "$RS")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: batch events differ from single calls\n' >&2
  diff <(evk "$RB") <(evk "$RS") >&2; fi
printf 'timing: 10 ops as one batch: %ss; as 10 single calls: %ss\n' $((t1 - t0)) $((t2 - t1))
[ $((t1 - t0)) -le $((t2 - t1)) ] && pass_count=$((pass_count + 1)) || {
  failures=$((failures + 1)); printf 'FAIL: batch (%ss) slower than single calls (%ss)\n' $((t1 - t0)) $((t2 - t1)) >&2; }

# the fast path and the per-op fallback (ORCH_BATCH_FAST=0) give the same state, events and output
RF=$(o run start "eq fallback" --id eq-fallback); ho "$RF"
fout=$(printf '%s\n' "$ops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RF" 2>&1); rc=$?
expect_exit "fallback batch exits 0" 0 "$rc"
if [ "$(norm "$RB")" = "$(norm "$RF")" ] && [ "$(evk "$RB")" = "$(evk "$RF")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast path and fallback differ\n' >&2
  diff <(norm "$RB") <(norm "$RF") >&2; diff <(evk "$RB") <(evk "$RF") >&2; fi
RG=$(o run start "eq fast out" --id eq-fast-out); ho "$RG"
gout=$(printf '%s\n' "$ops" | o node batch "$RG" 2>&1)
expect_match "fast and fallback print the same lines" "^$(printf '%s' "$fout" | wc -l | tr -d ' ')\$" "$(printf '%s' "$gout" | wc -l | tr -d ' ')"
if [ "$fout" = "$gout" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast and fallback output differ\n%s\n---\n%s\n' "$gout" "$fout" >&2; fi
bad=$(printf '%s\n' '{"op":"update","id":"p","status":"waiting"}' '{"op":"report","id":"p"}' '{"op":"add","id":"p","goal":"x"}' '{"op":"update","id":"t","status":"done","at":"2099-01-01T00:00:00Z"}' '{"op":"update","id":"t","status":"done","job":"nojob"}')
e1=$(printf '%s\n' "$bad" | o node batch "$RB" 2>&1)
e2=$(printf '%s\n' "$bad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RB" 2>&1)
expect_match "fast path rejects all 5" 'node batch: 5 invalid op\(s\) of 5' "$e1"
if [ "$e1" = "$e2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast and fallback errors differ\n%s\n---\n%s\n' "$e1" "$e2" >&2; fi

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
