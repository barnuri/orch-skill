#!/usr/bin/env bash
# Tests for owner liveness: owner parsing, verify-owners with a fake opencode, transitions, events,
# caching, `run status`, `node brief`. Self-contained; run with: bash liveness-b.test.sh (part b: bound, job owner, status/sync apply, owner events)
set -u
export ORCH_NO_ANNOUNCE=1
# No opencode session table: these tests drive the fake opencode API only.
export ORCH_OPENCODE_DB=/nonexistent/opencode.db

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
expect_eq() {
  if [ "$2" = "$3" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2
  failures=$((failures + 1))
}

home=$(mktemp -d)
fake=$(mktemp -d)
mkdir -p "$fake/bin" "$fake/modes"
cat > "$fake/bin/opencode" <<'EOF'
#!/usr/bin/env bash
# fake: opencode api GET /api/session/<id>/message ...
id=$(printf '%s' "$3" | sed -E 's#/api/session/([^/]+)/message#\1#')
echo "$id" >> "$FAKE_DIR/calls"
mode=$(cat "$FAKE_DIR/modes/$id" 2>/dev/null || echo error)
case "$mode" in
  idle) echo '{"data":[{"type":"assistant","time":{"completed":1},"content":[{"type":"text","text":"all done, tests pass"}]}]}' ;;
  busy) echo '{"data":[{"type":"assistant","time":{},"content":[]}]}' ;;
  404) echo 'Error: 404 Not Found' >&2; exit 1 ;;
  slow) sleep 30 ;;
  *) echo 'boom' >&2; exit 1 ;;
esac
EOF
chmod +x "$fake/bin/opencode"
export FAKE_DIR="$fake"
export PATH="$fake/bin:$PATH"
export ORCH_OWNER_CALL_TIMEOUT=5
export ORCH_OWNER_CACHE_SECS=0
export ORCH_OWNER_TOTAL_SECS=120

o() { HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
nf() { jq -r --arg n "$2" ".nodes[] | select(.id==\$n) | $3" "$home/runs/$1/state.json"; }
. "$SCRIPT_DIR/../tests/test-home.sh"; seed_home "$home"

echo 404 > "$fake/modes/ses_gone"

# total bound: with a 2 s budget and 1 s calls, three slow owners cannot all be probed
RB=$(o run start "bound")
for n in s1 s2 s3; do echo slow > "$fake/modes/ses_$n"; done
o node batch "$RB" >/dev/null <<'OPS'
{"op":"add","id":"s1","label":"s1"}
{"op":"add","id":"s2","label":"s2"}
{"op":"add","id":"s3","label":"s3"}
{"op":"update","id":"s1","status":"running","owner":"ses_s1"}
{"op":"update","id":"s2","status":"running","owner":"ses_s2"}
{"op":"update","id":"s3","status":"running","owner":"ses_s3"}
OPS
: > "$fake/calls"
ORCH_OWNER_CALL_TIMEOUT=1 ORCH_OWNER_TOTAL_SECS=2 o node verify-owners "$RB" >/dev/null
expect_eq "budget caps the number of probes" 1 "$([ "$(wc -l < "$fake/calls" | tr -d ' ')" -le 2 ] && echo 1 || echo 0)"

# a dispatched job owner that exited 0 still ends the node
mkdir -p "$home/jobs/job-ok"; printf '0\n' > "$home/jobs/job-ok/exit_code"
RJ=$(o run start "job owner")
o node add "$RJ" j j >/dev/null
o node update "$RJ" j running --owner job-ok >/dev/null
o node verify-owners "$RJ" >/dev/null
expect_eq "job owner exit 0 -> done" done "$(nf "$RJ" j .status)"

# run status shows and applies
R2=$(o run start "status apply")
o node add "$R2" a a >/dev/null
echo idle > "$fake/modes/ses_st"
o node update "$R2" a running --owner ses_st >/dev/null
out=$(o run status "$R2")
expect_match "status shows idle line" 'owner idle: a' "$out"
expect_eq "status leaves idle node running" running "$(nf "$R2" a .status)"

R3=$(o run start "sync apply")
o node add "$R3" g g >/dev/null
o node update "$R3" g running --owner ses_gone >/dev/null
out=$(o run sync "$R3" --no-retry --verify-owners)
expect_match "sync shows gone line" 'owner gone: g' "$out"
expect_eq "sync applied" error "$(nf "$R3" g .status)"

# owner event (seeded registry from node update --owner)
R4=$(o run start "owner events")
o node add "$R4" w w >/dev/null
o node update "$R4" w running --owner ses_ev >/dev/null
o owner event ses_unknown finished --harness opencode; expect_eq "unknown id exit 0" 0 $?
expect_eq "unknown id writes nothing" running "$(nf "$R4" w .status)"
o owner event ses_ev alive --harness opencode
expect_eq "alive stamps owner_state" alive "$(nf "$R4" w .owner_state)"
o owner event ses_ev finished --harness opencode --note "built it"
expect_eq "session finished event -> still running" running "$(nf "$R4" w .status)"
expect_eq "session finished event -> idle" idle "$(nf "$R4" w .owner_state)"
expect_eq "session finished event keeps note" "built it" "$(nf "$R4" w .owner_note)"
o node add "$R4" x x >/dev/null
o node update "$R4" x running --owner ses_ex >/dev/null
o owner event ses_ex failed --harness claude --note "crashed"
expect_eq "failed -> error" error "$(nf "$R4" x .status)"
expect_eq "failed message" crashed "$(nf "$R4" x .error)"
o owner event ses_ex finished --harness claude
expect_eq "idempotent on non-running" error "$(nf "$R4" x .status)"
expect_eq "dispatch-path written" "$SCRIPT" "$(cat "$home/.dispatch-path")"

printf 'liveness: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
