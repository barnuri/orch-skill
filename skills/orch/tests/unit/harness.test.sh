#!/usr/bin/env bash
# Fast-tier unit tests for lib/adapters/harness.sh: binary lookup, probes and `harness list`, with
# fake CLIs in a temp dir and the real ones hidden from PATH.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

edit_json "$PROFILES_FILE" '.settings.disabled_harnesses = ["cursor-agent"]'
mkdir -p "$H/.migrations" && profiles_migration_sig > "$H/.migrations/profiles-main"
bin="$(dirname "$H")/bin"
mkdir -p "$bin"
printf '#!/bin/sh\nexit 0\n' > "$bin/opencode" && chmod +x "$bin/opencode"
PATH=$(path_without claude cursor-agent opencode copilot pi codex aider gemini)
unset LLM_HUB_URL

expect_match "harness_ids lists every wired harness" '^claude cursor-agent opencode local-llm copilot pi$' \
  "$(harness_ids | paste -sd' ' -)"
expect_match "ORCH_BIN_DIRS replaces the default search dirs" '^/a /b$' \
  "$(ORCH_BIN_DIRS=/a:/b harness_bin_dirs | paste -sd' ' -)"

export ORCH_BIN_DIRS="/nonexistent:$bin"
expect_match "a CLI off PATH is found in the extra dirs" "^$bin/opencode\$" "$(harness_find_binary opencode)"
harness_find_binary claude >/dev/null; rc=$?
expect_exit "a missing CLI is not found" 1 "$rc"

harness_probe_available opencode; expect_exit "opencode is available through the extra dir" 0 "$?"
harness_probe_available local-llm; expect_exit "local-llm needs LLM_HUB_URL" 1 "$?"
LLM_HUB_URL=http://hub harness_probe_available local-llm; expect_exit "local-llm with LLM_HUB_URL is available" 0 "$?"
harness_probe_available bogus; expect_exit "an unknown harness is never available" 1 "$?"
expect_match "a missing claude gets an install hint" 'install the claude CLI' "$(harness_probe_reason claude)"
expect_empty "an available harness has no reason" "$(harness_probe_reason opencode)"
expect_match "an unknown harness says so" '^unknown harness$' "$(harness_probe_reason bogus)"

out=$(cmd_harness 2>&1); rc=$?
expect_exit "harness with no subcommand prints usage and fails 2" 2 "$rc"
out=$(harness_list --yaml 2>&1); rc=$?
expect_exit "harness list refuses an unknown flag" 2 "$rc"

out=$(harness_list --json); rc=$?
expect_exit "harness list --json succeeds" 0 "$rc"
expect_match "the list covers wired and detected CLIs" '^claude cursor-agent opencode local-llm copilot pi codex aider gemini$' \
  "$(printf '%s' "$out" | jq -r '[.harnesses[].id] | join(" ")')"
expect_match "availability, enablement and reasons come from probes and settings" \
  '^true:true: false:false:install cursor-agent false:true:install the codex' \
  "$(printf '%s' "$out" | jq -r '.harnesses | map({(.id): "\(.available):\(.enabled):\(.reason | .[0:20])"}) | add
     | "\(.opencode) \(.["cursor-agent"]) \(.codex)"')"

cleanup_dir "$(dirname "$H")"
finish
