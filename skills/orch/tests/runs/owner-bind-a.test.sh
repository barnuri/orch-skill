#!/usr/bin/env bash
# Tests for the owner binder and filler, part A: literal id, title, time, tie (split from owner-bind.test.sh).
# Run with: bash owner-bind-a.test.sh
set -u
export ORCH_NO_ANNOUNCE=1
# The API paths only; the session-table parts point this at a fixture session table.
export ORCH_OPENCODE_DB=/nonexistent/opencode.db

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_match() {
  if printf '%s' "$3" | grep -qE -e "$2"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in: %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}
expect_eq() {
  if [ "$2" = "$3" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}

fake=$(mktemp -d)
mkdir -p "$fake/bin"
export FAKE_DIR="$fake"
cat > "$fake/bin/opencode" <<'EOS'
#!/usr/bin/env bash
# fake: api GET /api/session --param parentID=X  |  api GET /api/session/<id>  |  .../message
path="$3"
echo "$*" >> "$FAKE_DIR/calls"
case "$path" in
  /api/session) [ -f "$FAKE_DIR/children.json" ] && cat "$FAKE_DIR/children.json" || { echo boom >&2; exit 1; } ;;
  */message) echo '{"data":[{"type":"assistant","time":{},"content":[]}]}' ;;
  /api/session/*) id="${path#/api/session/}"; [ -f "$FAKE_DIR/info-$id.json" ] && cat "$FAKE_DIR/info-$id.json" || { echo 'Error: 404 Not Found' >&2; exit 1; } ;;
esac
EOS
chmod +x "$fake/bin/opencode"
export PATH="$fake/bin:$PATH"
export ORCH_OWNER_CALL_TIMEOUT=5 ORCH_OWNER_CACHE_SECS=0 ORCH_OWNER_TOTAL_SECS=120
export ORCH_OWNER_BIND_SECS=0 ORCH_UNOWNED_SECS=0
# An inherited hub URL would win over the test home's env file.
unset LLM_HUB_URL LLM_HUB_V1_URL LLM_HUB_KEY
export OPENCODE_SESSION_ID=ses_parent

. "$(dirname "${BASH_SOURCE[0]}")/../test-home.sh"
new_home() { home=$(mktemp -d); export HARNESS_ORCH_HOME="$home"; seed_home "$home"; }
o() { bash "$SCRIPT" "$@"; }
nf() { jq -r --arg n "$2" ".nodes[] | select(.id==\$n) | $3" "$home/runs/$1/state.json"; }
now_ms() { printf '%s000' "$(date +%s)"; }
pend() { # child title offset-ms
  mkdir -p "$home/owners/pending"
  jq -nc --arg c "$1" --arg t "$2" --argjson ms "$(( $(date +%s) * 1000 + $3 ))" \
    '{child: $c, parent: "ses_parent", title: $t, created: "2026-01-01T00:00:00Z", created_ms: $ms}' > "$home/owners/pending/$1.json"
}

# 0. root cause: free text with an embedded id is "unknown" to owner_parse, then bound by the literal step
new_home
R=$(o run start "bind")
o node add "$R" lit "Literal node" >/dev/null
o node update "$R" lit running --owner "agent ses_lit123 (spawned)" >/dev/null
expect_eq "literal: kind session" session "$(nf "$R" lit .owner_kind)"
expect_eq "literal: id" ses_lit123 "$(nf "$R" lit .owner_id)"
expect_eq "literal: bind how" literal "$(nf "$R" lit .owner_bind)"
expect_eq "literal: registry" "$R" "$(jq -r .run "$home/owners/ses_lit123.json")"
expect_eq "literal: owner text untouched" "agent ses_lit123 (spawned)" "$(nf "$R" lit .owner)"

# 1. bind by title via the plugin pending list
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"speed","label":"Make the test suites faster"}
{"op":"add","id":"colours","label":"Restore status colours"}
{"op":"update","id":"speed","status":"running","owner":"agent (spawned)"}
{"op":"update","id":"colours","status":"running","owner":"agent (spawned)"}
OPS
pend ses_c1 "Restore status colours site-wide" 1000
pend ses_c2 "Faster test suites" 2000
out=$(o node bind-owners --run "$R")
expect_match "title: speed bound" 'speed: bound ses_c2 \(title\)' "$out"
expect_match "title: colours bound" 'colours: bound ses_c1 \(title\)' "$out"
expect_eq "title: registry" "$R" "$(jq -r .run "$home/owners/ses_c2.json")"
expect_eq "title: owner_id" ses_c2 "$(nf "$R" speed .owner_id)"
out=$(o node bind-owners --run "$R")
expect_eq "title: second pass quiet" "" "$out"

# 2. bind by time (no title overlap), closest wins, each child binds once
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"alpha","label":"Alpha"}
{"op":"update","id":"alpha","status":"running","owner":"agent (spawned)"}
OPS
pend ses_near "zzz qqq" 5000
pend ses_far "yyy www" 60000
out=$(o node bind-owners --run "$R")
expect_match "time: closest bound" 'alpha: bound ses_near \(time\)' "$out"

# 3. tie leaves unbound with candidates in the reason
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"alpha","label":"Alpha"}
{"op":"update","id":"alpha","status":"running","owner":"agent (spawned)"}
OPS
pend ses_t1 "qqq" 4000
pend ses_t2 "www" 4500
out=$(o node bind-owners --run "$R")
expect_match "tie: unbound" 'alpha: unbound' "$out"
expect_match "tie: candidates listed" 'ses_t1.*ses_t2|ses_t2.*ses_t1' "$(nf "$R" alpha .owner_reason)"
expect_eq "tie: owner_state" unbound "$(nf "$R" alpha .owner_state)"
expect_eq "tie: no registry" "no" "$([ -f "$home/owners/ses_t1.json" ] && echo yes || echo no)"
# two nodes started together, one child: not guessed
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"a1","label":"Aone"}
{"op":"add","id":"a2","label":"Atwo"}
{"op":"update","id":"a1","status":"running","owner":"agent (spawned)"}
{"op":"update","id":"a2","status":"running","owner":"agent (spawned)"}
OPS
pend ses_one "qqq" 1000
o node bind-owners --run "$R" >/dev/null
expect_match "two nodes: a1 unbound" 'also fits node' "$(nf "$R" a1 .owner_reason)"

printf 'owner-bind-a: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
