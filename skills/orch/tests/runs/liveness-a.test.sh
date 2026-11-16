#!/usr/bin/env bash
# Tests for owner liveness: owner parsing, verify-owners with a fake opencode, transitions, events,
# caching, `run status`, `node brief`. Self-contained; run with: bash liveness-a.test.sh (part a: parsing, verify, caching, brief)
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

# 1. parsing table
parse() { ( export HARNESS_ORCH_HOME="$home"; source "$SCRIPT"; owner_parse "$1" | tr '\t' '|' ); }
mkdir -p "$home/jobs/job-77"
expect_eq "parse agent" "session|ses_abc123" "$(parse 'agent ses_abc123')"
expect_eq "parse bare" "session|ses_abc123" "$(parse 'ses_abc123')"
expect_eq "parse pid colon" "process|42" "$(parse 'pid:42')"
expect_eq "parse pid space" "process|42" "$(parse 'pid 42')"
expect_eq "parse job" "job|job-77" "$(parse 'job-77')"
expect_eq "parse coordinator" "none|coordinator" "$(parse 'coordinator')"
expect_eq "parse empty" "none|" "$(parse '')"
expect_eq "parse other" "unknown|someone" "$(parse 'someone')"

R=$(o run start "liveness")
for n in idle busy gone err slow pid dead coord none; do printf '{"op":"add","id":"%s","label":"%s"}\n' "$n" "$n"; done | o node batch "$R" >/dev/null
echo idle > "$fake/modes/ses_idle"; echo busy > "$fake/modes/ses_busy"; echo 404 > "$fake/modes/ses_gone"
echo error > "$fake/modes/ses_err"; echo slow > "$fake/modes/ses_slow"
o node update "$R" idle running --owner "agent ses_idle" >/dev/null
sleep 900 & livepid=$!
o node batch "$R" >/dev/null <<OPS
{"op":"update","id":"busy","status":"running","owner":"ses_busy"}
{"op":"update","id":"gone","status":"running","owner":"ses_gone"}
{"op":"update","id":"err","status":"running","owner":"ses_err"}
{"op":"update","id":"slow","status":"running","owner":"ses_slow"}
{"op":"update","id":"pid","status":"running","owner":"pid:$livepid"}
{"op":"update","id":"dead","status":"running","owner":"pid:999999"}
{"op":"update","id":"coord","status":"running","owner":"coordinator"}
{"op":"update","id":"none","status":"running"}
OPS

expect_eq "owner_kind stored" "session" "$(nf "$R" idle .owner_kind)"
expect_eq "owner_id stored" "ses_idle" "$(nf "$R" idle .owner_id)"
expect_eq "registry written" "$R" "$(jq -r .run "$home/owners/ses_idle.json")"
old_upd=$(nf "$R" busy .updated)

out=$(o node verify-owners "$R" --no-apply --json)
expect_eq "no-apply reports idle" "idle" "$(printf '%s' "$out" | jq -r '.[] | select(.node=="idle") | .owner_state')"
expect_eq "no-apply leaves status" "running" "$(nf "$R" idle .status)"
expect_eq "coordinator not checked" "0" "$(printf '%s' "$out" | jq '[.[] | select(.node=="coord")] | length')"

sleep 1
start=$(date +%s)
out=$(o node verify-owners "$R" --json)
elapsed=$(( $(date +%s) - start ))
st() { printf '%s' "$out" | jq -r --arg n "$1" '.[] | select(.node==$n) | .owner_state'; }
expect_eq "idle session reports idle" idle "$(st idle)"
expect_eq "busy alive" alive "$(st busy)"
expect_eq "404 gone" gone "$(st gone)"
expect_eq "error unknown" unknown "$(st err)"
expect_eq "timeout unknown" unknown "$(st slow)"
expect_eq "live pid alive" alive "$(st pid)"
expect_eq "dead pid gone" gone "$(st dead)"

# Regression: an idle session never ends its node; only `node update … done`, a report or a job exit does.
expect_eq "idle session stays running" running "$(nf "$R" idle .status)"
expect_eq "idle owner_state" idle "$(nf "$R" idle .owner_state)"
expect_eq "idle since stamped" 1 "$([ -n "$(nf "$R" idle '.owner_idle_since // empty')" ] && echo 1 || echo 0)"
expect_match "idle note kept" 'all done, tests pass' "$(nf "$R" idle .owner_note)"
expect_eq "idle not unverified" null "$(nf "$R" idle .unverified)"
expect_eq "idle no report" null "$(nf "$R" idle .report)"
expect_eq "gone -> error" error "$(nf "$R" gone .status)"
expect_eq "gone message" "owner ses_gone is gone" "$(nf "$R" gone .error)"
expect_eq "dead pid -> error" error "$(nf "$R" dead .status)"
expect_eq "alive stays running" running "$(nf "$R" busy .status)"
expect_eq "alive heartbeat" 1 "$([ "$(nf "$R" busy .updated)" \> "$old_upd" ] || [ "$(nf "$R" busy .updated)" = "$old_upd" ] && echo 1 || echo 0)"
expect_eq "alive owner_state" alive "$(nf "$R" busy .owner_state)"
expect_eq "unknown no change" running "$(nf "$R" err .status)"
expect_eq "unknown shown" unknown "$(nf "$R" err .owner_state)"
expect_eq "coordinator untouched" running "$(nf "$R" coord .status)"
expect_eq "unowned untouched" running "$(nf "$R" none .status)"
ev=$(cat "$home/runs/$R/events.jsonl")
expect_eq "no done event from owner-liveness" 0 "$(printf '%s\n' "$ev" | grep '"by":"owner-liveness"' | grep -c '"to":"done"')"
expect_match "idle event by owner-liveness" '"to":"idle".*"by":"owner-liveness"' "$ev"
expect_match "event error by owner-liveness" '"to":"error".*owner ses_gone is gone' "$ev"
expect_match "owner event" '"kind":"owner"' "$ev"

# only the coordinator ends an idle node (with a handoff, so done-verify does not flag it again)
mkdir -p "$(o node out "$R" idle)" && echo handoff > "$(o node out "$R" idle)/handoff.md"
o node update "$R" idle done >/dev/null 2>&1
expect_eq "explicit done ends idle node" done "$(nf "$R" idle .status)"
expect_eq "explicit done is not unverified" null "$(nf "$R" idle '.unverified')"

# caching: one call per distinct owner per pass; second pass within ttl makes no call
export ORCH_OWNER_CACHE_SECS=900
rm_cache() { trash "$home/owners/cache" 2>/dev/null; }
rm_cache
: > "$fake/calls"
o node verify-owners "$R" >/dev/null
c1=$(grep -c '^ses_busy$' "$fake/calls")
o node verify-owners "$R" >/dev/null
c2=$(grep -c '^ses_busy$' "$fake/calls")
expect_eq "one call first pass" 1 "$c1"
expect_eq "cache hit second pass" 1 "$c2"
export ORCH_OWNER_CACHE_SECS=0

# brief
b=$(o node brief "$R" busy)
expect_match "brief ping" "node ping $R busy --note" "$b"
expect_match "brief report" "node report $R busy --model" "$b"
expect_match "brief done" "node update $R busy done" "$b"
expect_match "brief error" "node update $R busy error --error" "$b"
expect_match "brief rule" '/dev/null' "$b"

kill "$livepid" 2>/dev/null
printf 'liveness: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
