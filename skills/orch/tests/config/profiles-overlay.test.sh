#!/usr/bin/env bash
# dispatch.ts tests: profiles template + gitignored overlay (templates/profiles.local.json)
# Run: bash profiles-overlay.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

TEMPLATE="$SCRIPT_DIR/../templates/profiles.json"
REAL_OVERLAY="$SCRIPT_DIR/../templates/profiles.local.json"

# --- template only: no overlay file -------------------------------------------
home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$home" ORCH_PROFILES_OVERLAY="$home/no-overlay.json" bun "$SCRIPT" init 2>&1); rc=$?
expect_exit "template-only init exits 0" 0 "$rc"
expect_match "template-only home has the eight generic profiles" '^8$' \
  "$(jq '.profiles | length' "$home/profiles.json")"
expect_no_match "template-only home has no llm-hub profile" 'llm-hub|smart-auto|local-llm-fast' \
  "$(jq -r '.profiles | keys[]' "$home/profiles.json")"
expect_match "template-only home has no hub model" '^0$' \
  "$(jq '[.models | keys[] | select(test("hub|local-"))] | length' "$home/profiles.json")"
expect_match "template-only migrations leave no null entry" '^0$' \
  "$(jq '[(.models + .profiles)[] | select(. == null)] | length' "$home/profiles.json")"
expect_match "the shipped template has no 2026-10-04 benchmark text" '^0$' \
  "$(grep -c '2026-10-04' "$TEMPLATE")"

# --- overlay only: a custom profile and an override merged over the template ---
home=$(new_tmp)
overlay="$home/overlay.json"
jq -n '{
  models: {"custom-model": {slug: "custom/slug", harnesses: ["claude"], description: "mine"}},
  profiles: {
    "my-custom": {harness: "claude", model: "custom-model", allowed_models: ["custom-model"],
      description: "overlay only", enabled: true, priority: 3, flags: [], env: {}, auth: []},
    "claude-haiku": {harness: "claude", model: "claude-haiku", allowed_models: ["claude-haiku"],
      description: "overridden by the overlay", enabled: true, priority: 10, flags: [], env: {}, auth: []}
  }
}' > "$overlay"
out=$(env HARNESS_ORCH_HOME="$home" ORCH_PROFILES_OVERLAY="$overlay" bun "$SCRIPT" init 2>&1); rc=$?
expect_exit "overlay-only init exits 0" 0 "$rc"
expect_match "overlay-only home has the overlay profile" '^custom-model$' \
  "$(jq -r '.profiles["my-custom"].model' "$home/profiles.json")"
expect_match "overlay-only home keeps the template defaults" '^claude-sonnet$' \
  "$(jq -r '.profiles["claude-default"].model' "$home/profiles.json")"
expect_match "an overlay profile replaces the template profile of the same name" '^overridden by the overlay$' \
  "$(jq -r '.profiles["claude-haiku"].description' "$home/profiles.json")"
expect_match "overlay-only home has one custom model in the catalog" '^custom/slug$' \
  "$(jq -r '.models["custom-model"].slug' "$home/profiles.json")"
expect_match "overlay-only home has no llm-hub profile from the real overlay" '^0$' \
  "$(jq '[.profiles | keys[] | select(test("llm-hub"))] | length' "$home/profiles.json")"

# --- both: the real overlay merged over the template -------------------------
if [ -f "$REAL_OVERLAY" ]; then
  home=$(new_tmp)
  out=$(env HARNESS_ORCH_HOME="$home" ORCH_PROFILES_OVERLAY="$REAL_OVERLAY" bun "$SCRIPT" init 2>&1); rc=$?
  expect_exit "both init exits 0" 0 "$rc"
  expect_match "both home has 18 profiles (8 template + 10 overlay)" '^18$' \
    "$(jq '.profiles | length' "$home/profiles.json")"
  expect_match "both home keeps the template planner" '^claude-planner$' \
    "$(jq -r '.settings.planner_profile' "$home/profiles.json")"
  expect_match "both home has the llm-hub profile from the overlay" '^local-qwen3.6-35b$' \
    "$(jq -r '.profiles["claude-llm-hub"].model' "$home/profiles.json")"
  expect_match "both home has the smart-auto model from the overlay" '^hub/smart-auto-balance$' \
    "$(jq -r '.models["hub-smart-auto-balance"].slug' "$home/profiles.json")"
  expect_match "both home has no null entry" '^0$' \
    "$(jq '[(.models + .profiles)[] | select(. == null)] | length' "$home/profiles.json")"
else
  echo "SKIP: both-case needs the gitignored $REAL_OVERLAY"
fi

finish
