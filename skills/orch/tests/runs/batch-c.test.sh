#!/usr/bin/env bash
# Tests for `node batch`, part c: continued-run dependency fallback; update with deps and needs-user: fast vs fallback vs single calls.
# Run with: bash batch-c.test.sh
set -u
export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0
# The equivalence checks compare whole state files: pin the session id (else each call records its
# own pid-N harness_session) and drop the identity a calling orch node or opencode session exports.
export CLAUDE_CODE_SESSION_ID=batch-test
unset OPENCODE_SESSION_ID ORCH_EVENT_BY ORCH_SESSION_ID ORCH_RUN_ID ORCH_NODE_ID ORCH_NODE_OUT ORCH_JOB_DIR

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
o() { HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }

# norm/evk: compare whole state files and events across runs.
norm() {
  jq -S 'del(.run_id, .title, .started) | walk(if type == "object" then
    with_entries(select(.key | IN("created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked") | not))
    else . end)' "$home/runs/$1/state.json"
}
evk() { jq -c '[.kind, .node, .from, .to, .note, .by]' "$home/runs/$1/events.jsonl"; }

# an op the fast path does not support (a dependency finished in the run this one continued) falls back
RC=$(o run start "carry src" --id carry-src)
o node add "$RC" a "A" >/dev/null; o node update "$RC" a done >/dev/null; o node add "$RC" b "B" >/dev/null
o run carry "$RC" --id carry-dst >/dev/null 2>&1
out=$(printf '%s\n' '{"op":"add","id":"c","goal":"C","after":"a"}' | o node batch carry-dst 2>&1); rc=$?
expect_exit "continued-run dependency falls back and applies" 0 "$rc"
expect_match "fallback added the node" '^C$' "$(st carry-dst '.nodes[] | select(.id == "c") | .label')"

# update with deps (--after), needs-user and no status: fast path vs fallback vs single calls
dops=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"A"}' \
  '{"op":"add","id":"b","goal":"B"}' \
  '{"op":"add","id":"g","goal":"Gate"}' \
  '{"op":"update","id":"b","after":["a"]}' \
  '{"op":"update","id":"g","after":"*","needs_user":"approve"}' \
  '{"op":"update","id":"a","status":"running","owner":"coordinator","needs_user":"look"}' \
  '{"op":"update","id":"a","clear_needs_user":true}' \
  '{"op":"update","id":"b","after":""}' \
  '{"op":"update","id":"b","after":"a,g"}')
DF=$(o run start "deps fast" --id deps-fast)
DB=$(o run start "deps fallback" --id deps-fallback)
DS=$(o run start "deps single" --id deps-single)
dfo=$(printf '%s\n' "$dops" | o node batch "$DF" 2>&1); rc=$?
expect_exit "deps batch (fast) exits 0" 0 "$rc"
dbo=$(printf '%s\n' "$dops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$DB" 2>&1); rc=$?
expect_exit "deps batch (fallback) exits 0" 0 "$rc"
o node add "$DS" a A >/dev/null; o node add "$DS" b B >/dev/null; o node add "$DS" g Gate >/dev/null
o node update "$DS" b --after a >/dev/null
o node update "$DS" g --after '*' --needs-user approve >/dev/null
o node update "$DS" a running --owner coordinator --needs-user look >/dev/null
o node update "$DS" a --clear-needs-user >/dev/null
o node update "$DS" b --after "" >/dev/null
o node update "$DS" b --after a,g >/dev/null
expect_match "deps fast output" '^line 5: update g ok' "$dfo"
if [ "$dfo" = "$dbo" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: deps fast and fallback output differ\n%s\n---\n%s\n' "$dfo" "$dbo" >&2; fi
expect_match "gate after_all set" '^true approve$' "$(st "$DF" '.nodes[] | select(.id == "g") | "\(.after_all) \(.needs_user)"')"
expect_match "needs_user cleared" '^null$' "$(st "$DF" '.nodes[] | select(.id == "a") | .needs_user')"
expect_match "edges replaced" '^a>b g>b$' "$(st "$DF" '[.edges[] | join(">")] | join(" ")')"
for other in "$DB" "$DS"; do
  if [ "$(norm "$DF")" = "$(norm "$other")" ] && [ "$(evk "$DF")" = "$(evk "$other")" ]; then pass_count=$((pass_count + 1)); else
    failures=$((failures + 1)); printf 'FAIL: deps batch differs from %s\n' "$other" >&2
    diff <(norm "$DF") <(norm "$other") >&2; diff <(evk "$DF") <(evk "$other") >&2; fi
done
dbad=$(printf '%s\n' \
  '{"op":"update","id":"a","after":"a"}' \
  '{"op":"update","id":"a","after":"zz"}' \
  '{"op":"update","id":"a","after":"b"}' \
  '{"op":"update","id":"a"}' \
  '{"op":"update","id":"a","needs_user":""}')
e1=$(printf '%s\n' "$dbad" | o node batch "$DF" 2>&1)
e2=$(printf '%s\n' "$dbad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$DF" 2>&1)
expect_match "self dependency refused" '^line 1: node update: a cannot depend on itself' "$e1"
expect_match "unknown dependency refused" '^line 2: node update: dependency zz is not in run' "$e1"
expect_match "cycle refused" '^line 3: node update: --after b would make a cycle' "$e1"
expect_match "update with nothing refused" '^line 4: usage: dispatch.sh node update' "$e1"
expect_match "empty needs_user refused" '^line 5: node update: --needs-user expects a reason' "$e1"
if [ "$e1" = "$e2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: deps fast and fallback errors differ\n%s\n---\n%s\n' "$e1" "$e2" >&2; fi
e3=""; while IFS= read -r line; do
  e3="$e3$(printf '%s\n' "$line" | jq -r '["node","update","'"$DF"'",.id] + (if .after != null then ["--after", .after] else [] end)
    + (if has("needs_user") then ["--needs-user", .needs_user] else [] end) | @sh' | xargs -I{} sh -c "HARNESS_ORCH_HOME='$home' bash '$SCRIPT' {} 2>&1 >/dev/null")"$'\n'
done <<< "$dbad"
expect_match "single calls give the same messages" 'cannot depend on itself.*' "$e3"
for msg in 'cannot depend on itself' 'dependency zz is not in run' 'would make a cycle' 'usage: dispatch.sh node update' '--needs-user expects a reason'; do
  expect_match "single call says: $msg" "$msg" "$e3"
done

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
