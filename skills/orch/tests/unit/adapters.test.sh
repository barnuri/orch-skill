#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals set here are read by the sourced dispatch libs
# Fast-tier unit tests for lib/adapters/adapters.sh: prompt files, Smart Auto headers, the usage
# sidecar, tier models and dispatch_with_profile against a fake opencode CLI.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

# Hand-built profiles.json shared by the adapters/config unit tests. The migration marker is
# re-pinned so ensure_home does not run the (slow) migrations over the fixture.
write_profiles_fixture() {
  cat > "$PROFILES_FILE" <<'JSON'
{
  "settings": {"default_profile": "p-claude", "disabled_harnesses": ["copilot"]},
  "models": {
    "m-sonnet": {"slug": "sonnet", "harnesses": ["claude"], "behaves_as": "sonnet"},
    "m-opus":   {"slug": "opus", "harnesses": ["claude"]},
    "m-gw":     {"slug": "gw/lfm", "harnesses": ["claude", "opencode"], "behaves_as": "haiku"},
    "m-oc":     {"slug": "oc/model", "harnesses": ["opencode"]}
  },
  "profiles": {
    "p-claude": {"harness": "claude", "model": "m-sonnet", "flags": ["--x", "--y"],
                 "env": {"ORCH_T_LIT": "plain", "ORCH_T_REF": "${ORCH_T_SRC}"}, "priority": 9},
    "p-allow":  {"harness": "claude", "model": "opus", "allowed_models": ["m-op*", "gw/*"]},
    "p-oc":     {"harness": "opencode", "model": "oc/model", "cost": "free", "max_complexity": "small"},
    "p-cop":    {"harness": "copilot"},
    "p-bad":    {"harness": "nope"},
    "p-auth":   {"harness": "claude", "auth": ["ORCH_T_TOKEN"]},
    "p-off":    {"harness": "claude", "enabled": false}
  }
}
JSON
  mkdir -p "$ORCH_HOME/.migrations"
  profiles_migration_sig > "$ORCH_HOME/.migrations/profiles-main"
}
write_profiles_fixture
unset ORCH_RUN_ID ORCH_NODE_ID ORCH_NODE_ATTEMPT ORCH_NODE_ROLE ORCH_NODE_TIER ORCH_NODE_ACCEPTANCE \
  ORCH_RESUME_SESSION ORCH_SESSION_TITLE OPENCODE_CONFIG_CONTENT ANTHROPIC_CUSTOM_HEADERS ORCH_MODEL_ID
ORCH_ENV_FILE_LOADED=1
tmp=$(dirname "$H")

printf 'from a file' > "$tmp/prompt.txt"
expect_match "resolve_prompt passes a literal through" '^plain words$' "$(resolve_prompt 'plain words')"
expect_match "resolve_prompt reads an @file" '^from a file$' "$(resolve_prompt "@$tmp/prompt.txt")"
out=$(resolve_prompt "@$tmp/none.txt" 2>&1); rc=$?
expect_exit "a missing @file fails 1" 1 "$rc"
expect_match "the missing file is named" 'prompt file not found' "$out"
out=$(adapter_dispatch nope hi 2>&1); rc=$?
expect_exit "adapter_dispatch refuses an unknown adapter" 2 "$rc"
expect_match "claude-native spawns nothing" 'no subprocess spawned' "$(adapter_dispatch claude-native hi)"

expect_match "hub_tier_model swaps the tier of a smart-auto model" '^hub/smart-auto-fast hub/smart-auto-balance other/m hub/smart-auto$' \
  "$(printf '%s ' "$(hub_tier_model hub/smart-auto-intelligence fast)" "$(hub_tier_model hub/smart-auto balance)" \
     "$(hub_tier_model other/m fast)" "$(hub_tier_model hub/smart-auto '')" | sed 's/ $//')"

expect_empty "a plain node sends no Smart Auto headers" "$(ORCH_RUN_ID=r ORCH_NODE_ID=n ORCH_NODE_ATTEMPT=1 claude_smart_auto_headers)"
out=$(ANTHROPIC_CUSTOM_HEADERS=$'x-keep: 1\nX-LLM-HUB-SMART-AUTO-WORKER: old/x/1' \
  ORCH_RUN_ID=r ORCH_NODE_ID=n ORCH_NODE_ATTEMPT=2 ORCH_NODE_TIER=fast claude_custom_headers)
expect_match "custom headers keep inherited lines, drop stale Smart Auto ones, add this attempt's" \
  $'^x-keep: 1\nx-llm-hub-smart-auto-worker: r/n/2\nx-llm-hub-smart-auto-parent: r\nx-llm-hub-smart-auto-tier: fast$' "$out"

mkdir -p "$tmp/job"
ORCH_JOB_DIR="$tmp/job" claude_write_usage '{"total_cost_usd":0.5,"usage":{"input_tokens":7},"modelUsage":{"m":{"costUSD":0.5,"costBasis":"api"}}}'
expect_match "the usage sidecar defaults missing fields and keeps per-model cost" \
  '^0.5 api 7 0 m$' "$(jq -r '"\(.usd) \(.cost_basis) \(.input_tokens) \(.output_tokens) \(.models[0].model)"' "$tmp/job/usage.json")"

mkdir -p "$tmp/bin"
printf '#!/bin/sh\nprintf "%%s|" "$@"; printf "cfg=%%s" "$OPENCODE_CONFIG_CONTENT"\n' > "$tmp/bin/opencode"
chmod +x "$tmp/bin/opencode"
PATH="$tmp/bin:$PATH"
out=$(OPENCODE_CONFIG_CONTENT='{"provider":{"hub":{}}}' ORCH_RUN_ID=r ORCH_NODE_ID=n ORCH_NODE_ATTEMPT=1 ORCH_NODE_ROLE=planning \
  dispatch_with_profile p-oc "do it" --pure --extra)
expect_match "opencode runs with -m <slug> and --standalone, dropping --pure" \
  '^run\|do it\|--auto\|--standalone\|-m\|oc/model\|--extra\|' "$out"
expect_match "the hub provider gets this node's Smart Auto headers" \
  '"x-llm-hub-smart-auto-worker":"r/n/1".*"x-llm-hub-smart-auto-role":"planning"' "$out"

cleanup_dir "$(dirname "$H")"
finish
