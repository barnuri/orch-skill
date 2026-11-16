#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals set here are read by the sourced dispatch libs
# Fast-tier unit tests for lib/adapters/profile-sanity.sh: one probe row per profile state, with a
# fake claude CLI on PATH (no real harness is run).
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
unset ORCH_T_SRC ORCH_T_TOKEN ANTHROPIC_CUSTOM_HEADERS ORCH_RUN_ID ORCH_NODE_ID ORCH_SESSION_ID ORCH_RESUME_SESSION
ORCH_ENV_FILE_LOADED=1
export ORCH_BIN_DIRS=""
bin="$(dirname "$H")/bin"
mkdir -p "$bin"
cat > "$bin/claude" <<'SH'
#!/bin/sh
printf '{"result":"OK","is_error":false,"total_cost_usd":0}'
SH
chmod +x "$bin/claude"
PATH="$bin:$PATH"

row=$(profile_sanity_one p-cop)
expect_match "a profile on a disabled harness is not probed" '"harness":"copilot".*"error":"harness disabled"' "$row"
row=$(profile_sanity_one p-auth)
expect_match "a missing auth var reports unconfigured, not failed" '"status":"unconfigured".*"exit_code":3' "$row"
expect_match "the unconfigured row names the var" 'ORCH_T_TOKEN is not set' "$row"

row=$(ORCH_T_SRC=s profile_sanity_one p-claude)
expect_match "a working fake harness reports ok" '"ok":true,"status":"ok"' "$row"
expect_match "the ok row carries model id and slug" '"model_id":"m-sonnet","slug":"sonnet"' "$row"
expect_match "the ok row counts the answer bytes" '"bytes":2,' "$row"

out=$(cmd_profile_sanity --bogus 2>&1); rc=$?
expect_exit "profile sanity refuses an unknown argument" 2 "$rc"
out=$(cmd_profile_sanity --profile p-off --profile nobody); rc=$?
expect_exit "profile sanity over named profiles succeeds" 0 "$rc"
expect_match "one row per named profile, in order: disabled, then unknown with exit 2" \
  '^p-off:disabled:profile disabled nobody:unknown:2$' \
  "$(printf '%s' "$out" | jq -r '[.results[] | "\(.profile):\(.status):\(if .status == "unknown" then .exit_code else .error end)"] | join(" ")')"

cleanup_dir "$(dirname "$H")"
finish
