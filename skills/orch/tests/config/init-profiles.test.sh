#!/usr/bin/env bash
# dispatch.ts tests: init, profiles, memory
# Run: bash init-profiles.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- init / profiles / memory -----------------------------------------------
home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" init 2>&1); rc=$?
expect_exit "init exits 0" 0 "$rc"
expect_match "init prints the config home" "$home" "$out"
expect_file "init copies profiles.json" "$home/profiles.json"
expect_file "init copies serve.json" "$home/serve.json"
expect_file "init creates memory.json" "$home/memory.json"
# The file:// dashboard is gone: the server renders from state.json directly.
expect_missing "init installs no index.html" "$home/index.html"
expect_missing "init creates no data dir" "$home/data"

out=$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" profile list 2>&1)
expect_match "profile list marks the default" '^\*claude-default	claude	claude-sonnet' "$out"
expect_match "profile list shows the planner profile" 'claude-planner	claude	claude-opus-1m' "$out"
expect_match "profile list shows the haiku tier" 'claude-haiku	claude	claude-haiku' "$out"
expect_match "the template plans on claude-planner" '^claude-planner$' \
  "$(jq -r '.settings.planner_profile' "$home/profiles.json")"
expect_match "profile pick sends a small task to claude-haiku" '^profile=claude-haiku$' \
  "$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" profile pick "fix a typo" --complexity small 2>/dev/null | head -1)"
expect_match "profile pick sends a large task to claude-default" '^profile=claude-default$' \
  "$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" profile pick "rewrite the scheduler" --complexity large 2>/dev/null | head -1)"
expect_match "profile list shows harness and model id" 'claude-llm-hub	claude	local-qwen3.6-35b' "$out"
expect_match "profile list shows the local planner" 'claude-llm-hub-planner	claude	local-ornith-1.5-35b' "$out"
expect_match "profile list shows the copilot llm-hub profile" 'copilot-llm-hub	copilot	local-qwen3.6-35b' "$out"
expect_match "profile list shows the opencode llm-hub profile" 'opencode-llm-hub	opencode	local-qwen3-coder-next' "$out"
expect_match "profile list shows the pi llm-hub profile" 'pi-llm-hub	pi	local-ornith-1.5-35b' "$out"
expect_match "profile list shows the small local profile" 'local-llm-fast	local-llm	local-ornith-1.5-9b' "$out"
expect_no_match "profile list drops the retired local profiles" '^(cursor-llm-hub|local-qwen|local-qwen3)	' "$out"
expect_match "the template ships no not-fit model" '^0$' \
  "$(jq '[.models[].slug | select(test("lfm2\\.5|qwen3-4b"))] | length' "$home/profiles.json")"
expect_match "the template disables no local harness" '^\[\]$' \
  "$(jq -c '.settings.disabled_harnesses' "$home/profiles.json")"

out=$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" profile show cursor-default 2>&1)
expect_match "cursor-default is pinned to the Auto model" '"model": "cursor-auto"' "$out"
expect_match "cursor-default allows only Auto" '"cursor-auto"' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bun "$SCRIPT" model list --profile cursor-default 2>&1)
expect_match "cursor Auto resolves to the auto slug" 'cursor-auto\tauto' "$out"
expect_no_match "cursor-default whitelist excludes composer" 'composer-1' "$out"

# A profiles.json still on the old composer default is retargeted; a deliberate choice is not.
mig=$(new_tmp)
jq -n '{settings:{default_profile:"cursor-default",retention_days:7,budget_threshold:85},
        models:{"cursor-composer":{slug:"composer-1",harnesses:["cursor-agent"],description:""}},
        profiles:{"cursor-default":{harness:"cursor-agent",model:"cursor-composer",flags:[],env:{},auth:[]},
                  "cursor-pinned":{harness:"cursor-agent",model:"cursor-composer",flags:[],env:{},auth:[]}}}' \
  > "$mig/profiles.json"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
migrated=$(jq -r '.profiles["cursor-default"].model' "$mig/profiles.json")
expect_match "migration retargets cursor-default to Auto" '^cursor-auto$' "$migrated"
migrated=$(jq -r '.profiles["cursor-default"].allowed_models | join(",")' "$mig/profiles.json")
expect_match "migration pins the Auto whitelist" '^cursor-auto$' "$migrated"
migrated=$(jq -r '.models["cursor-auto"].slug' "$mig/profiles.json")
expect_match "migration seeds the Auto catalog entry" '^auto$' "$migrated"
migrated=$(jq -r '.profiles["cursor-pinned"].model' "$mig/profiles.json")
expect_match "migration leaves other cursor profiles alone" '^cursor-composer$' "$migrated"
expect_match "migration seeds Copilot on an existing install" '^copilot$' \
  "$(jq -r '.profiles["copilot-default"].harness' "$mig/profiles.json")"
expect_file "migration records the one-time Copilot backfill" "$mig/.copilot-profile-migrated"
cleanup_dir "$mig"

# An install from the Copilot-led layout gets the Claude layout: claude-sub becomes claude-default and a
# claude-planner is seeded, but a disabled harness or profile stays disabled (migrations never re-enable).
mig=$(new_tmp)
jq -n '{settings:{default_profile:"claude-sub",retention_days:7,budget_threshold:85,disabled_harnesses:["claude","opencode"]},
        models:{"claude-sonnet":{slug:"sonnet",harnesses:["claude"],description:""}},
        profiles:{"claude-sub":{harness:"claude",model:"claude-sonnet",enabled:false,parallel_ok:false,max_complexity:"medium",flags:[],env:{},auth:[]},
                  "claude-llm-hub":{harness:"claude",model:"claude-sonnet",fallback:"claude-sub",flags:[],env:{},auth:[]}}}' \
  > "$mig/profiles.json"
: > "$mig/.copilot-planner-migrated"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "claude migration renames claude-sub" '^false$' "$(jq '.profiles | has("claude-sub")' "$mig/profiles.json")"
expect_match "claude-default keeps the user's enabled=false and is parallel" '^false,true$' \
  "$(jq -r '.profiles["claude-default"] | "\(.enabled),\(.parallel_ok)"' "$mig/profiles.json")"
expect_match "claude-planner runs Opus 1M at xhigh effort" '^opus\[1m\] --effort xhigh' \
  "$(jq -r '.models[.profiles["claude-planner"].model].slug + " " + (.profiles["claude-planner"].flags | join(" "))' "$mig/profiles.json")"
expect_match "a disabled claude harness stays disabled" '^\["claude","opencode"\]$' "$(jq -c '.settings.disabled_harnesses' "$mig/profiles.json")"
expect_match "a claude-llm-hub off llama_swap is not retargeted or pinned" '^claude-sonnet 0$' \
  "$(jq -r '.profiles["claude-llm-hub"] | "\(.model) \(.env | length)"' "$mig/profiles.json")"
expect_match "references follow the rename" '^claude-default claude-default$' \
  "$(jq -r '.settings.default_profile + " " + .profiles["claude-llm-hub"].fallback' "$mig/profiles.json")"
expect_file "claude migration records its marker" "$mig/.claude-planner-migrated"
cleanup_dir "$mig"

# An install shaped like the live one moves to the benchmark-backed local models: claude-llm-hub
# leaves the old ornith-1.0-35b default, the profiles on not-fit models go and their references
# follow, the not-fit catalog entries are dropped, and the local harnesses are re-enabled.
bench_fixture() {
  jq -n '{settings:{default_profile:"local-qwen",planner_profile:"copilot-planner",retention_days:7,budget_threshold:85,
                    disabled_harnesses:["cursor-agent","local-llm","opencode","pi"]},
          models:{"local-lfm-8b":{slug:"llama_swap/lfm2.5-8b-a1b",harnesses:["local-llm","claude","cursor-agent"],description:""},
                  "local-lfm-2.6b":{slug:"llama_swap/lfm2.5-2.6b",harnesses:["local-llm"],description:""},
                  "local-qwen3-4b":{slug:"llama_swap/qwen3-4b-2507",harnesses:["local-llm"],description:""},
                  "local-ornith-1.0-35b":{slug:"llama_swap/ornith-1.0-35b",harnesses:["claude","cursor-agent"],description:"",behaves_as:"claude-haiku-4-5-20251001"},
                  "cursor-auto":{slug:"auto",harnesses:["cursor-agent"],description:""}},
          profiles:{"claude-llm-hub":{harness:"claude",model:"local-ornith-1.0-35b",allowed_models:["llama_swap*"],parallel_ok:true,
                                      fallback:"cursor-llm-hub",flags:[],env:{ANTHROPIC_BASE_URL:"${LLM_HUB_URL}",ANTHROPIC_MODEL:"mine"},auth:[]},
                    "cursor-llm-hub":{harness:"cursor-agent",model:"local-lfm-8b",enabled:false,flags:[],env:{},auth:[]},
                    "local-qwen":{harness:"local-llm",model:"local-lfm-8b",allowed_models:["local-lfm-8b","local-qwen3-4b"],flags:[],env:{},auth:[]},
                    "local-qwen3":{harness:"local-llm",model:"local-qwen3-4b",fallback:"local-qwen",flags:[],env:{},auth:[]}}}'
}
mig=$(new_tmp)
bench_fixture > "$mig/profiles.json"
: > "$mig/.copilot-planner-migrated"
: > "$mig/.claude-planner-migrated"
: > "$mig/.claude-tiers-migrated"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "bench migration retargets claude-llm-hub, serial, falling back to copilot-llm-hub" \
  '^local-qwen3.6-35b false copilot-llm-hub$' \
  "$(jq -r '.profiles["claude-llm-hub"] | "\(.model) \(.parallel_ok) \(.fallback)"' "$mig/profiles.json")"
expect_match "bench migration adds the model tier pins, keeping the user's own" '^\$\{PROFILE_MODEL\} mine 1$' \
  "$(jq -r '.profiles["claude-llm-hub"].env | "\(.ANTHROPIC_DEFAULT_SONNET_MODEL) \(.ANTHROPIC_MODEL) \(.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)"' "$mig/profiles.json")"
expect_match "bench migration removes the profiles on not-fit models" '^false false false$' \
  "$(jq -r '.profiles | "\(has("cursor-llm-hub")) \(has("local-qwen")) \(has("local-qwen3"))"' "$mig/profiles.json")"
expect_match "bench migration points the default at local-llm-fast" '^local-llm-fast copilot-planner$' \
  "$(jq -r '.settings | "\(.default_profile) \(.planner_profile)"' "$mig/profiles.json")"
expect_match "bench migration drops the not-fit catalog entries" '^0$' \
  "$(jq '[.models | keys[] | select(. == "local-lfm-8b" or . == "local-lfm-2.6b" or . == "local-qwen3-4b")] | length' "$mig/profiles.json")"
expect_match "bench migration seeds the llm-hub profiles" '^claude-llm-hub-planner claude-smart-auto copilot-llm-hub copilot-smart-auto local-llm-fast opencode-llm-hub opencode-smart-auto pi-llm-hub pi-smart-auto$' \
  "$(jq -r '[.profiles | keys[] | select(. != "claude-llm-hub" and . != "copilot-default")] | join(" ")' "$mig/profiles.json")"
expect_match "local-llm-fast runs the small benchmark winner" '^llama_swap/ornith-1.5-9b$' \
  "$(jq -r '.models[.profiles["local-llm-fast"].model].slug' "$mig/profiles.json")"
expect_match "ornith-1.0-35b is no longer offered to cursor-agent" '^claude$' \
  "$(jq -r '.models["local-ornith-1.0-35b"].harnesses | join(",")' "$mig/profiles.json")"
expect_match "bench migration keeps the disabled harnesses" '^\["cursor-agent","local-llm","opencode","pi"\]$' \
  "$(jq -c '.settings.disabled_harnesses' "$mig/profiles.json")"
expect_file "bench migration records its marker" "$mig/.bench-local-migrated"
edit_json "$mig/profiles.json" '.profiles["claude-llm-hub"].model = "local-ornith-1.0-35b"'
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "a second init keeps claude-llm-hub on a hand-picked model" '^local-ornith-1.0-35b$' \
  "$(jq -r '.profiles["claude-llm-hub"].model' "$mig/profiles.json")"
cleanup_dir "$mig"

# A cursor-llm-hub the user moved off the not-fit model is theirs: it stays, so do the references
# to it, and a not-fit catalog entry a profile still runs is kept rather than recreated as a stub.
mig=$(new_tmp)
bench_fixture | jq '.profiles["cursor-llm-hub"].model = "cursor-auto"
  | .profiles["mine"] = {harness:"local-llm", model:"local-lfm-8b", flags:[], env:{}, auth:[]}' > "$mig/profiles.json"
: > "$mig/.copilot-planner-migrated"
: > "$mig/.claude-planner-migrated"
: > "$mig/.claude-tiers-migrated"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "a retargeted cursor-llm-hub survives, and so does the fallback to it" '^cursor-auto cursor-llm-hub$' \
  "$(jq -r '"\(.profiles["cursor-llm-hub"].model) \(.profiles["claude-llm-hub"].fallback)"' "$mig/profiles.json")"
expect_match "a not-fit model still in use keeps its catalog entry" '^true false$' \
  "$(jq -r '.models | "\(has("local-lfm-8b")) \(has("local-qwen3-4b"))"' "$mig/profiles.json")"
cleanup_dir "$mig"

# An install on the Copilot-led settings with the old trivial-only claude-haiku moves to the three
# Claude tiers; a hand-edited planner description stays, and a second init changes nothing.
mig=$(new_tmp)
jq -n '{settings:{default_profile:"copilot-default",planner_profile:"copilot-planner",retention_days:7,budget_threshold:85},
        models:{"claude-sonnet":{slug:"sonnet",harnesses:["claude"],description:""},
                "claude-haiku":{slug:"haiku",harnesses:["claude"],description:"Fast and cheap: typos, formatting, tiny edits, boilerplate.",cost:"low"}},
        profiles:{"claude-default":{harness:"claude",model:"claude-sonnet",flags:[],env:{},auth:[]},
                  "claude-planner":{harness:"claude",model:"claude-sonnet",description:"mine",flags:[],env:{},auth:[]},
                  "claude-haiku":{harness:"claude",model:"claude-haiku",max_complexity:"trivial",cost:"low",flags:[],env:{},auth:[]}}}' \
  > "$mig/profiles.json"
: > "$mig/.copilot-profile-migrated"
: > "$mig/.copilot-planner-migrated"
: > "$mig/.claude-planner-migrated"
: > "$mig/.bench-local-migrated"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "tiers migration points default and planner at the Claude tiers" '^claude-default claude-planner$' \
  "$(jq -r '.settings | "\(.default_profile) \(.planner_profile)"' "$mig/profiles.json")"
expect_match "tiers migration widens claude-haiku to small on the subscription" '^small subscription subscription$' \
  "$(jq -r '"\(.profiles["claude-haiku"].max_complexity) \(.profiles["claude-haiku"].cost) \(.models["claude-haiku"].cost)"' "$mig/profiles.json")"
expect_match "tiers migration keeps a hand-edited planner description" '^mine$' \
  "$(jq -r '.profiles["claude-planner"].description' "$mig/profiles.json")"
expect_file "tiers migration records its marker" "$mig/.claude-tiers-migrated"
edit_json "$mig/profiles.json" '.settings.default_profile = "custom"'
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "a second init keeps a hand-picked default" '^custom$' \
  "$(jq -r '.settings.default_profile' "$mig/profiles.json")"
cleanup_dir "$mig"

# Smart Auto profiles: seeded once where missing, a user's own copilot-smart-auto is kept, and a
# profile the user deletes stays deleted on the next init.
mig=$(new_tmp)
jq -n '{settings:{default_profile:"claude-default",planner_profile:"claude-planner",retention_days:7,budget_threshold:85},
        models:{},
        profiles:{"copilot-smart-auto":{harness:"local-llm",model:"",flags:[],env:{},auth:[]}}}' > "$mig/profiles.json"
for marker in copilot-profile copilot-planner claude-planner bench-local claude-tiers; do : > "$mig/.$marker-migrated"; done
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "smart-auto seeding keeps the user's own copilot-smart-auto" '^local-llm$' \
  "$(jq -r '.profiles["copilot-smart-auto"].harness' "$mig/profiles.json")"
expect_match "smart-auto seeding adds the missing claude profile on the hub model" '^hub-smart-auto-balance$' \
  "$(jq -r '.profiles["claude-smart-auto"].model' "$mig/profiles.json")"
expect_match "smart-auto seeding adds the opencode and pi profiles" '^opencode pi$' \
  "$(jq -r '[.profiles["opencode-smart-auto"].harness, .profiles["pi-smart-auto"].harness] | join(" ")' "$mig/profiles.json")"
expect_match "smart-auto seeding maps the catalog entry to the hub selector" '^hub/smart-auto-balance$' \
  "$(jq -r '.models["hub-smart-auto-balance"].slug' "$mig/profiles.json")"
expect_file "smart-auto seeding records its marker" "$mig/.smart-auto-migrated"
edit_json "$mig/profiles.json" 'del(.profiles["pi-smart-auto"])'
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "a deleted smart-auto profile is not reseeded" '^false$' \
  "$(jq -r '.profiles | has("pi-smart-auto")' "$mig/profiles.json")"
cleanup_dir "$mig"

# Regression: a fresh home seeded with a user's opencode-led profiles.json (claude disabled, default
# on opencode) and no migration markers. No migration may re-enable claude/copilot or move a default
# the user set, so the first chat still runs on opencode.
mig=$(new_tmp)
jq -n '{settings:{default_profile:"opencode-smart-auto",planner_profile:"opencode-smart-auto",retention_days:7,budget_threshold:85,
                  disabled_harnesses:["claude","copilot","cursor-agent","local-llm","pi"]},
        models:{"claude-sonnet":{slug:"sonnet",harnesses:["claude"],description:""},
                "hub-smart-auto-balance":{slug:"hub/smart-auto-balance",harnesses:["opencode"],description:""}},
        profiles:{"claude-default":{harness:"claude",model:"claude-sonnet",enabled:false,flags:[],env:{},auth:[]},
                  "claude-planner":{harness:"claude",model:"claude-sonnet",enabled:false,flags:[],env:{},auth:[]},
                  "copilot-default":{harness:"copilot",model:"",enabled:false,flags:[],env:{},auth:[]},
                  "opencode-smart-auto":{harness:"opencode",model:"hub-smart-auto-balance",enabled:true,flags:[],env:{},auth:[]}}}' \
  > "$mig/profiles.json"
env HARNESS_ORCH_HOME="$mig" bun "$SCRIPT" init >/dev/null 2>&1
expect_match "first-start migrations keep the user's opencode default and planner" '^opencode-smart-auto opencode-smart-auto$' \
  "$(jq -r '.settings | "\(.default_profile) \(.planner_profile)"' "$mig/profiles.json")"
expect_match "first-start migrations keep every disabled harness" '^\["claude","copilot","cursor-agent","local-llm","pi"\]$' \
  "$(jq -c '.settings.disabled_harnesses' "$mig/profiles.json")"
expect_match "first-start migrations re-enable no disabled profile" '^false false false$' \
  "$(jq -r '.profiles | "\(.["claude-default"].enabled) \(.["claude-planner"].enabled) \(.["copilot-default"].enabled)"' "$mig/profiles.json")"
cleanup_dir "$mig"

finish
