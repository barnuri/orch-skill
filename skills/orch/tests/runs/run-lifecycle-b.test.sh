#!/usr/bin/env bash
# dispatch.sh tests: node dispatch, prune / auto-prune (split from run-lifecycle.test.sh)
# Run: bash run-lifecycle-b.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- node dispatch -------------------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
state_get() { jq -r "$@" "$state"; }
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

# --- prune / auto-prune ------------------------------------------------------
# A failing `trash` shim forces the .trash/ fallback so the test is deterministic on every machine.
home=$(new_tmp)
shims=$(new_tmp)
printf '#!/usr/bin/env bash\nexit 1\n' > "$shims/trash"
chmod +x "$shims/trash"
# Same orch as the retry sections of the original file: fallback shims first on PATH, a dead hub.
orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" LLM_HUB_URL=http://127.0.0.1:1 LLM_HUB_KEY=dummy bash "$SCRIPT" "$@"; }
seed_home "$home"
no_trash() { PATH="$shims:$PATH" orch "$@"; }

orch run start "live" --id live-1 >/dev/null 2>&1
orch run start "old" --id old-1 >/dev/null 2>&1
orch node add old-1 x "x" >/dev/null 2>&1
old_job=$(orch node dispatch old-1 x claude-native "hi" 2>/dev/null)
wait_until "[ -f \"$home/jobs/$old_job/exit_code\" ]" 60
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
