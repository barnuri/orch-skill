#!/usr/bin/env bash
# Fast-tier unit tests for lib/automation/loops.sh: durations, argument checks and readers of
# fixture loop and watch dirs, called in-process. No loop or watch process is started.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

expect_match "parse_duration reads every unit" '^10 300 7200 86400 7$' \
  "$(printf '%s ' "$(parse_duration 10s)" "$(parse_duration 5m)" "$(parse_duration 2h)" "$(parse_duration 1d)" "$(parse_duration 7)" | sed 's/ $//')"
out=$(parse_duration 5x 2>&1); rc=$?
expect_exit "parse_duration refuses an unknown unit" 1 "$rc"

out=$(cmd_loop 2>&1); rc=$?
expect_exit "loop with no verb is a usage error" 2 "$rc"
out=$(cmd_loop_start --profile x hi 2>&1); rc=$?
expect_exit "loop start without --every is refused" 2 "$rc"
expect_match "  ... and says --every is required" 'every is required' "$out"
out=$(cmd_loop_start --every 5s --profile x hi 2>&1); rc=$?
expect_exit "loop start refuses an interval under 10s" 2 "$rc"
for verb in stop resume tail; do
  out=$(cmd_loop "$verb" no-such-loop 2>&1); rc=$?
  expect_exit "loop $verb of an unknown id is refused" 2 "$rc"
done

# A fixture loop: running with no pid is lost, unless it is a demo loop.
mkdir -p "$LOOPS_HOME/loop-a" "$LOOPS_HOME/loop-b"
printf '{"name":"claude","interval":600,"max":3,"started":"2026-01-01T00:00:00Z","session_mode":"fresh","deadline":0}' > "$LOOPS_HOME/loop-a/spec.json"
cp "$LOOPS_HOME/loop-a/spec.json" "$LOOPS_HOME/loop-b/spec.json"
printf '{"id":"loop-a","status":"running","iteration":0,"pid":null,"next_tick":0,"reason":null,"last_exit":null}' > "$LOOPS_HOME/loop-a/state.json"
printf '{"id":"loop-b","status":"stopped","iteration":2,"pid":null,"next_tick":0,"reason":"stopped","last_exit":0}' > "$LOOPS_HOME/loop-b/state.json"
expect_match "a running loop without a live pid is lost" '^lost$' "$(loop_alive_status loop-a)"
edit_json "$LOOPS_HOME/loop-a/state.json" '.demo = true'
expect_match "a demo loop stays running without a pid" '^running$' "$(loop_alive_status loop-a)"
expect_match "tail of a loop at iteration 0 says so" 'no iterations yet' "$(cmd_loop_tail loop-a)"
printf 'line one\nline two\n' > "$LOOPS_HOME/loop-b/iter-2.log"
out=$(cmd_loop_tail loop-b -n 1)
expect_match "tail shows the last iteration's log" 'iter 2' "$out"
expect_match "  ... limited to -n lines" '^── iter 2 ──.line two$' "$(printf '%s' "$out" | tr '\n' '.')"
out=$(cmd_loop_list)
expect_match "list shows both loops with their limits" 'loop-a.running.iter 0.every 600s.max 3.claude' "$out"
expect_match "  ... and the stopped one" 'loop-b.stopped' "$out"
out=$(cmd_active --json)
expect_match "active lists the running loop" '"id":"loop-a"' "$out"
expect_no_match "  ... and skips the stopped one" 'loop-b' "$out"

# Watches: argument checks, the restart rule and the event readers.
out=$(cmd_watch_start --name w 2>&1); rc=$?
expect_exit "watch start with no command is refused" 2 "$rc"
out=$(cmd_watch_start --on-match hi 'echo x' 2>&1); rc=$?
expect_exit "watch start --on-match without --profile is refused" 2 "$rc"
mkdir -p "$WATCHES_HOME/w1"
printf '{"name":"w","cmd":"true","interval":60,"deadline":%s}' "$(( $(date +%s) + 3600 ))" > "$WATCHES_HOME/w1/spec.json"
printf '{"id":"w1","status":"dead","reason":"gone","events":2}' > "$WATCHES_HOME/w1/state.json"
printf '{"n":1,"ts":"t1","text":"first"}\n{"n":2,"ts":"t2","text":"a\\nb"}\n' > "$WATCHES_HOME/w1/events.jsonl"
watch_restart_wanted w1; rc=$?
expect_exit "a dead scheduled watch is restarted" 0 "$rc"
edit_json "$WATCHES_HOME/w1/state.json" '.status = "stopped" | .reason = "stopped"'
watch_restart_wanted w1; rc=$?
expect_exit "a watch a user stopped is not restarted" 1 "$rc"
edit_json "$WATCHES_HOME/w1/state.json" '.status = "dead"'
edit_json "$WATCHES_HOME/w1/spec.json" '.name = "health:r1"'
watch_restart_wanted w1; rc=$?
expect_exit "a dead health monitor is not restarted" 1 "$rc"
out=$(watch_print_events w1 1 10)
expect_match "print_events counts the new events" '1 new event\(s\), 2 total' "$out"
expect_match "  ... and flattens newlines" '2.t2.a \| b' "$out"
expect_no_match "  ... and skips the old ones" 'first' "$out"
expect_match "watch events honours --limit" '^1.t1.first$' "$(cmd_watch_events w1 --limit 2 | head -n 1)"
out=$(cmd_watch_events nope 2>&1); rc=$?
expect_exit "watch events of an unknown id is refused" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
