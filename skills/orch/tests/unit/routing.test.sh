#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals set here are read by the sourced dispatch libs
# Fast-tier unit tests for lib/adapters/routing.sh: model catalog lookups, allowed_models patterns
# and `profile pick` scoring, on a hand-built profiles.json.
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
USAGE_SNAPSHOT=/nonexistent/usage-snapshot.json   # budget_check: no snapshot = budget ok

expect_match "allowed_models patterns match by id prefix and slug prefix" '^m-opus m-gw$' \
  "$(profile_allowed_model_ids p-allow | paste -sd' ' -)"
expect_match "no allowed_models means every model of the harness" '^m-sonnet m-opus m-gw$' \
  "$(profile_allowed_model_ids p-claude | paste -sd' ' -)"
expect_match "a profile model given as a slug resolves to its catalog id" '^m-opus$' "$(model_id_resolve p-allow)"
expect_empty "a profile with no model resolves to nothing" "$(model_id_resolve p-auth)"
expect_match "slug_resolve maps an id to its slug, else passes the ref through" '^gw/lfm raw/x$' \
  "$(printf '%s %s' "$(model_slug_resolve p-claude m-gw)" "$(model_slug_resolve p-claude raw/x)")"
expect_match "behaves_as resolves by id and by slug" '^haiku sonnet$' \
  "$(printf '%s %s' "$(model_behaves_as_resolve p-claude m-gw)" "$(model_behaves_as_resolve p-claude sonnet)")"
model_id_allowed p-allow m-gw; expect_exit "a slug-pattern match is allowed" 0 "$?"
model_id_allowed p-allow m-sonnet; expect_exit "a model outside the patterns is refused" 1 "$?"
model_id_allowed p-claude m-oc; expect_exit "no allowed_models allows any id" 0 "$?"

expect_match "model list --harness filters the catalog" $'^m-gw\tgw/lfm\nm-oc\toc/model' "$(model_list --harness opencode)"
out=$(model_list --bogus 2>&1); rc=$?
expect_exit "model list refuses an unknown argument" 2 "$rc"

out=$(cmd_profile_pick 2>&1); rc=$?
expect_exit "profile pick needs a task" 2 "$rc"
out=$(cmd_profile_pick "fix the typo" 2>&1); rc=$?
expect_exit "profile pick succeeds" 0 "$rc"
expect_match "the cheapest high-priority enabled profile wins, with its model" \
  $'^profile=p-claude\nmodel=m-sonnet\nreason=complexity=small$' "$out"
printf '[{"profile":"p-oc","outcome":"success","task_kind":"docs"}]\n' > "$MEMORY_FILE"
out=$(cmd_profile_pick "write docs" --kind docs --complexity small)
expect_match "remembered successes for the kind outweigh cost" '^profile=p-oc.*reason=complexity=small kind=docs' \
  "$(printf '%s' "$out" | paste -sd' ' -)"
out=$(cmd_profile_pick "write docs" --kind docs --complexity large)
expect_match "a profile outside its complexity band is skipped" '^profile=p-claude' "$out"

cleanup_dir "$(dirname "$H")"
finish
