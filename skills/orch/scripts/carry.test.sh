#!/usr/bin/env bash
# Tests for `dispatch.sh run carry`: the unfinished part of a run moves to a new run, and a node that is
# running moves exactly as it is. Self-contained; run with: bash carry.test.sh
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
o() { HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }
o init >/dev/null 2>&1

R=$(o run start "carry demo")
o node add "$R" a "Finished" >/dev/null
o node add "$R" b "Running" --after a --profile claude-default >/dev/null
o node add "$R" c "Waiting on b" --after b >/dev/null
o node add "$R" d "Independent" >/dev/null
o node add "$R" e "Failed" >/dev/null
o node add "$R" f "Skipped on purpose" >/dev/null
o node update "$R" a running >/dev/null; o node update "$R" a done >/dev/null
o node update "$R" b running --job job-123 --force >/dev/null
o node update "$R" e running >/dev/null; o node update "$R" e error --error "boom" >/dev/null
o node update "$R" f skipped >/dev/null
out_b=$(o node out "$R" b); echo "partial" > "$out_b/handoff.md"
before_b=$(st "$R" '.nodes[] | select(.id=="b") | del(.out_dir)' | jq -S .)

N=$(o run carry "$R" 2>/dev/null); rc=$?
expect_exit "carry exits 0" 0 "$rc"
expect_match "carry prints the new run id" '^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$' "$N"

expect_match "the new run holds b, c, d and e, not the finished or skipped nodes" '^b c d e$' "$(st "$N" '[.nodes[].id] | join(" ")')"
expect_match "a running node is still running" '^running$' "$(st "$N" '.nodes[] | select(.id=="b") | .status')"
after_b=$(st "$N" '.nodes[] | select(.id=="b") | del(.out_dir)' | jq -S .)
expect_match "every field of the running node is unchanged (start time, job id, profile)" '^true$' "$([ "$before_b" = "$after_b" ] && echo true || echo false)"
expect_match "the running node keeps its job id" '^job-123$' "$(st "$N" '.nodes[] | select(.id=="b") | .job_id')"
expect_match "a failed node keeps its status and error" '^error boom$' "$(st "$N" '.nodes[] | select(.id=="e") | "\(.status) \(.error)"')"
expect_match "a waiting node is still waiting" '^waiting$' "$(st "$N" '.nodes[] | select(.id=="c") | .status')"

expect_match "the edge between kept nodes survives" '^b>c$' "$(st "$N" '[.edges[] | join(">")] | join(",")')"
expect_match "the edge from a finished node is dropped" '^false$' "$(st "$N" 'any(.edges[]; .[0] == "a")')"

expect_match "the new run records where it came from" "^$R\$" "$(st "$N" '.continued_from')"
expect_match "the old run records where the work went" "^$N\$" "$(st "$R" '.continued_to')"
expect_match "the old run keeps the finished node done" '^done$' "$(st "$R" '.nodes[] | select(.id=="a") | .status')"
expect_match "moved nodes are marked in the old run" "^moved to run $N\$" "$(st "$R" '.nodes[] | select(.id=="b") | .error')"
expect_match "the old run closes as done" '^done$' "$(st "$R" '.status')"

expect_match "the running job's handoff folder is not moved" '^partial$' "$(cat "$out_b/handoff.md")"
expect_match "node out in the new run points at the same folder" "^$out_b\$" "$(o node out "$N" b)"
expect_match "an unmoved node's folder is still under its own run" "/runs/$N/out/d\$" "$(o node out "$N" d)"

# `run sync` finds the job by id in jobs/, so a fake id is rightly reported dead there: that proves the lookup
# still works in the new run, and it is not the carry changing the node.
expect_match "run sync on the new run looks the job up (a fake job id is reported dead)" '^b[[:space:]]+error$' "$(o run sync "$N" 2>/dev/null | grep -E '^b[[:space:]]')"

out=$(o run carry "$R" 2>&1); rc=$?
expect_exit "carrying a run with nothing unfinished is not an error" 0 "$rc"
expect_match "and says so" 'nothing to carry' "$out"
out=$(o run carry no-such-run 2>&1); rc=$?
expect_exit "an unknown run exits 2" 2 "$rc"
out=$(o run carry 2>&1); rc=$?
expect_exit "no run id exits 2" 2 "$rc"
out=$(o run carry "$N" --nope 2>&1); rc=$?
expect_exit "an unknown flag exits 2" 2 "$rc"

R2=$(o run start "keep open demo"); o node add "$R2" x "waiting" >/dev/null
N2=$(o run carry "$R2" --keep-open --title "renamed" 2>/dev/null)
expect_match "--keep-open leaves the old run running" '^running$' "$(st "$R2" '.status')"
expect_match "--title names the new run" '^renamed$' "$(st "$N2" '.title')"

R3=$(o run start "keep skipped demo"); o node add "$R3" y "skipped one" >/dev/null; o node update "$R3" y skipped >/dev/null
N3=$(o run carry "$R3" --keep-skipped 2>/dev/null)
expect_match "--keep-skipped carries skipped nodes too" '^y$' "$(st "$N3" '[.nodes[].id] | join(",")')"

trash "$home" 2>/dev/null || true
printf '\n%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ] || exit 1
