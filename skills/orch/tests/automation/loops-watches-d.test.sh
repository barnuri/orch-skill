#!/usr/bin/env bash
# dispatch.sh tests: watch liveness and restarts (split from loops-watches.test.sh)
# Run: bash loops-watches-d.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
shims="$home/shims"
mkdir -p "$shims"
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
echo "sess=${ORCH_SESSION_ID:-} resume=${ORCH_RESUME_SESSION:-}"
exit "${SHIM_EXIT:-0}"
SHIM
chmod +x "$shims/claude"
loop_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" bash "$SCRIPT" "$@"; }
seed_home "$home"

# Watch liveness: a signal records `stopped`; a SIGKILL (no trap runs) or a pid the OS reused for
# another process is reconciled to `dead` by the next read, with the reason and an event.
watch_state() { jq -r '.status+" "+(.reason // "")' "$home/watches/$1/state.json"; }
watch_id=$(loop_orch watch start --name sig --every 10s "echo hi" 2>/dev/null)
# The first event means the process is past sourcing dispatch.sh and its traps are set.
wait_until "[ -s \"$home/watches/$watch_id/events.jsonl\" ]" 20
kill -TERM "$(jq -r .pid "$home/watches/$watch_id/state.json")"
wait_until "[ \"\$(jq -r .status \"$home/watches/$watch_id/state.json\")\" = stopped ]" 20
expect_match "a TERM'd watch records stopped from its trap" '^stopped signal TERM$' "$(watch_state "$watch_id")"

watch_id=$(loop_orch watch start --name killed --every 10s "echo hi" 2>/dev/null)
wpid=$(jq -r .pid "$home/watches/$watch_id/state.json")
kill -9 -- "-$wpid" 2>/dev/null
wait_until "! kill -0 $wpid" 10
expect_match "a SIGKILLed watch still reads running on disk" '^running' "$(watch_state "$watch_id")"
expect_match "watch list shows a killed watch dead" "$watch_id	dead" "$(loop_orch watch list)"
expect_match "the dead watch keeps the reason" '^dead process [0-9]+ gone' "$(watch_state "$watch_id")"
expect_match "the dead watch gets a lifecycle event" '"kind":"lifecycle"' "$(tail -n 1 "$home/watches/$watch_id/events.jsonl")"
expect_no_match "active leaves a dead watch out" "$watch_id" "$(loop_orch active --json)"

# pid reuse: the record points at a live process that is not this watch.
watch_id=$(loop_orch watch start --name reused --every 10s "echo hi" 2>/dev/null)
kill -9 -- "-$(jq -r .pid "$home/watches/$watch_id/state.json")" 2>/dev/null
sleep 300 & other=$!
disown "$other" 2>/dev/null
env HARNESS_ORCH_HOME="$home" bash -c '. "$1"; watch_patch "$2" ".pid = \$p" --argjson p "$3"' _ "$SCRIPT" "$watch_id" "$other"
out=$(loop_orch active --json)
expect_no_match "a reused pid does not keep a watch alive" "$watch_id" "$out"
expect_match "the reused-pid watch is dead with the reason" '^dead pid [0-9]+ now belongs to another process$' "$(watch_state "$watch_id")"
watch_id=$(loop_orch watch start --name reused2 --every 10s "echo hi" 2>/dev/null)
kill -9 -- "-$(jq -r .pid "$home/watches/$watch_id/state.json")" 2>/dev/null
env HARNESS_ORCH_HOME="$home" bash -c '. "$1"; watch_patch "$2" ".pid = \$p" --argjson p "$3"' _ "$SCRIPT" "$watch_id" "$other"
expect_exit "watch stop never signals a reused pid (before any read)" 0 "$(loop_orch watch stop "$watch_id" >/dev/null 2>&1; kill -0 "$other" 2>/dev/null; echo $?)"
kill "$other" 2>/dev/null

# Restarts: after a host restart (every watch process SIGKILLed) `sync` brings a wanted scheduled
# watch back with a new pid and a `restarted` event; a watch whose run is terminal, or one a user
# stopped, stays ended.
live_run=$(loop_orch run start "live" 2>/dev/null)
over_run=$(loop_orch run start "over" 2>/dev/null)
w_live=$(loop_orch watch start --name live --every 10s "echo $live_run" 2>/dev/null)
w_over=$(loop_orch watch start --name over --every 10s "echo $over_run" 2>/dev/null)
w_user=$(loop_orch watch start --name user --every 10s "echo hi" 2>/dev/null)
loop_orch watch stop "$w_user" >/dev/null 2>&1
loop_orch run finish "$over_run" >/dev/null 2>&1
old_pid=$(jq -r .pid "$home/watches/$w_live/state.json")
killed_pids=""
for w in "$w_live" "$w_over"; do
  wpid=$(jq -r .pid "$home/watches/$w/state.json"); killed_pids="$killed_pids $wpid"
  kill -9 -- "-$wpid" 2>/dev/null
done
for wpid in $killed_pids; do wait_until "! kill -0 $wpid" 10; done
loop_orch sync --no-serve >/dev/null 2>&1
new_pid=$(jq -r '.pid // empty' "$home/watches/$w_live/state.json")
expect_match "sync restarts a killed scheduled watch" '^running' "$(watch_state "$w_live")"
expect_match "the restarted watch has a new live pid" '^[0-9]+$' "$new_pid"
[ "$new_pid" != "$old_pid" ] && kill -0 "$new_pid" 2>/dev/null; expect_exit "the new pid is alive and differs" 0 $?
expect_match "the restart is an event with the death reason" 'restarted \(was dead: process [0-9]+ gone' "$(cat "$home/watches/$w_live/events.jsonl")"
expect_match "watch list shows the restarted watch running" "$w_live	running" "$(loop_orch watch list)"
expect_match "a watch of a terminal run stays dead" '^dead ' "$(watch_state "$w_over")"
expect_match "a user-stopped watch stays stopped" '^stopped stopped$' "$(watch_state "$w_user")"
loop_orch watch stop "$w_live" >/dev/null 2>&1
cleanup_dir "$home"

finish
