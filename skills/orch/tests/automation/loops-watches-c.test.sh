#!/usr/bin/env bash
# dispatch.sh tests: streaming watches, loops as runs, --when-idle, watch caps (split from loops-watches.test.sh)
# Run: bash loops-watches-c.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
shims="$home/shims"
mkdir -p "$shims"
# The claude shim echoes the session env it saw.
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
echo "sess=${ORCH_SESSION_ID:-} resume=${ORCH_RESUME_SESSION:-}"
exit "${SHIM_EXIT:-0}"
SHIM
chmod +x "$shims/claude"
loop_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" bash "$SCRIPT" "$@"; }
seed_home "$home"

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
mv "$home/busy" "$home/busy.off"
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
