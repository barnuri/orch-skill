#!/usr/bin/env bash
# dispatch.sh tests: delegation state (plan, task list, findings) on a run
# Run: bash delegate.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

# Strong planner (quality high) and a cheaper implementer (quality standard).
edit_json "$home/profiles.json" '.profiles["claude-default"].quality = "high"
  | .profiles["local-llm-fast"].quality = "standard"'
orch run start "Delegated" --id del-1 >/dev/null 2>&1
state="$home/runs/del-1/state.json"

out=$(orch delegate del-1 show 2>&1)
expect_match "show on a fresh run prints no plan" '^plan:$' "$out"
expect_match "show lists no tasks" '^  \(none\)$' "$out"
expect_match "show --json starts with empty tasks" '"tasks":\[\]' "$(orch delegate del-1 show --json 2>&1)"

out=$(orch delegate del-1 plan "Split the auth refactor into three parts" 2>&1)
expect_match "plan is stored" '^plan stored$' "$out"
expect_match "plan is in run state" '^Split the auth refactor' "$(jq -r '.delegation.plan' "$state")"

printf 'Plan from file' > "$home/plan.md"
orch delegate del-1 plan "@$home/plan.md" >/dev/null 2>&1
expect_match "plan @file replaces the stored plan" '^Plan from file$' "$(jq -r '.delegation.plan' "$state")"
out=$(orch delegate del-1 plan "@$home/missing.md" 2>&1); rc=$?
expect_exit "plan @file refuses a missing file" 2 "$rc"

out=$(orch delegate del-1 task add plan-1 --stage plan --profile claude-default --label "Plan it" 2>&1)
expect_match "strong profile takes the plan stage" '^task plan-1 added$' "$out"
orch delegate del-1 task add impl-1 --stage implement --profile local-llm-fast --label "Build it" >/dev/null 2>&1
orch delegate del-1 task add rev-1 --stage review --profile claude-default >/dev/null 2>&1
orch delegate del-1 task add fix-1 --stage fix --profile local-llm-fast >/dev/null 2>&1
expect_match "task list keeps stage, profile and status" \
  '^  impl-1\timplement\tlocal-llm-fast\ttodo\tBuild it$' "$(orch delegate del-1 show 2>&1)"

out=$(orch delegate del-1 task add bad-1 --stage plan --profile local-llm-fast 2>&1); rc=$?
expect_exit "a cheap profile is refused for the plan stage" 2 "$rc"
expect_match "the refusal names the quality rule" 'stage plan needs a strong profile' "$out"
out=$(orch delegate del-1 task add bad-2 --stage implement --profile claude-default 2>&1); rc=$?
expect_exit "a strong profile is refused for the implement stage" 2 "$rc"
expect_match "the implement refusal names the cheap rule" 'stage implement needs a cheap profile' "$out"
out=$(orch delegate del-1 task add bad-3 --stage review --profile local-llm-fast 2>&1); rc=$?
expect_exit "a cheap profile is refused for the review stage" 2 "$rc"
out=$(orch delegate del-1 task add bad-4 --stage build --profile claude-default 2>&1); rc=$?
expect_exit "an unknown stage is refused" 2 "$rc"
out=$(orch delegate del-1 task add bad-5 --stage implement --profile no-such 2>&1); rc=$?
expect_match "an unknown profile is named" 'unknown profile no-such' "$out"
out=$(orch delegate del-1 task add impl-1 --stage implement --profile local-llm-fast 2>&1); rc=$?
expect_match "a duplicate task id is refused" 'task impl-1 already exists' "$out"
expect_match "refused tasks add nothing" '^4$' "$(jq '.delegation.tasks | length' "$state")"

expect_match "task set marks a task done" '^task impl-1 done$' "$(orch delegate del-1 task set impl-1 done 2>&1)"
expect_match "task status is stored" '^done$' "$(jq -r '.delegation.tasks[] | select(.id == "impl-1") | .status' "$state")"
out=$(orch delegate del-1 task set impl-1 finished 2>&1); rc=$?
expect_exit "an unknown task status is refused" 2 "$rc"
out=$(orch delegate del-1 task set nope todo 2>&1); rc=$?
expect_match "an unknown task is named" 'unknown task nope' "$out"

finding=$(orch delegate del-1 finding add rev-1 "Token is logged in plain text" 2>&1)
expect_match "a finding gets the next F id" '^F1$' "$finding"
orch delegate del-1 finding add rev-1 "Missing timeout on the refresh call" >/dev/null 2>&1
expect_match "show lists open findings" '^  F1\trev-1\tToken is logged in plain text$' "$(orch delegate del-1 show 2>&1)"
expect_match "open findings are counted" '^open findings: 2$' "$(orch delegate del-1 show 2>&1)"
expect_match "a finding closes" '^finding F1 closed$' "$(orch delegate del-1 finding close F1 2>&1)"
expect_match "a closed finding leaves the open list" '^open findings: 1$' "$(orch delegate del-1 show 2>&1)"
out=$(orch delegate del-1 finding add nope "x" 2>&1); rc=$?
expect_match "a finding on an unknown task is refused" 'unknown task nope' "$out"
out=$(orch delegate del-1 finding close F9 2>&1); rc=$?
expect_match "closing an unknown finding is refused" 'unknown finding F9' "$out"

out=$(orch delegate nope-run show 2>&1); rc=$?
expect_exit "an unknown run is refused" 2 "$rc"
out=$(orch delegate del-1 2>&1); rc=$?
expect_exit "a missing subcommand prints usage" 2 "$rc"

cleanup_dir "$home"

finish
