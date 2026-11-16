#!/usr/bin/env bash
# dispatch.sh tests: run and node lifecycle, node add options (split from run-lifecycle.test.sh)
# Run: bash run-lifecycle-a.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- run / node lifecycle -----------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"
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
cleanup_dir "$home"

finish
