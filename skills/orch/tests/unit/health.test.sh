#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/health.sh: node health classification of a hand-built
# state.json, the interval clamp, the running-run scan and argument errors, called in-process.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

expect_match "a too-short interval is raised to the minimum" '^10$' "$(ORCH_HEALTH_EVERY_SEC=3 health_every_sec)"
expect_match "a non-number interval falls back to the default" '^30$' "$(ORCH_HEALTH_EVERY_SEC=abc health_every_sec)"
expect_match "a valid interval is kept" '^45$' "$(ORCH_HEALTH_EVERY_SEC=45 health_every_sec)"

old=$(date -u -r $(( $(date +%s) - 3600 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)
new=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<EOF
{"run_id":"r1","title":"t","status":"running","edges":[["e","d"]],
 "nodes":[{"id":"a","status":"running","started":"$new"},
          {"id":"b","status":"running","owner":"job-1","job_id":"job-1","started":"$old","updated":"$old"},
          {"id":"f","status":"running","owner":"job-2","job_id":"job-2","started":"$new","updated":"$new"},
          {"id":"c","status":"waiting","needs_user":"pick a db"},
          {"id":"h","status":"waiting","hold":"later"},
          {"id":"d","status":"waiting"},
          {"id":"e","status":"waiting"}]}
EOF
line=$(ORCH_STALL_MIN=15 health_pass r1 0); rc=$?
expect_exit "a health pass succeeds" 0 "$rc"
hof() { printf '%s' "$line" | jq -r --arg n "$1" '.nodes[] | select(.id == $n) | "\(.health) \(.note)"'; }
expect_match "a running node with no owner and no job is unowned" '^unowned running with no owner' "$(hof a)"
expect_match "a running node quiet for an hour is stalled" '^stalled no activity since' "$(hof b)"
expect_match "a recently active running node is ok" '^ok null$' "$(hof f)"
expect_match "a waiting node that needs the user says so" '^needs-user needs the user: pick a db$' "$(hof c)"
expect_match "a held node is held" '^held held: later$' "$(hof h)"
expect_match "a node waiting on a dependency names it" '^ok waiting on e$' "$(hof d)"
expect_match "the ready list holds only the free node" '^\["e"\]$' "$(printf '%s' "$line" | jq -c .ready)"
expect_match "slots are max_parallel minus running" '^4 3 1$' "$(printf '%s' "$line" | jq -r '"\(.max_parallel) \(.running) \(.slots)"')"
expect_file "the pass is saved" "$H/health/r1.json"
expect_match "the first pass records the ready nodes as a change" 'ready: e' "$(printf '%s' "$line" | jq -r '.changes[].note')"

text=$(printf '%s' "$line" | health_render_text)
expect_match "the text report has the run header" '^run r1 \[running\]: running 3/4, slots 1$' "$text"
expect_match "the text report lists the stalled node" '^stalled: b — no activity since [0-9]{2}:[0-9]{2}$' "$text"

mkdir -p "$H/runs/r2" "$H/runs/loop-x" "$H/runs/r3"
printf '{"run_id":"r2","status":"done","nodes":[]}' > "$H/runs/r2/state.json"
printf '{"run_id":"loop-x","status":"running","nodes":[]}' > "$H/runs/loop-x/state.json"
printf '{not json' > "$H/runs/r3/state.json"
expect_match "only running non-loop runs are listed, past a corrupt file" '^r1$' "$(health_running_runs)"

out=$(cmd_run_health r1 --bogus 2>&1); rc=$?
expect_exit "an unknown flag is a usage error" 2 "$rc"
expect_match "the usage error names the flag" 'unknown argument --bogus' "$out"
out=$(cmd_run_health 2>&1); rc=$?
expect_exit "no run id is a usage error" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
