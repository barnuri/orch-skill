#!/usr/bin/env bash
# Tests for `node report`, `node add --model` and the node timestamps. Run: bash record.test.sh

set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"

failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}

expect_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$expected" "$actual" >&2
  failures=$((failures + 1))
}

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$label" "$expected" "$actual" >&2
  failures=$((failures + 1))
}

cleanup_dir() { trash "$1" 2>/dev/null || true; }

HOME_DIR=$(mktemp -d)
export HARNESS_ORCH_HOME="$HOME_DIR"
orch() { bash "$SCRIPT" "$@"; }
node_json() { jq -c --arg n "$2" '.nodes[] | select(.id == $n)' "$HOME_DIR/runs/$1/state.json"; }

run_id=$(orch run start "record test" | tail -1 | tr -d '[:space:]')
orch node add "$run_id" a "first" --model claude-opus-5-5 >/dev/null
orch node add "$run_id" b "second" --after a >/dev/null

# node add --model
expect_eq "add --model stores the model" "claude-opus-5-5" "$(node_json "$run_id" a | jq -r .model)"
expect_eq "add without --model leaves null" "null" "$(node_json "$run_id" b | jq -r .model)"

# timestamps are real and stamped by status
expect_eq "waiting node has no started" "null" "$(node_json "$run_id" a | jq -r .started)"
before=$(date -u +%s)
orch node update "$run_id" a running
started=$(node_json "$run_id" a | jq -r .started)
expect_match "running stamps started" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$' "$started"
expect_eq "running leaves finished null" "null" "$(node_json "$run_id" a | jq -r .finished)"
started_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$started" +%s 2>/dev/null || date -u -d "$started" +%s)
if [ "$started_epoch" -ge "$((before - 1))" ] && [ "$started_epoch" -le "$(($(date -u +%s) + 1))" ]; then
  pass_count=$((pass_count + 1))
else
  printf 'FAIL: started is not the current time: %s\n' "$started" >&2
  failures=$((failures + 1))
fi
sleep 2
orch node update "$run_id" a done
finished=$(node_json "$run_id" a | jq -r .finished)
expect_match "done stamps finished" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$' "$finished"
if [ "$finished" \> "$started" ]; then
  pass_count=$((pass_count + 1))
else
  printf 'FAIL: finished %s is not after started %s\n' "$finished" "$started" >&2
  failures=$((failures + 1))
fi
orch node update "$run_id" b running
orch node update "$run_id" b error --error boom
expect_match "error stamps finished" '^20' "$(node_json "$run_id" b | jq -r .finished)"

# node report
out=$(orch node report "$run_id" a --model claude-opus-5-5 --input-tokens 1200 --output-tokens 300 --cache-read-tokens 5000 --usd 0.42 --note "inline" 2>&1)
expect_exit "report all flags" 0 "$?"
report=$(node_json "$run_id" a | jq -c .report)
expect_eq "report model" "claude-opus-5-5" "$(printf '%s' "$report" | jq -r .model)"
expect_eq "report input" "1200" "$(printf '%s' "$report" | jq -r .input_tokens)"
expect_eq "report output" "300" "$(printf '%s' "$report" | jq -r .output_tokens)"
expect_eq "report cache" "5000" "$(printf '%s' "$report" | jq -r .cache_read_tokens)"
expect_eq "report usd" "0.42" "$(printf '%s' "$report" | jq -r .usd)"
expect_eq "report tagged inline" "inline" "$(printf '%s' "$report" | jq -r .reported_by)"
expect_eq "report note" "inline" "$(printf '%s' "$report" | jq -r .note)"

orch node report "$run_id" b --model claude-haiku-4-5 >/dev/null
expect_eq "omitted usd stays null" "null" "$(node_json "$run_id" b | jq -r .report.usd)"
expect_eq "omitted tokens stay null" "null" "$(node_json "$run_id" b | jq -r .report.input_tokens)"
expect_eq "report sets node model" "claude-haiku-4-5" "$(node_json "$run_id" b | jq -r .model)"
expect_eq "report leaves cost null" "null" "$(node_json "$run_id" b | jq -r .cost)"

orch node report "$run_id" b --usd 0.01 --note "just cost" >/dev/null
expect_eq "model-less report keeps node model" "claude-haiku-4-5" "$(node_json "$run_id" b | jq -r .model)"

# validation
out=$(orch node report "$run_id" a 2>&1); expect_exit "report with nothing" 2 "$?"
expect_match "report nothing message" 'nothing to record' "$out"
out=$(orch node report "$run_id" a --input-tokens abc 2>&1); expect_exit "report bad tokens" 2 "$?"
out=$(orch node report "$run_id" a --usd -1 2>&1); expect_exit "report negative usd" 2 "$?"
out=$(orch node report "$run_id" nope --usd 1 2>&1); expect_exit "report unknown node" 2 "$?"
out=$(orch node report "$run_id" a --bogus 2>&1); expect_exit "report unknown flag" 2 "$?"

# exposure
out=$(orch run sync "$run_id" 2>&1)
expect_match "sync lists reported node" 'reported: a inline model=claude-opus-5-5 in=1200 out=300 usd=0.42' "$out"
expect_match "sync shows missing as dash" 'reported: b inline model=claude-haiku-4-5 in=- out=- usd=0.01' "$out"
out=$(orch node digest "$run_id" a 2>&1)
expect_match "digest shows report" 'reported: inline model=claude-opus-5-5' "$out"

cleanup_dir "$HOME_DIR"
printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
