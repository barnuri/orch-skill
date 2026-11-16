#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/carry.sh: `run carry` moves unfinished nodes into a new run,
# called in-process on fixture runs.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

fixture() {  # fixture <run-id> <nodes-json> <edges-json>
  mkdir -p "$H/runs/$1"
  printf '{"run_id":"%s","title":"Old","started":"2026-01-01T00:00:00Z","finished":null,"status":"running","nodes":%s,"edges":%s}\n' \
    "$1" "$2" "$3" > "$H/runs/$1/state.json"
}

# --- arg errors
out=$(cmd_run_carry 2>&1); rc=$?
expect_exit "carry with no run is a usage error" 2 "$rc"
out=$(cmd_run_carry r1 --bogus 2>&1); rc=$?
expect_exit "carry rejects an unknown flag" 2 "$rc"
out=$(cmd_run_carry nope 2>&1); rc=$?
expect_exit "carry of an unknown run fails" 2 "$rc"

# --- nothing to carry when every node is done (skipped stays behind by default)
fixture fin '[{"id":"a","status":"done"},{"id":"s","status":"skipped"}]' '[]'
out=$(cmd_run_carry fin 2>&1); rc=$?
expect_exit "carry of a finished run succeeds" 0 "$rc"
expect_match "carry says there is nothing to carry" 'nothing to carry: all 2 node' "$out"
expect_match "no new run is made" '^fin$' "$(ls "$H/runs")"

# --- a mixed run: done stays, running/waiting move with their own edges
fixture r1 '[{"id":"a","status":"done"},{"id":"b","status":"running","job_id":"j1"},{"id":"c","status":"waiting"}]' \
  '[["a","b"],["b","c"]]'
mkdir -p "$H/runs/r1/out/b"
new=$(cmd_run_carry r1 --id r2 --title "Next" 2>/dev/null); rc=$?
expect_exit "carry of a mixed run succeeds" 0 "$rc"
expect_match "carry prints the new run id" '^r2$' "$new"
N="$H/runs/r2/state.json"
expect_match "the new run has the unfinished nodes and only their edges" '^Next b,c \[\["b","c"\]\] r1$' \
  "$(jq -r '"\(.title) \([.nodes[].id] | join(",")) \(.edges | tojson) \(.continued_from)"' "$N")"
expect_match "a moved node keeps its job and points at its existing out dir" "^j1 $H/runs/r1/out/b\$" \
  "$(jq -r '.nodes[] | select(.id == "b") | "\(.job_id) \(.out_dir)"' "$N")"
expect_match "a node with no out dir gets no pointer" '^null$' "$(jq -r '.nodes[] | select(.id == "c") | .out_dir' "$N")"
expect_match "the old run closes, its moved nodes are skipped, done stays done" '^done r2 done,skipped,skipped$' \
  "$(jq -r '"\(.status) \(.continued_to) \([.nodes[].status] | join(","))"' "$H/runs/r1/state.json")"

cleanup_dir "$(dirname "$H")"
finish
