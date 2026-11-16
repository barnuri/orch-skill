#!/usr/bin/env bash
# dispatch.sh tests: demo seeding, part c: harness list, profile show.
# Run: bash demo-seeding-c.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
seed_home "$home"

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
cleanup_dir "$home"

finish
