#!/usr/bin/env bash
# dispatch.ts tests: profile defaults resolution (node > profile > defaults > builtin) and settings get/set.
# Run: bash profile-effective.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" ORCH_PROFILES_OVERLAY="$home/none.json" bun "$SCRIPT" "$@"; }
seed_home "$home"

# A profile that sets parallel_ok false itself, and one that inherits everything.
edit_json "$home/profiles.json" '.profiles["p-own"] = (.profiles["claude-default"] + {parallel_ok: false})
  | .profiles["p-inherit"] = (.profiles["claude-default"] | del(.parallel_ok, .max_parallel))
  | .defaults = {parallel_ok: true, max_parallel: 7, env: {A: "defaults", C: "defaults"}}
  | .profiles["p-inherit"].env = {A: "profile"}'

out=$(orch profile show p-own --effective 2>&1)
expect_match "profile value beats defaults" '^parallel_ok	false	profile$' "$out"
expect_match "defaults value fills an unset key" '^max_parallel	7	defaults$' "$out"
expect_match "builtin fills an unset key with no default" '^effort	null	builtin$' "$out"

out=$(orch profile show p-inherit --effective 2>&1)
expect_match "an unset key inherits the defaults value" '^parallel_ok	true	defaults$' "$out"
expect_match "env merges key by key, the profile wins per key" '^env	\{"A":"profile","C":"defaults"\}	profile$' "$out"

expect_match "settings get reads defaults.max_parallel" '^7$' "$(orch settings get defaults.max_parallel 2>&1)"
expect_match "settings set writes defaults.max_parallel" '^defaults.max_parallel = 5$' "$(orch settings set defaults.max_parallel 5 2>&1)"
expect_match "settings set stores the integer" '^5$' "$(jq -r '.defaults.max_parallel' "$home/profiles.json")"
expect_exit "settings set rejects 0" 2 "$(orch settings set defaults.max_parallel 0 >/dev/null 2>&1; echo $?)"
expect_exit "settings set rejects 33" 2 "$(orch settings set defaults.max_parallel 33 >/dev/null 2>&1; echo $?)"
expect_exit "settings set rejects a non-boolean parallel_ok" 2 "$(orch settings set defaults.parallel_ok yes >/dev/null 2>&1; echo $?)"
expect_match "settings set moves the old settings.max_parallel into defaults" '^null$' "$(jq -c '.settings.max_parallel' "$home/profiles.json")"

cleanup_dir "$home"
finish
