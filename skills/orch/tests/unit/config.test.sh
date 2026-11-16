#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals set here are read by the sourced dispatch libs
# Fast-tier unit tests for lib/core/config.sh: validators, settings, env refs and profile_load.
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
unset ORCH_T_SRC ORCH_T_TOKEN ORCH_T_LIT ORCH_T_REF

is_identifier FOO_1; expect_exit "is_identifier takes a variable name" 0 "$?"
is_identifier 1FOO; expect_exit "is_identifier refuses a leading digit" 1 "$?"
is_identifier 'A-B'; expect_exit "is_identifier refuses a dash" 1 "$?"
is_uint 42; expect_exit "is_uint takes digits" 0 "$?"
is_uint ''; expect_exit "is_uint refuses empty" 1 "$?"
is_uint -3; expect_exit "is_uint refuses a sign" 1 "$?"
in_list b "a b c"; expect_exit "in_list finds a word" 0 "$?"
in_list b "ab bc"; expect_exit "in_list matches whole words only" 1 "$?"

expect_match "setting_get reads a setting" '^p-claude$' "$(setting_get default_profile x)"
expect_match "setting_get falls back to the default" '^dflt$' "$(setting_get no_such_key dflt)"

expect_match "a literal env value passes through" '^plain$' "$(profile_resolve_env_value p k plain)"
out=$(profile_resolve_env_value p KEY '${ORCH_T_SRC}' 2>&1); rc=$?
expect_exit "an unset \${VAR} reference is unconfigured (3)" 3 "$rc"
expect_match "the unset reference is named" 'env KEY references unset \$\{ORCH_T_SRC\}' "$out"
expect_match "a set \${VAR} reference resolves" '^v1$' "$(ORCH_T_SRC=v1 profile_resolve_env_value p k '${ORCH_T_SRC}')"
out=$(profile_resolve_env_value p k 'pre${ORCH_T_SRC}' 2>&1)
expect_match "partial interpolation stays literal" '^pre\$\{ORCH_T_SRC\}$' "$out"

printf 'ORCH_T_A=fromfile\nORCH_T_B=fromfile\n# comment\nbad-name=x\nnoequals\n' > "$H/env"
out=$(ORCH_ENV_FILE_LOADED=""; ORCH_T_B=shell; export ORCH_T_B; orch_load_env_file
      printf '%s|%s|%s' "${ORCH_T_A:-}" "$ORCH_T_B" "$(env | grep -c '^bad-name=' || true)")
expect_match "env file sets new vars, the shell wins, bad names are skipped" '^fromfile\|shell\|0$' "$out"

out=$(unset LLM_HUB_V1_URL; LLM_HUB_URL=http://hub:1/v1// llm_hub_derive_v1_url; printf '%s' "$LLM_HUB_V1_URL")
expect_match "derive_v1_url keeps exactly one /v1" '^http://hub:1/v1$' "$out"

ORCH_ENV_FILE_LOADED=1
out=$(ORCH_T_SRC=sv profile_load p-claude 2>&1
      printf 'rc=%s h=%s m=%s id=%s ba=%s nf=%s lit=%s ref=%s' "$?" "$PROFILE_HARNESS" "$PROFILE_MODEL" \
        "$PROFILE_MODEL_ID" "$PROFILE_MODEL_BEHAVES_AS" "${#PROFILE_FLAGS[@]}" "$ORCH_T_LIT" "$ORCH_T_REF")
expect_match "profile_load resolves harness, model, flags and env" \
  '^rc=0 h=claude m=sonnet id=m-sonnet ba=sonnet nf=2 lit=plain ref=sv$' "$out"
out=$(profile_load p-bad 2>&1); rc=$?
expect_exit "profile_load refuses an unknown harness" 2 "$rc"
expect_match "the bad harness is named" 'harness "nope" must be one of' "$out"
out=$(ORCH_MODEL_ID=m-sonnet profile_load p-allow 2>&1); rc=$?
expect_exit "an ORCH_MODEL_ID outside allowed_models is refused" 2 "$rc"
out=$(profile_load nobody 2>&1); rc=$?
expect_exit "profile_load of an unknown profile fails 2" 2 "$rc"
expect_match "the unknown profile lists the available ones" 'Available: .*p-claude' "$out"

out=$(memory_add --profile p-claude --outcome maybe 2>&1); rc=$?
expect_exit "memory add refuses an unknown outcome" 2 "$rc"
out=$(memory_list -n x 2>&1); rc=$?
expect_exit "memory list refuses a non-numeric -n" 2 "$rc"

cleanup_dir "$(dirname "$H")"
finish
