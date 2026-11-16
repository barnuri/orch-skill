#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/wait.sh: live counts, the cursor path, the WAIT_SCAN_JQ diff
# (status, ready, settled, run-ended, health, event replay), rendering and argument errors.
# cmd_run_wait is only called on argument errors, since a valid call blocks in its poll loop.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

mkdir -p "$H/runs/r1"
S="$H/runs/r1/state.json"
put() { printf '{"run_id":"r1","title":"t","status":"%s","edges":[["a","b"]],"nodes":[{"id":"a","status":"%s"},{"id":"b","status":"%s"}]}' "$1" "$2" "$3" > "$S"; }
# scan <cursor-json> [health-map] [event lines on stdin]
scan() {
  jq -c -n -R --slurpfile st "$S" --argjson cur "$1" --argjson hm "${2:-null}" --argjson notes 0 \
    '[inputs | try fromjson catch null] as $ev | '"$WAIT_SCAN_JQ"
}
kinds() { printf '%s' "$1" | jq -r '[.events[] | "\(.kind):\(.node // "-"):\(.to // .note // "-")"] | join(" ")'; }

put running waiting waiting
expect_match "live counts are running and ready" '^0 1$' "$(run_live_counts "$S")"
expect_match "the plain cursor path" "/runs/r1/wait\.cursor$" "$(wait_cursor_file r1)"
expect_match "the follow cursor path" "/runs/r1/wait\.follow\.cursor$" "$(wait_cursor_file r1 follow)"

out=$(scan '{"n":0}' </dev/null)
expect_match "the first scan only takes a snapshot" '^\[\]$' "$(printf '%s' "$out" | jq -c .events)"
cur=$(printf '%s' "$out" | jq -c .cursor)

put running running waiting
out=$(printf '{"kind":"status","node":"a","from":"waiting","to":"running"}\n' | scan "$cur")
expect_match "a status change is reported once, not again by the state diff" '^status:a:running$' "$(kinds "$out")"
cur=$(printf '%s' "$out" | jq -c .cursor)
expect_match "live counts follow the state" '^1 0$' "$(run_live_counts "$S")"

out=$(scan "$cur" '{"a":{"h":"stalled","note":"quiet"}}' </dev/null)
expect_match "a stalled health entry wakes the coordinator" '^stalled:a:quiet$' "$(kinds "$out")"
cur=$(printf '%s' "$out" | jq -c .cursor)
out=$(scan "$cur" '{"a":{"h":"stalled","note":"quiet"}}' </dev/null)
expect_match "the same stall is not reported twice" '^\[\]$' "$(printf '%s' "$out" | jq -c .events)"

put running done waiting
out=$(scan "$cur" </dev/null)
expect_match "done upstream reports the status and the newly ready node" '^status:a:done ready:-:b$' "$(kinds "$out")"
cur=$(printf '%s' "$out" | jq -c .cursor)

put running done done
out=$(scan "$cur" </dev/null)
expect_match "the last status change comes without settled" '^status:b:done$' "$(kinds "$out")"
cur=$(printf '%s' "$out" | jq -c .cursor)
out=$(scan "$cur" </dev/null)
expect_match "an idle open run settles" '^settled:-:no running or ready nodes$' "$(kinds "$out")"
cur=$(printf '%s' "$out" | jq -c .cursor)
out=$(scan "$cur" </dev/null)
expect_match "settled is reported once" '^\[\]$' "$(printf '%s' "$out" | jq -c .events)"

put done done done
out=$(scan "$cur" </dev/null)
expect_match "a closed run ends the wait" '^run-ended:-:done$' "$(kinds "$out")"

ev='[{"kind":"status","node":"a","from":"running","to":"error","note":"boom"},{"kind":"ready","node":null,"note":"b,c"},{"kind":"run-ended","node":null,"to":"done"},{"kind":"settled","node":null,"note":"idle"},{"kind":"stalled","node":"a","note":"quiet"}]'
txt=$(printf '%s' "$ev" | wait_render r1 0)
expect_match "status renders from->to with the error" '^a running->error: boom$' "$txt"
expect_match "ready renders the list" '^ready: b,c$' "$txt"
expect_match "run ended renders the status" '^run ended: done$' "$txt"
expect_match "settled renders the note" '^settled: idle$' "$txt"
expect_match "a node event renders node kind note" '^a stalled: quiet$' "$txt"
expect_match "json render tags each line with the run" '^r1 status error$' \
  "$(printf '%s' "$ev" | wait_render r1 1 | head -n 1 | jq -r '"\(.run) \(.kind) \(.to)"')"

out=$(cmd_run_wait r1 --timeout x 2>&1); rc=$?
expect_exit "a non-number timeout is a usage error" 2 "$rc"
out=$(cmd_run_wait r1 --stall-min 0 2>&1); rc=$?
expect_exit "a zero stall minute is a usage error" 2 "$rc"
out=$(cmd_run_wait r1 --bogus 2>&1); rc=$?
expect_exit "an unknown flag is a usage error" 2 "$rc"
out=$(cmd_run_wait r1 r2 2>&1); rc=$?
expect_exit "two run ids are a usage error" 2 "$rc"
out=$(cmd_run_wait 2>&1); rc=$?
expect_exit "no run id is a usage error" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
