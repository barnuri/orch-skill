#!/usr/bin/env bash
# Tests for the done check (node_done_verify in lib/runs.sh): `node update <run> <node> done` and the
# `run sync` that marks a finished job done need a non-empty handoff.md in the node's output dir, or
# they print `done without handoff` and mark the node unverified. Also `run status --fresh`.
# Temp homes only. Run with: bash done-verify.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-lib.sh"

home=$(new_tmp); seed_home "$home"
export HARNESS_ORCH_HOME="$home" ORCH_HEALTH_MONITOR=0 ORCH_OWNER_FILL=0
o() { bash "$SCRIPT" "$@"; }
st() { jq -r --arg n "$2" ".nodes[] | select(.id == \$n) | $3" "$home/runs/$1/state.json"; }

R=$(o run start "done check")
o node add "$R" a "A" >/dev/null; o node add "$R" b "B" >/dev/null; o node add "$R" c "C" >/dev/null
o node add "$R" j "J" >/dev/null

# 1. done with no handoff: warning line, node done and unverified
o node update "$R" a running --owner coordinator >/dev/null
out=$(o node update "$R" a done 2>&1); rc=$?
expect_exit "no handoff: exit 0" 0 "$rc"
expect_match "no handoff: warning line" '^done without handoff: a ' "$out"
expect_match "no handoff: status done" '^done$' "$(st "$R" a .status)"
expect_match "no handoff: unverified" '^true$' "$(st "$R" a .unverified)"

# 2. an empty handoff.md counts as missing
o node update "$R" b running --owner coordinator >/dev/null
dir=$(o node out "$R" b); : > "$dir/handoff.md"
out=$(o node update "$R" b done 2>&1)
expect_match "empty handoff: warning line" '^done without handoff: b ' "$out"
expect_match "empty handoff: unverified" '^true$' "$(st "$R" b .unverified)"

# 3. a non-empty handoff.md: no warning, not unverified
o node update "$R" c running --owner coordinator >/dev/null
dir=$(o node out "$R" c); printf 'did the thing\n' > "$dir/handoff.md"
out=$(o node update "$R" c done 2>&1)
expect_no_match "handoff: no warning" 'done without handoff' "$out"
expect_match "handoff: not unverified" '^null$' "$(st "$R" c .unverified)"

# 4. run sync marking a finished job done runs the same check
job="fakejob-$$"; mkdir -p "$home/jobs/$job"; printf '0\n' > "$home/jobs/$job/exit_code"; : > "$home/jobs/$job/log"
o node update "$R" j running --job "$job" >/dev/null
out=$(o run sync "$R" --no-retry 2>&1)
expect_match "sync: node done" '^done$' "$(st "$R" j .status)"
expect_match "sync: warning line" 'done without handoff: j ' "$out"
expect_match "sync: unverified" '^true$' "$(st "$R" j .unverified)"

# 5. run status --fresh prints one line read from state.json now
out=$(o run status "$R" --fresh 2>&1); rc=$?
expect_exit "fresh: exit 0" 0 "$rc"
expect_match "fresh: line with every node by status" '^fresh [0-9T:-]+Z \[running\] done=a,b,c,j \(read .*/state.json\)$' "$out"
expect_no_match "status without --fresh has no fresh line" '^fresh ' "$(o run status "$R" 2>&1)"
expect_match "fresh --json: field" '^fresh ' "$(o run status "$R" --fresh --json | jq -r '.fresh')"

cleanup_dir "$home"
finish
