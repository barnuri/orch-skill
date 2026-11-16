#!/usr/bin/env bash
# dispatch.ts tests: planned runs, plan apply, advance, mailbox
# Run: bash planned-runs.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- planned runs: plan, plan apply, run advance, max_parallel, mailbox ------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" "$@"; }
seed_home "$home"

# With Claude Code disabled, pick never lands on a claude profile.
edit_json "$home/profiles.json" '.settings.disabled_harnesses = ["claude"]'
out=$(orch profile pick "refactor the whole auth layer across services" --complexity large 2>&1)
expect_no_match "profile pick skips profiles on a disabled harness" '^profile=claude' "$out"
edit_json "$home/profiles.json" '.settings.disabled_harnesses = []'

# A flag written as one string is split into separate argv entries on the next load.
edit_json "$home/profiles.json" '.profiles["copilot-default"].flags = ["--yolo --no-ask-user", "--autopilot"]'
orch profile list >/dev/null 2>&1
expect_match "joined flag strings are split into argv entries" '^\["--yolo","--no-ask-user","--autopilot"\]$' \
  "$(jq -c '.profiles["copilot-default"].flags' "$home/profiles.json")"

# The planner prompt names the goal, the limits and the profile menu; `plan apply` validates.
edit_json "$home/profiles.json" '.settings.disabled_harnesses = ["claude","opencode","cursor-agent"]
  | .profiles["local-llm-fast"].enabled = true | .settings.default_profile = "local-llm-fast"
  | .settings.planner_profile = "local-llm-fast" | .defaults.max_parallel = 2 | .settings.max_nodes = 5'
state="$home/runs/plan-1/state.json"
orch run start "Planned" --id plan-1 >/dev/null 2>&1
# A closed port: the planner job fails at once, and the test marks the node done by hand.
LLM_HUB_URL=http://127.0.0.1:9 orch plan plan-1 "Ship the widget" >/dev/null 2>&1; rc=$?
expect_exit "plan dispatches the planner node" 0 "$rc"
expect_match "plan records the planner node on the run" '^plan\tlocal-llm-fast$' "$(jq -r '"\(.plan.node)\t\(.plan.profile)"' "$state")"
prompt="$home/runs/plan-1/prompts/plan.md"
expect_match "planner prompt carries the goal" 'Ship the widget' "$(cat "$prompt")"
expect_match "planner prompt carries the limits" 'At most 5 tasks. At most 2 run at the same time' "$(cat "$prompt")"
expect_match "planner prompt lists enabled profiles" '^- local-llm-fast \(default\)' "$(cat "$prompt")"
expect_no_match "planner prompt hides disabled harnesses" '^- claude-default' "$(cat "$prompt")"
orch node update plan-1 plan "done" >/dev/null 2>&1

plan_out="$home/runs/plan-1/out/plan"
printf '%s' '{"tasks":[{"id":"a","prompt":"x","after":["b"]},{"id":"b","prompt":"y","after":["a"]}]}' > "$plan_out/bad.json"
out=$(orch plan apply plan-1 --file "$plan_out/bad.json" 2>&1); rc=$?
expect_exit "a cyclic plan is refused" 2 "$rc"
expect_match "the cycle is named" 'dependency cycle among: a, b' "$out"
printf '%s' '{"tasks":[{"id":"a","prompt":"x","after":["zz"]},{"id":"plan","prompt":"y"},{"id":"c"}]}' > "$plan_out/bad.json"
out=$(orch plan apply plan-1 --file "$plan_out/bad.json" 2>&1); rc=$?
expect_match "an unknown dependency is named" 'task a depends on unknown task zz' "$out"
expect_match "a colliding id is named" 'task id plan collides with an existing node' "$out"
expect_match "a task without a prompt is named" 'task c has no prompt' "$out"
printf '%s' '{"tasks":[{"id":"a","prompt":"x"},{"id":"b","prompt":"x"},{"id":"c","prompt":"x"},{"id":"d","prompt":"x"},{"id":"e","prompt":"x"},{"id":"f","prompt":"x"}]}' > "$plan_out/bad.json"
out=$(orch plan apply plan-1 --file "$plan_out/bad.json" 2>&1)
expect_match "settings.max_nodes caps the plan" 'plan has 6 tasks; settings.max_nodes is 5' "$out"
expect_match "a refused plan adds no nodes" '^1$' "$(jq '.nodes | length' "$state")"

printf '%s' '{"summary":"three then merge","tasks":[
  {"id":"a","label":"Part A","prompt":"do A"},
  {"id":"b","label":"Part B","profile":"claude-default","prompt":"do B"},
  {"id":"c","label":"Part C","prompt":"do C"},
  {"id":"merge","label":"Integrate","after":["a","b","c"],"prompt":"merge them"}]}' > "$plan_out/plan.json"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: run advance fixture test (python3 not found)\n' >&2
elif start_fixture 1 forever; then
  out=$(LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" orch run advance plan-1 2>&1); rc=$?
  expect_exit "run advance exits 0" 0 "$rc"
  expect_match "advance applies the finished plan" 'applied: 4 task\(s\)' "$out"
  expect_match "advance reports the stages" 'stages: a\+b\+c -> merge' "$out"
  expect_match "a disabled profile falls back to the default" 'profile claude-default is disabled, using local-llm-fast' "$out"
  expect_match "max_parallel caps the first dispatch" '^dispatched: a,b$' "$out"
  expect_match "the rest of the stage is queued" '^queued: c$' "$out"
  expect_match "root tasks hang off the planner node" '\["plan","a"\]' "$(jq -c '.edges' "$state")"
  expect_match "the merge task waits on every branch" '\["c","merge"\]' "$(jq -c '.edges' "$state")"
  expect_match "the plan is marked applied" '^4$' "$(jq -r '.plan.tasks' "$state")"
  task_prompt=$(cat "$home/runs/plan-1/prompts/merge.md")
  expect_match "a task prompt starts with the planner's instructions" '^merge them' "$task_prompt"
  expect_match "a task prompt points at its dependencies' handoffs" 'out/a, .*out/b, .*out/c' "$task_prompt"
  expect_match "a task prompt explains the mailbox" 'msg send plan-1 --to orch' "$task_prompt"
  out=$(orch run sync plan-1 2>&1)
  # The fixture answers after 1 s, so a job may already be done here; assert the invariant.
  running_now=$(printf '%s\n' "$out" | grep -c $'\trunning$')
  expect_match "run sync reports free slots as max_parallel minus running" \
    "^slots: $((2 - running_now))$" "$out"

  out=$(LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" orch run advance plan-1 --until-done --interval 1 --timeout 60 2>&1); rc=$?
  expect_exit "run advance --until-done exits 0" 0 "$rc"
  expect_match "advance finishes the run" '^finished: done$' "$out"
  expect_match "every task ran" '^done done done done done$' "$(jq -r '[.nodes[].status] | join(" ")' "$state")"
  expect_match "dispatched nodes learn the CLI path" 'ORCH_DISPATCH' "$(cat "$home/runs/plan-1/prompts/a.md")"
  stop_fixture
fi

out=$(orch plan apply plan-1 2>&1); rc=$?
expect_exit "a plan applies once" 2 "$rc"

# The mailbox: a node's sender defaults from its env; a reader sees what is addressed to it.
out=$(ORCH_RUN_ID=plan-1 ORCH_NODE_ID=a orch msg send plan-1 --to orch "need the schema" 2>&1); rc=$?
expect_exit "msg send exits 0" 0 "$rc"
orch msg send plan-1 --to all "heads up: API renamed" >/dev/null 2>&1
orch msg send plan-1 --to b "only for b" >/dev/null 2>&1
out=$(orch msg read plan-1 2>&1)
expect_match "the coordinator reads messages sent to orch" '^1	.*	a -> orch	need the schema$' "$out"
expect_no_match "the coordinator does not read its own broadcast" 'heads up' "$out"
out=$(ORCH_RUN_ID=plan-1 ORCH_NODE_ID=c orch msg read plan-1 2>&1)
expect_match "a node reads broadcasts" 'orch -> all	heads up: API renamed' "$out"
expect_no_match "a node does not read another node's mail" 'only for b' "$out"
out=$(orch msg read plan-1 --for b --since 2 2>&1)
expect_match "--since skips older messages" '^3	.*only for b$' "$out"
out=$(orch msg send plan-1 --to nobody "x" 2>&1); rc=$?
expect_exit "msg send to an unknown node exits 2" 2 "$rc"
cleanup_dir "$home"
cleanup_dir "$fixture_dir"


finish
