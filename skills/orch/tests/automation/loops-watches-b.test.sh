#!/usr/bin/env bash
# dispatch.sh tests: loop session modes, runtime cap, resume and recovery (split from loops-watches.test.sh)
# Run: bash loops-watches-b.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

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
seed_home "$home"

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

cleanup_dir "$home"

finish
