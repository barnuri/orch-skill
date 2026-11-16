#!/usr/bin/env bash
# dispatch.sh tests: loops, watches and the active summary: basics (split from loops-watches.test.sh)
# Run: bash loops-watches-a.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
shims="$home/shims"
mkdir -p "$shims"
# A fake claude shim stands in for the harness. Loop intervals are the 10s minimum, so these
# cases finish in a few seconds: the first tick is immediate.
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
echo "tick"
[ -n "${STOP_LOOP:-}" ] && echo STOP > "$ORCH_LOOP_CONTROL"
exit 0
SHIM
chmod +x "$shims/claude"
loop_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" bash "$SCRIPT" "$@"; }
seed_home "$home"

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

cleanup_dir "$home"

finish
