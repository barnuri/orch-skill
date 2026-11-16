#!/usr/bin/env bash
# Fast-tier tests for the guards added from lessons 14-20 (skills/orch/references/lessons.md):
#  1 node ask: unread answers refused (exit 3), duplicate open question returned, not stored again
#  2 answers to an ended node lead its retry prompt under "Unread answers from the coordinator:"
#  3 node dispatch/retry refuse a second live job (jobs/<id>/node + live pid), unless --force
#  4 a node turned waiting releases its autodispatch claim
#  6 precommit-smoke.sh is present and every orch shell script parses (its full run is a manual gate)
# Watchdog guard 5 is in src/server/watchdog/watchdog-service.test.ts.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
printf '%s\n' '{"run_id":"r1","title":"Demo","started":"2026-01-01T00:00:00Z","finished":null,"status":"running",
 "nodes":[{"id":"a","label":"A","status":"running","started":null,"finished":null,"attempts":[],"usage":{}}],"edges":[]}' \
  > "$H/runs/r1/state.json"
F="$H/runs/r1/state.json"

# --- 1. node ask
out=$(cmd_node_ask r1 a "Which DB?" 2>&1); rc=$?
expect_exit "a new ask is stored" 0 "$rc"
expect_match "a new ask prints its id" '^m[0-9]+ asked$' "$out"
asks_before=$(ls "$H/runs/r1/inbox/orch" | wc -l | tr -d ' ')
out=$(cmd_node_ask r1 a "  which   DB?  " 2>&1); rc=$?
expect_exit "the same question, normalized, is not an error" 0 "$rc"
expect_match "a duplicate open question returns the first id" 'duplicate of an open question' "$out"
asks_after=$(ls "$H/runs/r1/inbox/orch" | wc -l | tr -d ' ')
expect_exit "a duplicate is not stored again" "$asks_before" "$asks_after"

# An unread answer blocks the next ask (exit 3).
inbox_new r1 a orch answer "Use Postgres" >/dev/null
out=$(cmd_node_ask r1 a "A new question" 2>&1); rc=$?
expect_exit "unread answers refuse the ask with exit 3" 3 "$rc"
expect_match "the refusal says read your answers first" 'read your answers first' "$out"
expect_match "the refusal prints the unread answer" 'Use Postgres' "$out"

# --- 2. answers reach the retry prompt first
ans=$(inbox_answers_prefix r1 a)
expect_match "the answer block starts with the retry header" '^Unread answers from the coordinator:' "$ans"
expect_match "the answer block lists the answer text" '- Use Postgres' "$ans"
expect_empty "an answer is delivered once" "$(inbox_answers_prefix r1 a)"

# --- 3. one live job per node
mkdir -p "$JOBS_HOME/job-live" "$JOBS_HOME/job-dead"
sleep 300 & live_pid=$!
printf '%s\n' "$live_pid" > "$JOBS_HOME/job-live/pid"
printf '%s\n' 999999 > "$JOBS_HOME/job-dead/pid"
printf 'r1/a\n' > "$JOBS_HOME/job-live/node"
printf 'r1/a\n' > "$JOBS_HOME/job-dead/node"
out=$(node_live_job r1 a); rc=$?
expect_exit "a node with a live pid has a live job" 0 "$rc"
expect_match "the live job id is printed" '^job-live$' "$out"
rm_dead=$(node_live_job r1 b 2>/dev/null); rc=$?
expect_exit "a node without a job has no live job" 1 "$rc"
kill "$live_pid" 2>/dev/null; wait "$live_pid" 2>/dev/null || true
out=$(node_live_job r1 a); rc=$?
expect_exit "a dead pid is not a live job" 1 "$rc"

# --- 4. waiting releases the autodispatch claim
claims="$H/autodispatch/r1/claims"
mkdir -p "$claims"
printf '{}\n' > "$claims/a@0"
node_release_claim r1 a
expect_missing "the claim of the node is released" "$claims/a@0"
expect_file "the released claim is kept as .released" "$(ls "$claims"/a@0.released-* | head -n1)"

# --- 6. precommit smoke is present, and every orch script parses
expect_file "the precommit smoke script exists" "$SCRIPT_DIR/../../../scripts/precommit-smoke.sh"
bad=0
while IFS= read -r s; do bash -n "$s" 2>/dev/null || bad=$((bad + 1)); done < <(find "$SCRIPT_DIR" -name '*.sh' -type f)
expect_exit "every orch shell script parses" 0 "$bad"

cleanup_dir "$(dirname "$H")"
kill "$live_pid" 2>/dev/null || true
finish