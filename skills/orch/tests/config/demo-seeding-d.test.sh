#!/usr/bin/env bash
# dispatch.sh tests: demo seeding, part d: init keeps user edits and moves legacy leftovers, profile_load failure modes, budget threshold, memory.
# Run: bash demo-seeding-d.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
seed_home "$home"

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
