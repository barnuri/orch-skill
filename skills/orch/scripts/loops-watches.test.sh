#!/usr/bin/env bash
# dispatch.sh tests: loops, watches, active summary
# Run: bash loops-watches.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

# --- loops, watches and the active summary -----------------------------------
# A fake claude shim stands in for the harness. Loop intervals are the 10s minimum, so these
# cases finish in a few seconds: the first tick is immediate.
home=$(new_tmp)
shims="$home/shims"
mkdir -p "$shims"
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
echo "tick"
[ -n "${STOP_LOOP:-}" ] && echo STOP > "$ORCH_LOOP_CONTROL"
exit 0
SHIM
chmod +x "$shims/claude"
loop_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" bash "$SCRIPT" "$@"; }
loop_orch init >/dev/null 2>&1

out=$(loop_orch loop start --profile claude-default "hi" 2>&1); rc=$?
expect_exit "loop start without --every exits 2" 2 "$rc"
out=$(loop_orch loop start --every 5s --profile claude-default "hi" 2>&1); rc=$?
expect_exit "loop start below the 10s floor exits 2" 2 "$rc"

loop_id=$(loop_orch loop start --every 10s --max 1 --profile claude-default "hi" 2>/dev/null)
expect_match "loop start prints a loop id" '^loop-' "$loop_id"
wait_until "[ \"\$(jq -r .status \"$home/loops/$loop_id/state.json\")\" = done ]"
expect_match "a max-1 loop finishes after one tick" 'done' "$(jq -r '.status+" "+.reason' "$home/loops/$loop_id/state.json")"
expect_match "the loop tail shows the iteration output" 'tick' "$(loop_orch loop tail "$loop_id" 2>&1)"

loop_id=$(STOP_LOOP=1 loop_orch loop start --every 10s --profile claude-default "hi" 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/loops/$loop_id/state.json\")\" = stopped ]"
expect_match "the agent can end its loop with STOP" 'stopped agent' "$(jq -r '.status+" "+.reason' "$home/loops/$loop_id/state.json")"

out=$(loop_orch active 2>&1)
expect_match "active reports nothing when idle" 'no active loops or watches' "$out"
expect_match "active --json is an empty array when idle" '^\[\]$' "$(loop_orch active --json 2>&1)"

watch_id=$(loop_orch watch start --name stream "printf 'ok\nFAIL one\nfine\nFAIL two\n'" --match 'FAIL' 2>/dev/null)
expect_match "watch start prints a watch id" '^watch-' "$watch_id"
out=$(loop_orch watch wait "$watch_id" --timeout 60 --max-lines 1 2>&1); rc=$?
expect_exit "watch wait returns 0 on a new event" 0 "$rc"
expect_match "watch wait prints the first matching line" 'FAIL one' "$out"
expect_no_match "watch wait caps output at --max-lines" 'FAIL two' "$out"
out=$(loop_orch watch wait "$watch_id" --timeout 60 2>&1)
expect_match "the cursor moves past events already shown" 'FAIL two' "$out"
out=$(loop_orch watch wait "$watch_id" --timeout 60 2>&1); rc=$?
expect_exit "watch wait exits 3 when the watch ended with no new event" 3 "$rc"

out=$(loop_orch watch start --name bad --every 5s "true" 2>&1); rc=$?
expect_exit "watch --every below the floor exits 2" 2 "$rc"
out=$(loop_orch watch start --name bad --on-match "x" "true" 2>&1); rc=$?
expect_exit "watch --on-match without a profile exits 2" 2 "$rc"

# Session modes, runtime cap, resume and recovery. The claude shim echoes the session env it saw.
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
echo "sess=${ORCH_SESSION_ID:-} resume=${ORCH_RESUME_SESSION:-}"
exit "${SHIM_EXIT:-0}"
SHIM
out=$(loop_orch loop start --every 10s --session resume opencode "x" 2>&1); rc=$?
expect_exit "--session resume needs a claude or copilot target" 2 "$rc"
out=$(loop_orch loop start --every 10s --max-runtime nope --profile claude-default "x" 2>&1); rc=$?
expect_exit "a bad --max-runtime exits 2" 2 "$rc"
loop_id=$(loop_orch loop start --every 10s --max 2 --session resume --profile claude-default "x" 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/loops/$loop_id/state.json\")\" = done ]"
expect_match "the first tick mints the session" '^sess=[0-9a-f-]{36} resume=$' "$(cat "$home/loops/$loop_id/iter-1.log")"
expect_match "later ticks resume that session" '^sess= resume=[0-9a-f-]{36}$' "$(cat "$home/loops/$loop_id/iter-2.log")"
expect_match "both ticks use one session id" "$(sed -n 's/^sess=\(.*\) resume=$/\1/p' "$home/loops/$loop_id/iter-1.log")" "$(cat "$home/loops/$loop_id/iter-2.log")"

loop_id=$(loop_orch loop start --every 10s --max-runtime 10s --profile claude-default "x" 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/loops/$loop_id/state.json\")\" = done ]"
expect_match "a loop past its runtime limit ends as done" 'done max-runtime' "$(jq -r '.status+" "+.reason' "$home/loops/$loop_id/state.json")"
out=$(loop_orch loop resume "$loop_id" 2>&1); rc=$?
expect_exit "a done loop cannot be resumed" 2 "$rc"

# Recovery: a loop whose process was killed restarts through `sync`, and the cut-off call counts.
loop_id=$(loop_orch loop start --every 10s --profile claude-default "x" 2>/dev/null)
wait_until "[ \"\$(jq -r .iteration \"$home/loops/$loop_id/state.json\")\" = 1 ]"
kill -9 "$(jq -r .pid "$home/loops/$loop_id/state.json")" 2>/dev/null
wait_until "loop_orch loop list | grep \"$loop_id\" | grep -q lost"
expect_match "a killed loop reads as lost" 'lost' "$(loop_orch loop list | grep "$loop_id")"
expect_match "a lost loop is reported for attention" '"status":"lost"' "$(loop_orch active --json)"
loop_orch sync --no-serve >/dev/null 2>&1
wait_until "loop_orch loop list | grep \"$loop_id\" | grep -q running"
expect_match "sync restarts a lost loop" 'running' "$(loop_orch loop list | grep "$loop_id")"
loop_orch loop stop "$loop_id" >/dev/null 2>&1
out=$(loop_orch loop resume "$loop_id" 2>&1); rc=$?
expect_exit "a stopped loop resumes" 0 "$rc"
loop_orch loop stop "$loop_id" >/dev/null 2>&1

# Watches: a stream watch stops its source when --until matches; the event cap trims old events.
cat > "$shims/beat" <<'SHIM'
#!/usr/bin/env bash
while :; do echo beat; sleep 1; done
SHIM
chmod +x "$shims/beat"
watch_id=$(loop_orch watch start --name beat beat --match beat --until beat 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/watches/$watch_id/state.json\")\" = done ]"
expect_match "--until ends a streaming watch" 'done until' "$(jq -r '.status+" "+.reason' "$home/watches/$watch_id/state.json")"
if pgrep -f "$shims/beat" >/dev/null 2>&1; then
  expect_match "the streaming source command is stopped" 'stopped' 'still running'
else
  expect_match "the streaming source command is stopped" 'stopped' 'stopped'
fi
# A loop is also an orch run: one node per tick, the tick's output in its handoff dir, and the run
# closes with the loop (done on max, cancelled on stop).
loop_id=$(loop_orch loop start --every 10s --max 2 --profile claude-default "Check the PR" 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/runs/$loop_id/state.json\")\" = done ]"
expect_match "a loop has a run with its id" "$loop_id" "$(loop_orch run list)"
expect_match "each tick is a node of the run" 'i1 done i2 done' "$(jq -r '[.nodes[] | .id + " " + .status] | join(" ")' "$home/runs/$loop_id/state.json")"
expect_file "a tick's output is kept in its node's handoff dir" "$home/runs/$loop_id/out/i1/output.txt"
expect_match "the run is done when the loop reaches --max" '^done$' "$(jq -r .status "$home/runs/$loop_id/state.json")"
loop_id=$(loop_orch loop start --every 10s --profile claude-default "x" 2>/dev/null)
wait_until "[ \"\$(jq -r '.nodes | length' \"$home/runs/$loop_id/state.json\")\" -ge 1 ]"
loop_orch loop stop "$loop_id" >/dev/null 2>&1
expect_match "stopping a loop cancels its run" '^cancelled$' "$(jq -r .status "$home/runs/$loop_id/state.json")"
out=$(loop_orch run sync "$loop_id" 2>&1); rc=$?
expect_exit "run sync is safe on a loop's run" 0 "$rc"

# --when-idle: a live opencode session that is mid-turn gets its tick skipped, an idle one runs.
cat > "$shims/opencode" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = api ]; then
  if [ -f "$FLAGDIR/busy" ]; then
    echo '{"data":[{"type":"assistant","time":{"created":1,"streamed":2}}],"cursor":null}'
  else
    echo '{"data":[{"type":"assistant","time":{"created":1,"completed":2},"finish":"stop"}],"cursor":null}'
  fi
  exit 0
fi
echo "ran: $*" >> "$FLAGDIR/ran.log"
SHIM
chmod +x "$shims/opencode"
idle_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" FLAGDIR="$home" bash "$SCRIPT" "$@"; }
out=$(idle_orch loop start --every 10s --when-idle --profile claude-default "x" 2>&1); rc=$?
expect_exit "--when-idle needs an opencode session target" 2 "$rc"
touch "$home/busy"
loop_id=$(idle_orch loop start --every 10s --session ses_test opencode "check" 2>/dev/null)
wait_until "[ \"\$(jq -r .skipped \"$home/loops/$loop_id/state.json\")\" -ge 1 ]"
expect_match "a busy session's tick is skipped and counted" '^0 1$' "$(jq -r '"\(.iteration) \(.skipped)"' "$home/loops/$loop_id/state.json")"
expect_missing "the harness was not called while the session was busy" "$home/ran.log"
rm -f "$home/busy"
wait_until "[ -f \"$home/ran.log\" ]"
expect_match "an idle session's tick runs" 'ran: run check' "$(cat "$home/ran.log" 2>/dev/null)"
idle_orch loop stop "$loop_id" >/dev/null 2>&1

# The runtime limit applies even when every line is filtered out by --match.
watch_id=$(loop_orch watch start --name quiet beat --match nomatch --max-runtime 10s 2>/dev/null)
wait_until "[ \"\$(jq -r .status \"$home/watches/$watch_id/state.json\")\" = done ]"
expect_match "a quiet stream still ends at --max-runtime" 'done max-runtime' "$(jq -r '.status+" "+.reason' "$home/watches/$watch_id/state.json")"
long=$(printf 'x%.0s' $(seq 1 2500))
watch_id=$(loop_orch watch start --name long "printf '$long\\n'" 2>/dev/null)
wait_until "[ -s \"$home/watches/$watch_id/events.jsonl\" ]"
expect_match "an event longer than the cap is truncated" '…$' "$(jq -r .text "$home/watches/$watch_id/events.jsonl")"
cleanup_dir "$home"


finish
