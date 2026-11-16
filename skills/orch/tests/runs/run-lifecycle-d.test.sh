#!/usr/bin/env bash
# dispatch.sh tests: run retry, auto retry, backoff, quota fallback (split from run-lifecycle.test.sh)
# Run: bash run-lifecycle-d.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# run retry and auto retry: failed attempts are archived, runs reopen, and the scheduler never
# retries forever.
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
edit_json "$home/profiles.json" '.settings.max_parallel = 1'
orch run start "Run retry" --id retry-2 >/dev/null 2>&1
orch node add retry-2 a "a" >/dev/null 2>&1
orch node add retry-2 b "b" >/dev/null 2>&1
edit_json "$home/runs/retry-2/state.json" '
  .status = "error" | .finished = "2026-09-01T00:00:00Z"
  | .nodes[0] += {status:"error", adapter:"claude-native", prompt:"a", job_id:"old-a", error:"exit=1", finished:"2026-09-01T00:00:00Z"}
  | .nodes[1] += {status:"error", adapter:"claude-native", prompt:"b", job_id:"old-b", error:"exit=1", finished:"2026-09-01T00:00:00Z"}'
out=$(orch run retry retry-2 2>&1); rc=$?
expect_exit "run retry exits 0" 0 "$rc"
expect_match "run retry dispatches within max_parallel" '^retried: a$' "$out"
expect_match "run retry leaves extra failures waiting" '^waiting: b$' "$out"
expect_match "run retry records one running node" '^1$' "$(jq '[.nodes[] | select(.status == "running")] | length' "$home/runs/retry-2/state.json")"
expect_match "run retry records one waiting node" '^1$' "$(jq '[.nodes[] | select(.status == "waiting")] | length' "$home/runs/retry-2/state.json")"
cleanup_dir "$home"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
edit_json "$home/profiles.json" '.settings.max_attempts = 2'
orch run start "Auto retry" --id retry-3 >/dev/null 2>&1
orch node add retry-3 first "first" >/dev/null 2>&1
orch node add retry-3 spent "spent" >/dev/null 2>&1
edit_json "$home/runs/retry-3/state.json" '
  .nodes[0] += {status:"error", adapter:"claude-native", prompt:"first", job_id:"old-first", error:"exit=1", finished:"2026-09-01T00:00:00Z", next_retry_at:"2000-01-01T00:00:00Z"}
  | .nodes[1] += {status:"error", adapter:"claude-native", prompt:"spent", job_id:"old-spent", error:"exit=1", finished:"2026-09-01T00:00:00Z", next_retry_at:"2000-01-01T00:00:00Z", attempts:[{job_id:"older", error:"exit=1", finished:"2026-09-01T00:00:00Z", log_tail:[], profile:null}]}'
out=$(orch run sync retry-3 2>&1); rc=$?
expect_exit "run sync with auto retry exits 0" 0 "$rc"
expect_match "auto retry consumes an available attempt" '^running$' "$(jq -r '.nodes[0].status' "$home/runs/retry-3/state.json")"
expect_match "auto retry archives the consumed attempt" '^1$' "$(jq '.nodes[0].attempts | length' "$home/runs/retry-3/state.json")"
expect_match "auto retry stops at max_attempts" '^error$' "$(jq -r '.nodes[1].status' "$home/runs/retry-3/state.json")"
cleanup_dir "$home"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
orch run start "Backoff retry" --id retry-backoff >/dev/null 2>&1
orch node add retry-backoff a "a" >/dev/null 2>&1
edit_json "$home/runs/retry-backoff/state.json" '
  .nodes[0] += {status:"error", adapter:"claude-native", prompt:"a", job_id:"old", error:"exit=1", finished:"2026-09-01T00:00:00Z", next_retry_at:"2999-01-01T00:00:00Z"}'
out=$(orch run sync retry-backoff 2>&1); rc=$?
expect_exit "auto retry before backoff exits 0" 0 "$rc"
expect_match "auto retry waits for next_retry_at" '^error$' "$(jq -r '.nodes[0].status' "$home/runs/retry-backoff/state.json")"
edit_json "$home/profiles.json" '.settings.max_attempts = -1'
edit_json "$home/runs/retry-backoff/state.json" '.nodes[0].next_retry_at = "2000-01-01T00:00:00Z" | .nodes[0].attempts = [{job_id:"1"},{job_id:"2"},{job_id:"3"},{job_id:"4"},{job_id:"5"}]'
out=$(orch run sync retry-backoff 2>&1); rc=$?
expect_exit "unlimited max_attempts auto retry exits 0" 0 "$rc"
expect_match "unlimited max_attempts still retries" '^running$' "$(jq -r '.nodes[0].status' "$home/runs/retry-backoff/state.json")"
edit_json "$home/profiles.json" '.settings.max_attempts = 0'
orch node update retry-backoff a error --force --error "again" >/dev/null 2>&1
out=$(orch run sync retry-backoff 2>&1); rc=$?
expect_exit "invalid max_attempts exits 2" 2 "$rc"
expect_match "invalid max_attempts is reported" 'settings.max_attempts must be -1 or an integer >= 1' "$out"
cleanup_dir "$home"

home=$(new_tmp)
shims=$(new_tmp)
cat > "$shims/copilot" <<'SHIM'
#!/usr/bin/env bash
printf 'copilot fallback ok\n'
SHIM
chmod +x "$shims/copilot"
orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" LLM_HUB_URL=http://127.0.0.1:1 LLM_HUB_KEY=dummy bash "$SCRIPT" "$@"; }
seed_home "$home"
edit_json "$home/profiles.json" '.settings.disabled_harnesses = []'
orch run start "Fallback retry" --id retry-4 >/dev/null 2>&1
orch node add retry-4 a "a" --profile claude-llm-hub >/dev/null 2>&1
edit_json "$home/runs/retry-4/state.json" '
  .nodes[0] += {status:"error", prompt:"again", job_id:"old", error:"exit=1", finished:"2026-09-01T00:00:00Z",
    next_retry_at:"2000-01-01T00:00:00Z", log_tail:["You have exceeded your monthly quota"]}'
out=$(orch run sync retry-4 2>&1); rc=$?
expect_exit "quota auto retry exits 0" 0 "$rc"
expect_match "quota retry switches to fallback profile" '^copilot-llm-hub$' "$(jq -r '.nodes[0].profile' "$home/runs/retry-4/state.json")"
expect_match "quota retry records the fallback reason" 'fallback profile copilot-llm-hub' "$(jq -r '.nodes[0].attempts[0].reason' "$home/runs/retry-4/state.json")"
expect_match "quota retry records restarted mode for fallback" '^restarted$' "$(jq -r '.nodes[0].attempts[0].retry_mode' "$home/runs/retry-4/state.json")"
cleanup_dir "$shims"
cleanup_dir "$home"

finish
