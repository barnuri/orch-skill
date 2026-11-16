#!/usr/bin/env bash
# Fast-tier unit tests for lib/dashboard/suggest.sh: the scan over a fixture run, dedupe, dismiss and
# the description generators, called in-process. Nothing is applied to real profiles.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'JSON'
{"id":"r1","status":"done","finished":"2026-01-01T00:00:00Z",
 "nodes":[{"id":"n1","status":"done","profile":"claude-opus","label":"Write Tests"},
          {"id":"n2","status":"running","profile":"claude-opus","label":"Other"}]}
JSON
fp='memory_record:claude-opus:write tests'
out=$(suggest_scan); rc=$?
expect_exit "scan succeeds" 0 "$rc"
expect_match "  ... and suggests a memory row for the finished node" '^1 pending success$' \
  "$(jq -r --arg fp "$fp" '[.suggestions[] | select(.fingerprint == $fp)] | "\(length) \(.[0].status) \(.[0].action.memory.outcome)"' "$SUGGESTIONS_FILE")"
expect_no_match "  ... but not for the running node" 'claude-opus:other' "$(jq -r '.suggestions[].fingerprint' "$SUGGESTIONS_FILE")"
suggest_scan >/dev/null
expect_match "a rescan adds no duplicate" '^1$' \
  "$(jq -r --arg fp "$fp" '[.suggestions[] | select(.fingerprint == $fp)] | length' "$SUGGESTIONS_FILE")"
sid=$(jq -r --arg fp "$fp" '.suggestions[] | select(.fingerprint == $fp) | .id' "$SUGGESTIONS_FILE")
suggest_dismiss "$sid"
suggest_scan >/dev/null
expect_match "a dismissed suggestion stays dismissed after a rescan" '^dismissed$' \
  "$(jq -r --arg fp "$fp" '[.suggestions[] | select(.fingerprint == $fp) | .status] | join(",")' "$SUGGESTIONS_FILE")"

printf '{"generated_at":"x","suggestions":[{"id":"a"},{"id":"b"},{"id":"a"}]}' > "$SUGGESTIONS_FILE"
suggest_dedupe_ids
expect_match "dedupe suffixes every repeated id" '^a,b,a-2$' "$(jq -r '[.suggestions[].id] | join(",")' "$SUGGESTIONS_FILE")"

fixture=$(new_tmp)
cat > "$fixture/profiles.json" <<'JSON'
{"profiles":{"p":{"harness":"claude","model":"opus","cost":"high","strengths":["code","review"]}},
 "models":{"m1":{"slug":"gpt-x","harnesses":["opencode","cursor"],"speed":"fast"}}}
JSON
expect_match "profile description lists harness, model, tier and strengths" \
  '^claude profile; model opus; high tier; strengths: code, review$' \
  "$(PROFILES_FILE="$fixture/profiles.json" suggest_generate_profile_description p)"
expect_match "model description lists slug, harnesses and speed" '^gpt-x on opencode/cursor; fast speed$' \
  "$(PROFILES_FILE="$fixture/profiles.json" suggest_generate_model_description m1)"
expect_empty "an unknown profile gives no description" "$(PROFILES_FILE="$fixture/profiles.json" suggest_generate_profile_description nope)"

suggest_is_auto_kind memory_record; rc=$?
expect_exit "memory_record is applied automatically" 0 "$rc"
suggest_is_auto_kind routing_hint; rc=$?
expect_exit "routing_hint is not" 1 "$rc"
out=$(suggest_apply 2>&1); rc=$?
expect_exit "apply with no ids is a usage error" 2 "$rc"
out=$(suggest_list --bad 2>&1); rc=$?
expect_exit "list with an unknown flag is refused" 2 "$rc"

cleanup_dir "$fixture"
cleanup_dir "$(dirname "$H")"
finish
