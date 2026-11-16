#!/usr/bin/env bash
# dispatch.sh tests: run and node lifecycle, prune
# Run: bash run-lifecycle.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- run / node lifecycle -----------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
state_get() { jq -r "$@" "$state"; }
state="$home/runs/life-1/state.json"

out=$(orch run start "Lifecycle test" --id life-1 2>&1); rc=$?
expect_exit "run start exits 0" 0 "$rc"
expect_match "run start echoes the id" '^life-1$' "$out"
expect_file "run start writes state.json" "$state"
out=$(orch run start "dup" --id life-1 2>&1); rc=$?
expect_exit "duplicate run id exits 2" 2 "$rc"
out=$(orch run start "bad" --id 'bad id' 2>&1); rc=$?
expect_exit "invalid run id exits 2" 2 "$rc"

orch node add life-1 n1 "Plan" >/dev/null 2>&1
orch node add life-1 n2 "Implement" --after n1 --profile claude-default >/dev/null 2>&1
orch node add life-1 n3 "Review" --after n1,n2 >/dev/null 2>&1
out=$(orch node add life-1 n1 "again" 2>&1); rc=$?
expect_exit "duplicate node id exits 2" 2 "$rc"
out=$(orch node add life-1 n4 "x" --after nope 2>&1); rc=$?
expect_match "unknown dep is named" 'dependency nope is not in run' "$out"
expect_exit "unknown dep exits 2" 2 "$rc"
out=$(orch node add life-1 n4 "x" --after n4 2>&1); rc=$?
expect_exit "self-dependency exits 2" 2 "$rc"
expect_match "edges recorded from --after" '^\[\["n1","n2"\],\["n1","n3"\],\["n2","n3"\]\]$' "$(state_get -c '.edges')"
expect_match "node profile recorded" '^claude-default$' "$(state_get '.nodes[1].profile')"

out=$(orch run sync life-1 2>&1)
expect_match "only the root is ready initially" '^ready: n1$' "$out"
expect_match "nothing running initially" '^running: 0$' "$out"
orch node update life-1 n1 running >/dev/null 2>&1
expect_no_match "started stamped on running" '^null$' "$(state_get '.nodes[0].started')"
orch node update life-1 n1 "done" >/dev/null 2>&1
expect_no_match "finished stamped on done" '^null$' "$(state_get '.nodes[0].finished')"
out=$(orch run sync life-1 2>&1)
expect_match "n2 becomes ready once n1 is done" '^ready: n2$' "$out"
out=$(orch node update life-1 n2 bogus 2>&1); rc=$?
expect_match "invalid status is rejected" 'status must be one of' "$out"
expect_exit "invalid status exits 2" 2 "$rc"
orch node update life-1 n2 error --error "boom" >/dev/null 2>&1
expect_match "error message recorded" '^boom$' "$(state_get '.nodes[1].error')"
out=$(orch run finish life-1 2>&1)
expect_match "finish infers error from an errored node" '^error$' "$out"
expect_no_match "finish stamps finished" '^null$' "$(state_get '.finished')"
out=$(orch run list 2>&1)
expect_match "run list shows status, title and done/total" 'life-1.error.Lifecycle test.1/3' "$out"

# node add: role, tier, plan-backed and acceptance are stored on the node, and bad values are refused.
orch run start "Node options" --id opts-1 >/dev/null 2>&1
orch node add opts-1 a "planned" --role implementation --tier balance --plan-backed \
  --acceptance "unit tests pass; no new deps" >/dev/null 2>&1; rc=$?
expect_exit "node add with the new options exits 0" 0 "$rc"
opts_state="$home/runs/opts-1/state.json"
expect_match "node add stores the role" '^implementation$' "$(jq -r '.nodes[0].role' "$opts_state")"
expect_match "node add stores the tier" '^balance$' "$(jq -r '.nodes[0].tier' "$opts_state")"
expect_match "node add stores plan-backed as a boolean" '^true$' "$(jq -r '.nodes[0].plan_backed' "$opts_state")"
expect_match "node add stores the acceptance text" '^unit tests pass; no new deps$' "$(jq -r '.nodes[0].acceptance' "$opts_state")"
orch node add opts-1 b "plain" >/dev/null 2>&1
expect_match "a node added without options gets null role and tier" '^null null$' \
  "$(jq -r '.nodes[1] | "\(.role) \(.tier)"' "$opts_state")"
expect_match "a node added without options is not plan-backed" '^false$' "$(jq -r '.nodes[1].plan_backed' "$opts_state")"
out=$(orch node add opts-1 c "x" --role coding 2>&1); rc=$?
expect_exit "an unknown role exits 2" 2 "$rc"
expect_match "an unknown role is named in the error" '--role must be one of' "$out"
out=$(orch node add opts-1 c "x" --tier smart-auto 2>&1); rc=$?
expect_exit "an unknown tier exits 2" 2 "$rc"
expect_match "an unknown tier is named in the error" '--tier must be one of' "$out"
expect_match "node add usage lists the new options" '\[--role R\] \[--tier T\] \[--model M\] \[--plan-backed\] \[--acceptance' \
  "$(bash "$SCRIPT" --help 2>&1 || true)"
orch run finish opts-1 >/dev/null 2>&1

# node dispatch: claude-native flips to done on sync; a profile node against the fixture is
# observably running, then done.
state="$home/runs/disp-1/state.json"
orch run start "Dispatch test" --id disp-1 >/dev/null 2>&1
orch node add disp-1 a "native" >/dev/null 2>&1
orch node add disp-1 b "hub" --profile local-llm-fast >/dev/null 2>&1
out=$(orch node dispatch disp-1 a claude-native "hello" --flag value 2>/dev/null); rc=$?
expect_exit "node dispatch exits 0" 0 "$rc"
orch wait "$out" --timeout 60 --interval 1 >/dev/null 2>&1
out=$(orch run sync disp-1 2>&1)
expect_match "dispatched claude-native node flips to done" '^a.done$' "$out"
expect_match "adapter recorded on the node" '^claude-native$' "$(state_get '.nodes[0].adapter')"
expect_match "log_tail captured on sync" 'no subprocess spawned' "$(state_get '.nodes[0].log_tail[0]')"
expect_match "dispatch prompt is persisted" '^hello$' "$(state_get '.nodes[0].prompt')"
expect_match "dispatch pass-through args are persisted" '^\["--flag","value"\]$' "$(state_get -c '.nodes[0].dispatch_args')"
out=$(orch node dispatch disp-1 a claude-native "again" 2>&1); rc=$?
expect_match "re-dispatching a finished node is refused" 'is done, not waiting' "$out"
expect_exit "re-dispatch exits 2" 2 "$rc"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: node dispatch fixture test (python3 not found)\n' >&2
elif start_fixture 30; then
  job=$(LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" orch node dispatch disp-1 b "ping" 2>/dev/null); rc=$?
  expect_exit "node dispatch with the node's own profile exits 0" 0 "$rc"
  out=$(orch run sync disp-1 2>&1)
  expect_match "profile node is running mid-flight" '^b.running$' "$out"
  orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
  out=$(orch run sync disp-1 2>&1)
  expect_match "profile node is done after its job finishes" '^b.done$' "$out"
  expect_match "profile recorded on the dispatched node" '^local-llm-fast$' "$(state_get '.nodes[1].profile')"
  expect_match "model id recorded on the dispatched node" '^local-ornith-1.5-9b$' "$(state_get '.nodes[1].model_id')"
  expect_match "model slug recorded on the dispatched node" '^llama_swap/ornith-1.5-9b$' "$(state_get '.nodes[1].model')"
  expect_match "harness recorded as the node adapter" '^local-llm$' "$(state_get '.nodes[1].adapter')"
  stop_fixture
fi
cleanup_dir "$home"

# node/run retry: failed attempts are archived, runs reopen, prompts are reused, and the
# scheduler never retries forever.
home=$(new_tmp)
shims=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

retry_state="$home/runs/retry-1/state.json"
orch run start "Retry test" --id retry-1 >/dev/null 2>&1
orch node add retry-1 a "retry me" >/dev/null 2>&1
job=$(orch node dispatch retry-1 a claude-native "again" --same args 2>/dev/null)
orch wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
orch run sync retry-1 >/dev/null 2>&1
orch node update retry-1 a error --force --job "$job" --error "exit=1" >/dev/null 2>&1
orch run finish retry-1 >/dev/null 2>&1
out=$(orch node retry retry-1 a 2>&1); rc=$?
expect_exit "node retry exits 0" 0 "$rc"
expect_match "node retry prints a new job id" '^[0-9]' "$out"
expect_match "node retry reopens a finished run" '^running$' "$(jq -r '.status' "$retry_state")"
expect_match "node retry clears finished time" '^null$' "$(jq -r '.finished | tostring' "$retry_state")"
expect_match "node retry marks the node running" '^running$' "$(jq -r '.nodes[0].status' "$retry_state")"
expect_match "node retry archives the failed job" "^$job$" "$(jq -r '.nodes[0].attempts[0].job_id' "$retry_state")"
expect_match "node retry records restarted mode for non-resumable harnesses" '^restarted$' "$(jq -r '.nodes[0].attempts[0].retry_mode' "$retry_state")"
expect_match "node retry preserves pass-through args" '^\["--same","args"\]$' "$(jq -c '.nodes[0].dispatch_args' "$retry_state")"

orch wait "$out" --timeout 60 --interval 1 >/dev/null 2>&1
orch run sync retry-1 >/dev/null 2>&1
out=$(orch node retry retry-1 a 2>&1); rc=$?
expect_exit "node retry wrong state exits 2" 2 "$rc"
expect_match "node retry wrong state is clear" 'not error or skipped' "$out"
cleanup_dir "$home"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
orch run start "Old retry" --id retry-old >/dev/null 2>&1
orch node add retry-old a "a" >/dev/null 2>&1
edit_json "$home/runs/retry-old/state.json" '.nodes[0] += {status:"error", adapter:"claude-native", job_id:"old", error:"exit=1", finished:"2026-09-01T00:00:00Z"}'
out=$(orch node retry retry-old a --no-dispatch "@/tmp/old-prompt.md" 2>&1); rc=$?
expect_exit "node retry old node accepts prompt with no dispatch" 0 "$rc"
expect_match "node retry old node becomes waiting" '^waiting$' "$(jq -r '.nodes[0].status' "$home/runs/retry-old/state.json")"
expect_match "node retry old node stores supplied prompt" '^@/tmp/old-prompt.md$' "$(jq -r '.nodes[0].prompt' "$home/runs/retry-old/state.json")"
cleanup_dir "$home"

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


# --- prune / auto-prune ------------------------------------------------------
# A failing `trash` shim forces the .trash/ fallback so the test is deterministic on every machine.
home=$(new_tmp)
shims=$(new_tmp)
printf '#!/usr/bin/env bash\nexit 1\n' > "$shims/trash"
chmod +x "$shims/trash"
no_trash() { PATH="$shims:$PATH" orch "$@"; }

orch run start "live" --id live-1 >/dev/null 2>&1
orch run start "old" --id old-1 >/dev/null 2>&1
orch node add old-1 x "x" >/dev/null 2>&1
old_job=$(orch node dispatch old-1 x claude-native "hi" 2>/dev/null)
sleep 1
orch run sync old-1 >/dev/null 2>&1
orch run finish old-1 >/dev/null 2>&1
edit_json "$home/runs/old-1/state.json" '.finished = "2020-01-01T00:00:00Z"'

out=$(no_trash prune --dry-run 2>&1); rc=$?
expect_exit "prune --dry-run exits 0" 0 "$rc"
expect_match "dry-run lists the expired run" 'would prune: .*runs/old-1' "$out"
expect_match "dry-run lists the run's job" "would prune: .*jobs/$old_job" "$out"
expect_no_match "dry-run never touches the running run" 'live-1' "$out"
expect_file "dry-run leaves the state in place" "$home/runs/old-1/state.json"

out=$(no_trash prune 2>&1); rc=$?
expect_exit "prune exits 0" 0 "$rc"
expect_match "prune reports the run" 'pruned: .*runs/old-1' "$out"
expect_match "prune reports the count" '^pruned 1 run\(s\)' "$out"
expect_missing "run dir is gone" "$home/runs/old-1"
expect_missing "job dir is gone" "$home/jobs/$old_job"
expect_match "fallback moved the run under .trash" 'old-1' "$(find "$home/.trash" -maxdepth 2 -name 'old-1' 2>/dev/null)"
expect_match "fallback moved the job under .trash" "$old_job" "$(find "$home/.trash" -maxdepth 2 -name "$old_job" 2>/dev/null)"
expect_file "running run survives prune" "$home/runs/live-1/state.json"

out=$(orch prune --older-than xyz 2>&1); rc=$?
expect_match "bad --older-than is rejected" 'expects <N>d, <N>h or <N>' "$out"
expect_exit "bad --older-than exits 2" 2 "$rc"

orch run start "old2" --id old-2 >/dev/null 2>&1
orch run finish old-2 >/dev/null 2>&1
edit_json "$home/runs/old-2/state.json" '.finished = "2020-01-01T00:00:00Z"'
edit_json "$home/profiles.json" '.settings.retention_days = 1'
no_trash run start "trigger" --id trig-1 >/dev/null 2>&1
expect_missing "run start auto-prunes per settings.retention_days" "$home/runs/old-2"
expect_file "the new run itself is untouched" "$home/runs/trig-1/state.json"
cleanup_dir "$shims"
cleanup_dir "$home"



finish
