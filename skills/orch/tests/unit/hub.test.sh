#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals set here are read by the sourced dispatch libs
# Fast-tier unit tests for lib/adapters/hub.sh: hub mode, role tiers, settings writes and the
# argument errors. No hub is contacted: LLM_HUB_URL stays unset.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

unset LLM_HUB_URL LLM_HUB_KEY
ORCH_ENV_FILE_LOADED=1
pin() { mkdir -p "$H/.migrations" && profiles_migration_sig > "$H/.migrations/profiles-main"; }

edit_json "$PROFILES_FILE" '.settings.llm_hub = {mode: "off"}'; pin
hub_mode_on; expect_exit "hub mode is off unless mode is smart-auto" 1 "$?"
expect_match "the hub profile defaults to opencode" '^opencode-smart-auto$' "$(hub_profile)"
expect_match "an unset role uses the default tier" '^intelligence fast$' \
  "$(printf '%s %s' "$(hub_role_tier planning)" "$(hub_role_tier conversation)")"
expect_empty "an empty role has no tier" "$(hub_role_tier '')"

edit_json "$PROFILES_FILE" '.settings.llm_hub = {mode: "smart-auto", harness: "claude",
  role_tiers: {planning: "fast", validation: "turbo"}}'; pin
hub_mode_on; expect_exit "mode smart-auto turns hub mode on" 0 "$?"
expect_match "the hub profile follows the configured harness" '^claude-smart-auto$' "$(hub_profile)"
expect_match "a configured tier wins, a non-tier value falls back to the default" '^fast efficiency$' \
  "$(printf '%s %s' "$(hub_role_tier planning)" "$(hub_role_tier validation)")"

out=$(hub_api GET /healthz 2>&1); rc=$?
expect_exit "hub_api without LLM_HUB_URL fails 2" 2 "$rc"
out=$(cmd_hub resolve turbo 2>&1); rc=$?
expect_exit "hub resolve refuses an unknown tier" 2 "$rc"
expect_match "the valid tiers are listed" 'tier must be one of: efficiency balance intelligence fast' "$out"
out=$(cmd_hub bogus 2>&1); rc=$?
expect_exit "hub with an unknown subcommand fails 2" 2 "$rc"
out=$(hub_setup --harness cursor-agent 2>&1); rc=$?
expect_exit "hub setup refuses a harness the hub cannot drive" 2 "$rc"
out=$(hub_setup 2>&1); rc=$?
expect_exit "hub setup without LLM_HUB_URL fails 2" 2 "$rc"
expect_match "hub setup says where to set the URL" "set LLM_HUB_URL .* in $H/env" "$out"

out=$(cmd_hub off); rc=$?
expect_exit "hub off succeeds" 0 "$rc"
expect_match "hub off writes mode off and keeps the rest" '^off claude fast$' \
  "$(jq -r '.settings.llm_hub | "\(.mode) \(.harness) \(.role_tiers.planning)"' "$PROFILES_FILE")"
expect_match "hub status reports the mode and the missing URL" $'^mode: off\nharness: claude.*\nhub: LLM_HUB_URL not set$' \
  "$(printf '%s' "$out" | paste -sd'\n' -)"

cleanup_dir "$(dirname "$H")"
finish
