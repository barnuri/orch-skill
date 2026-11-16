#!/usr/bin/env bash
# dispatch.sh tests: demo seeding
# Run: bash demo-seeding.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init >/dev/null 2>&1

# --- demo seeding -----------------------------------------------------------------------------
# The demo exists so a reader can see the dashboard populated without spending a token, so the
# thing worth guarding is that it never reaches a harness and that reset removes exactly what
# seed created.
demo=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo 2>&1); rc=$?
expect_exit "demo with no verb exits 2" 2 "$rc"
expect_match "demo with no verb prints its grammar" 'demo seed' "$out"

# The default state dir is the user's real one; seeding fake runs into it takes --force.
out=$(env -u HARNESS_ORCH_HOME bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed refuses the default home" 2 "$rc"
expect_match "demo seed names the scratch-dir escape" 'HARNESS_ORCH_HOME' "$out"

env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" init >/dev/null 2>&1
# No harness CLI on PATH at all: if seeding tried to dispatch, it would fail loudly here.
out=$(env HARNESS_ORCH_HOME="$demo" PATH="$(path_without claude cursor-agent opencode)" \
  bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed exits 0 with no harness CLI present" 0 "$rc"
expect_match "demo seed reports what it seeded" 'seeded 4 runs' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo seeds a run in flight" 'running.*Ship the payments service' "$out"
expect_match "demo seeds a failed run" 'error.*Migrate the llm-hub profiles' "$out"
expect_match "demo seeds a finished run" 'done.*Nightly benchmark sweep' "$out"

state=$(cat "$demo"/runs/*/state.json | jq -s '.')
statuses=$(printf '%s' "$state" | jq -r '[.[].nodes[].status] | unique | join(",")')
expect_match "demo covers every node status" '^done,error,running,skipped,waiting$' "$statuses"
adapters=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select(.adapter != null) | .adapter] | unique | join(",")')
expect_match "demo covers more than one harness" 'claude,cursor-agent' "$adapters"
tails=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select((.log_tail | length) > 0)] | length')
expect_match "demo nodes carry a log tail" '^[1-9]' "$tails"

graph_demo=$(new_tmp)
env HARNESS_ORCH_HOME="$graph_demo" bash "$SCRIPT" init >/dev/null 2>&1
out=$(env HARNESS_ORCH_HOME="$graph_demo" PATH="$(path_without claude cursor-agent opencode copilot)" \
  bash "$SCRIPT" demo seed --graph 2>&1); rc=$?
expect_exit "demo seed --graph exits 0 with no harness CLI present" 0 "$rc"
expect_match "demo seed --graph names its run" 'seeded graph run' "$out"
graph_state=$(cat "$graph_demo"/runs/*/state.json)
expect_match "graph demo seeds one 13-node run" '^13$' "$(printf '%s' "$graph_state" | jq '.nodes | length')"
expect_match "graph demo covers every node status" '^done,error,running,skipped,waiting$' \
  "$(printf '%s' "$graph_state" | jq -r '[.nodes[].status] | unique | join(",")')"
expect_match "graph demo nodes carry a reported cost" '^3.12$' \
  "$(printf '%s' "$graph_state" | jq '.nodes[] | select(.id == "design") | .cost.usd')"
expect_match "graph demo records a retried attempt" '^1$' \
  "$(printf '%s' "$graph_state" | jq '.nodes[] | select(.id == "ui") | .attempts | length')"

# Every job dir a real dispatch would write, so the transcript view and `tail` work on demo data.
job_dir=$(ls -d "$demo"/jobs/demo-*/ 2>/dev/null | head -1)
expect_file "demo job has a full log" "$job_dir/log"
expect_file "demo job records its adapter" "$job_dir/adapter"
expect_file "demo job records a session id" "$job_dir/session"
session=$(cat "$job_dir/session" 2>/dev/null)
expect_match "demo session id is a uuid" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$session"

# A run the demo did not create must survive reset.
env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run start "a real run" --id 20260101-000000-keep >/dev/null 2>&1
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo advance 2>&1); rc=$?
expect_exit "demo advance exits 0" 0 "$rc"
expect_match "demo advance reports the node it moved" '	(done|running)$' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset removes the seeded runs" 'removed 4 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset is idempotent" 'removed 0 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo reset leaves a non-demo run alone" '20260101-000000-keep' "$out"
expect_missing "demo reset clears the demo job dirs" "$job_dir"
cleanup_dir "$demo"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" harness list --json 2>&1)
expect_match "harness list json includes claude" '"id": "claude"' "$out"
expect_match "harness list json includes local-llm" '"id": "local-llm"' "$out"
wired=$(printf '%s' "$out" | jq -r '.harnesses[] | select(.id=="claude") | .wired')
expect_match "harness list json marks adapters wired" '^true$' "$wired"
expect_match "harness list json includes detected pi" '"id": "pi"' "$out"
edit_json "$home/profiles.json" '.settings.disabled_harnesses = ["opencode"]'
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" harness list --json 2>&1)
enabled=$(printf '%s' "$out" | jq -r '.harnesses[] | select(.id=="opencode") | .enabled')
expect_match "disabled harness shows enabled false" '^false$' "$enabled"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show claude-llm-hub 2>&1)
expect_match "profile show keeps env refs unresolved" '\$\{LLM_HUB_URL\}' "$out"
expect_match "profile show keeps the model pin a reference" '"ANTHROPIC_DEFAULT_SONNET_MODEL": "\$\{PROFILE_MODEL\}"' "$out"
for p in claude-llm-hub-planner copilot-llm-hub opencode-llm-hub pi-llm-hub; do
  out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show "$p" 2>&1)
  expect_match "profile show $p keeps env refs unresolved" '\$\{(LLM_HUB_URL|LLM_HUB_V1_URL|LLM_HUB_KEY|PROFILE_MODEL)\}|\{env:LLM_HUB_V1_URL\}' "$out"
done
out=$(env -u LLM_HUB_V1_URL HARNESS_ORCH_HOME="$home" LLM_HUB_URL=http://hub:9 LLM_HUB_KEY=dummy \
  bash -c ". '$SCRIPT'; profile_load claude-llm-hub && printf '%s %s\n' \"\$ANTHROPIC_DEFAULT_SONNET_MODEL\" \"\$ANTHROPIC_BASE_URL\"" 2>&1)
expect_match "claude-llm-hub pins every model tier to its hub model" '^llama_swap/qwen3.6-35b http://hub:9$' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show nope 2>&1); rc=$?
expect_match "unknown profile lists the available ones" 'claude-llm-hub' "$out"
expect_exit "unknown profile exits 2" 2 "$rc"

# init is idempotent: a user-edited profiles.json is never overwritten.
edit_json "$home/profiles.json" '.settings.default_profile = "custom"'
env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init >/dev/null 2>&1
out=$(jq -r '.settings.default_profile' "$home/profiles.json")
expect_match "second init keeps user edits" '^custom$' "$out"

# Leftovers from the retired file:// dashboard are recoverably removed on init.
mkdir -p "$home/data"
: > "$home/index.html"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init 2>&1 >/dev/null)
expect_match "init reports legacy index.html cleanup" 'moved legacy dashboard leftover index.html' "$out"
expect_match "init reports legacy data cleanup" 'moved legacy dashboard leftover data' "$out"
expect_missing "init removes legacy index.html" "$home/index.html"
expect_missing "init removes legacy data dir" "$home/data"

# profile_load failure modes, driven by sourcing the script as a library.
load_profile() {
  env -u LLM_HUB_URL -u LLM_HUB_KEY -u CURSOR_API_KEY HARNESS_ORCH_HOME="$home" \
    bash -c ". '$SCRIPT'; profile_load '$1'" 2>&1
}
out=$(load_profile claude-llm-hub); rc=$?
expect_match "unset env ref is named" 'env ANTHROPIC_BASE_URL references unset \$\{LLM_HUB_URL\}' "$out"
expect_exit "unset env ref exits 3 (not configured, not broken)" 3 "$rc"

# cursor-agent authenticates through its own login, so the shipped cursor profile declares no
# auth. Asserting the auth path needs a profile that actually requires something.
edit_json "$home/profiles.json" '.profiles["needs-auth"] = {harness: "cursor-agent", model: "cursor-auto", flags: [], env: {}, auth: ["CURSOR_API_KEY"]}'
out=$(load_profile needs-auth); rc=$?
expect_match "missing auth var is named" 'required auth env var CURSOR_API_KEY is not set' "$out"
expect_exit "missing auth var exits 3 (not configured, not broken)" 3 "$rc"
out=$(load_profile cursor-default); rc=$?
expect_exit "the shipped cursor profile needs no auth env var" 0 "$rc"
edit_json "$home/profiles.json" 'del(.profiles["needs-auth"])' 
out=$(load_profile bogus); rc=$?
expect_exit "unknown profile in profile_load exits 2" 2 "$rc"
out=$(load_profile claude-default); rc=$?
expect_exit "profile with no env/auth loads cleanly" 0 "$rc"

# budget threshold: settings value is honoured, env still wins.
snapshot="$home/over80.json"
write_snapshot "$snapshot" "$(subscription_snapshot '{"day":{"used_percentage":82}}')"
edit_json "$home/profiles.json" '.settings.budget_threshold = 80'
out=$(env HARNESS_ORCH_HOME="$home" CLAUDE_USAGE_SNAPSHOT="$snapshot" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_exit "settings.budget_threshold=80 trips at 82%" 1 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" CLAUDE_USAGE_SNAPSHOT="$snapshot" HARNESS_ORCH_BUDGET_THRESHOLD=90 bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_exit "env threshold overrides settings" 0 "$rc"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile claude-default --outcome success --kind refactor --note "fast and clean" 2>&1); rc=$?
expect_exit "memory add exits 0" 0 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory list 2>&1)
expect_match "memory list round-trips the entry" 'claude-default.success.refactor.fast and clean' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory list --profile nope 2>&1)
expect_no_match "memory list filters by profile" 'claude-default' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile nope --outcome success 2>&1); rc=$?
expect_exit "memory add rejects unknown profile" 2 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile claude-default --outcome meh 2>&1); rc=$?
expect_match "memory add rejects bad outcome" 'outcome must be one of' "$out"
expect_exit "memory add bad outcome exits 2" 2 "$rc"
cleanup_dir "$home"


finish
