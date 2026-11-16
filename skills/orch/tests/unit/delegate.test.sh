#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/delegate.sh: profile classes, the stage/profile rule, task and
# finding state, called in-process on a fixture run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
printf '%s\n' '{"run_id":"r1","title":"Demo","status":"running","nodes":[],"edges":[]}' > "$H/runs/r1/state.json"
F="$H/runs/r1/state.json"

# --- delegate_profile_class: quality best/high is strong, anything else cheap, unknown fails
expect_match "a best-quality profile is strong" '^strong$' "$(delegate_profile_class claude-opus)"
expect_match "a standard profile is cheap" '^cheap$' "$(delegate_profile_class claude-default)"
delegate_profile_class nope >/dev/null; rc=$?
expect_exit "an unknown profile has no class" 1 "$rc"

# --- arg errors
out=$(cmd_delegate r1 2>&1); rc=$?
expect_exit "delegate with no subcommand is a usage error" 2 "$rc"
out=$(cmd_delegate r1 plan 2>&1); rc=$?
expect_exit "delegate plan with no text is a usage error" 2 "$rc"
out=$(cmd_delegate r1 plan @/nonexistent/plan.md 2>&1); rc=$?
expect_exit "delegate plan @file needs the file" 2 "$rc"

# --- stage/profile rule
out=$(cmd_delegate r1 task add t1 --stage review --profile claude-default 2>&1); rc=$?
expect_exit "review on a cheap profile is refused" 2 "$rc"
expect_match "the refusal names the needed class" 'needs a strong profile' "$out"
out=$(cmd_delegate r1 task add t1 --stage deploy --profile claude-default 2>&1); rc=$?
expect_exit "an unknown stage is refused" 2 "$rc"
cmd_delegate r1 task add t1 --stage implement --profile claude-default --label "Build it" >/dev/null; rc=$?
expect_exit "implement on a cheap profile is accepted" 0 "$rc"

# --- task status, findings, show
cmd_delegate r1 task set t1 doing >/dev/null
out=$(cmd_delegate r1 task set t1 finished 2>&1); rc=$?
expect_exit "an unknown task status is refused" 2 "$rc"
expect_match "a finding gets the next F id" '^F1$' "$(cmd_delegate r1 finding add t1 "missing test")"
cmd_delegate r1 plan "Do the thing" >/dev/null
out=$(cmd_delegate r1 show --json)
expect_match "show --json has the plan, the task status and the open finding" \
  '^Do the thing doing Build it open$' "$(printf '%s' "$out" | jq -r '"\(.plan) \(.tasks[0].status) \(.tasks[0].label) \(.findings[0].status)"')"
cmd_delegate r1 finding close F1 >/dev/null
expect_match "show counts no open findings once closed" 'open findings: 0' "$(cmd_delegate r1 show)"

cleanup_dir "$(dirname "$H")"
finish
