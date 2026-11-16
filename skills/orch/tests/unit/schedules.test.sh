#!/usr/bin/env bash
# Fast-tier unit tests for lib/automation/schedules.sh: cron math, add/edit argument checks and the
# run-state readers over fixture run dirs, called in-process. Nothing is fired.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export TZ=UTC
load_dispatch

# 1700000000 is Tue 2023-11-14 22:13:20 UTC.
expect_match "*/15 goes to the next quarter hour" '^1700000100$' "$(sched_cron_next '*/15 * * * *' 1700000000)"
expect_match "@hourly goes to the next top of the hour" '^1700002800$' "$(sched_cron_next '@hourly' 1700000000)"
expect_match "a Sunday cron goes to Sun 2023-11-19 00:00" '^1700352000$' "$(sched_cron_next '0 0 * * 0' 1700000000)"
expect_match "dow 7 is Sunday too" '^1700352000$' "$(sched_cron_next '0 0 * * 7' 1700000000)"
for bad in '61 * * * *' '* * *' 'a * * * *' '0 0 31 2 *'; do
  out=$(sched_cron_next "$bad" 1700000000 2>&1); rc=$?
  expect_exit "cron '$bad' is refused" 1 "$rc"
done

out=$(cmd_schedule_add --cron '@daily' --command true 2>&1); rc=$?
expect_exit "add without --name is refused" 2 "$rc"
out=$(cmd_schedule_add --name n --cron '@daily' --prompt hi --command true 2>&1); rc=$?
expect_exit "add with --prompt and --command is refused" 2 "$rc"
out=$(cmd_schedule_add --name n --cron '@daily' --command true --model m 2>&1); rc=$?
expect_exit "add --command with --model is refused" 2 "$rc"
out=$(cmd_schedule_add --name n --cron '99 * * * *' --command true 2>&1); rc=$?
expect_exit "add with a bad cron is refused" 2 "$rc"
out=$(cmd_schedule_add --name n --cron '@daily' --command true --timeout soon 2>&1); rc=$?
expect_exit "add with a bad --timeout is refused" 2 "$rc"
out=$(cmd_schedule_add --name n --cron '@daily' --command true --workdir "$H/no-such-dir" 2>&1); rc=$?
expect_exit "add with a missing --workdir is refused" 2 "$rc"
expect_missing "  ... and none of them wrote a schedule" "$SCHEDULES_HOME"

id=$(cmd_schedule_add --name nightly --cron '@daily' --command 'echo hi' --timeout 5m); rc=$?
expect_exit "a valid command schedule is added" 0 "$rc"
file=$(sched_file "$id")
expect_match "  ... as a command schedule with the parsed timeout" '^command 300 true$' \
  "$(jq -r '"\(.kind) \(.timeout) \(.enabled)"' "$file")"
expect_match "  ... and a numeric next_at" '^[0-9]+$' "$(jq -r .next_at "$file")"
out=$(cmd_schedule_set_enabled false "$id")
expect_match "disable clears next_at" '^false null$' "$(jq -r '"\(.enabled) \(.next_at)"' "$file")"
out=$(cmd_schedule_edit "$id" --command '' 2>&1); rc=$?
expect_exit "edit to an empty --command is refused" 2 "$rc"
out=$(cmd_schedule_edit "$id" 2>&1); rc=$?
expect_exit "edit with nothing to change is refused" 2 "$rc"
out=$(cmd_schedule_log "$id" x 2>&1); rc=$?
expect_exit "log with a non-numeric index is refused" 2 "$rc"
out=$(cmd_schedule_next 'bad cron' 2>&1); rc=$?
expect_exit "next of a bad cron is refused" 2 "$rc"

# Fixture command runs: an exit marker decides ok or failed; no marker and no pid is lost.
r=$(new_tmp)
mkdir -p "$r/ok" "$r/bad" "$r/gone"
printf '0' > "$r/ok/exit"
printf '3' > "$r/bad/exit"
run_json() { jq -cn --arg r "$1" '{kind: "command", ref: $r}'; }
expect_match "exit 0 reads ok" '^ok$' "$(sched_run_state "$(run_json "$r/ok")")"
expect_match "exit 3 reads failed" '^failed$' "$(sched_run_state "$(run_json "$r/bad")")"
expect_match "no exit and no pid reads lost" '^lost$' "$(sched_run_state "$(run_json "$r/gone")")"
edit_json "$file" "$(printf '.runs = [{kind:"command",ref:"%s/bad",status:"running"},{kind:"command",ref:"%s/gone",status:"running"}]' "$r" "$r")"
out=$(cmd_schedule_list --json)
expect_match "list reaps running runs to their final state" '^failed 3 lost null$' \
  "$(printf '%s' "$out" | jq -r '.[0].runs | "\(.[0].status) \(.[0].exit) \(.[1].status) \(.[1].exit)"')"
expect_match "  ... and reports the newest run's status" '^failed$' "$(printf '%s' "$out" | jq -r '.[0].last_status')"

cleanup_dir "$r"
cleanup_dir "$(dirname "$H")"
finish
