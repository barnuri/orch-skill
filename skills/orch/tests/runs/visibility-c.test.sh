#!/usr/bin/env bash
# Tests for visibility, part c: L1 ownership, L2 transitions, L5 job ids.
# Self-contained; run with: bash visibility-c.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$want" "$got" >&2
  failures=$((failures + 1))
}

home=$(mktemp -d)
o() { HARNESS_ORCH_HOME="$home" ORCH_WAIT_POLL_SECS=1 bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }
. "$SCRIPT_DIR/../tests/test-home.sh"; seed_home "$home"

# L1 ownership
RO=$(o run start "ownership")
o node batch "$RO" >/dev/null <<'OPS'
{"op":"add","id":"u","label":"Unowned"}
{"op":"add","id":"w","label":"Owned"}
{"op":"update","id":"u","status":"running"}
OPS
o node update "$RO" w running --owner coordinator >/dev/null
expect_match "L1 owner stored" '^coordinator$' "$(jq -r '.nodes[] | select(.id=="w") | .owner' "$home/runs/$RO/state.json")"
expect_match "L1 sync prints unowned" '^unowned: u$' "$(o run sync "$RO" --no-retry)"
expect_match "L1 status marks unowned" 'running u:.*UNOWNED' "$(o run status "$RO")"
expect_match "L1 owned node is not marked" 'running w: [^U]*$' "$(o run status "$RO")"
mkdir -p "$home/jobs/job-9"
o node add "$RO" j "Job" >/dev/null
o node update "$RO" j running --job job-9 >/dev/null
expect_match "L1 job id becomes owner" '^job-9$' "$(jq -r '.nodes[] | select(.id=="j") | .owner' "$home/runs/$RO/state.json")"

# L2 transitions
RT=$(o run start "transitions")
o node batch "$RT" >/dev/null <<'OPS'
{"op":"add","id":"t","label":"T"}
{"op":"update","id":"t","status":"running","owner":"coordinator"}
{"op":"update","id":"t","status":"error","error":"boom"}
OPS
o node update "$RT" t waiting >/dev/null; expect_exit "L2 error->waiting" 0 "$?"
expect_match "L2 waiting clears started/finished/error/owner/job" '^null null null null null$' \
  "$(st "$RT" '.nodes[0] | [.started, .finished, .error, .owner, .job_id] | map(tostring) | join(" ")')"
expect_match "L2 failed attempt archived" '^boom$' "$(st "$RT" '.nodes[0].attempts[-1].error')"
o node update "$RT" t running --owner coordinator >/dev/null; o node update "$RT" t done >/dev/null
out=$(o node update "$RT" t running 2>&1); rc=$?
expect_exit "L2 done->running refused" 2 "$rc"
expect_match "L2 message names targets" 'can move to: nothing' "$out"
o node update "$RT" t waiting >/dev/null 2>&1; expect_exit "L2 done->waiting needs force" 2 "$?"
o node update "$RT" t waiting --force >/dev/null; expect_exit "L2 force allows" 0 "$?"
expect_match "L2 transitions land in events" '"from":"done","to":"waiting"' "$(cat "$home/runs/$RT/events.jsonl")"
o node update "$RT" t skipped >/dev/null
expect_match "L2 skipped->done refused with targets" 'can move to: waiting running' "$(o node update "$RT" t done 2>&1)"

# L5 job ids
out=$(o node update "$RT" t running --job nope 2>&1); rc=$?
expect_exit "L5 unknown job refused" 2 "$rc"
expect_match "L5 message" 'job nope not found' "$out"

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
