#!/usr/bin/env bash
# Tests for owner liveness: owner parsing, verify-owners with a fake opencode, transitions, events,
# caching, `run status`, `node brief`. Self-contained; run with: bash liveness.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
o init >/dev/null 2>&1

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
for n in idle busy gone err slow pid dead coord none; do o node add "$R" "$n" "$n" >/dev/null; done
for m in idle busy 404 error slow; do :; done
echo idle > "$fake/modes/ses_idle"; echo busy > "$fake/modes/ses_busy"; echo 404 > "$fake/modes/ses_gone"
echo error > "$fake/modes/ses_err"; echo slow > "$fake/modes/ses_slow"
o node update "$R" idle running --owner "agent ses_idle" >/dev/null
o node update "$R" busy running --owner "ses_busy" >/dev/null
o node update "$R" gone running --owner "ses_gone" >/dev/null
o node update "$R" err running --owner "ses_err" >/dev/null
o node update "$R" slow running --owner "ses_slow" >/dev/null
sleep 900 & livepid=$!
o node update "$R" pid running --owner "pid:$livepid" >/dev/null
o node update "$R" dead running --owner "pid:999999" >/dev/null
o node update "$R" coord running --owner coordinator >/dev/null
o node update "$R" none running >/dev/null 2>&1

expect_eq "owner_kind stored" "session" "$(nf "$R" idle .owner_kind)"
expect_eq "owner_id stored" "ses_idle" "$(nf "$R" idle .owner_id)"
expect_eq "registry written" "$R" "$(jq -r .run "$home/owners/ses_idle.json")"
old_upd=$(nf "$R" busy .updated)

out=$(o node verify-owners "$R" --no-apply --json)
expect_eq "no-apply reports finished" "finished" "$(printf '%s' "$out" | jq -r '.[] | select(.node=="idle") | .owner_state')"
expect_eq "no-apply leaves status" "running" "$(nf "$R" idle .status)"
expect_eq "coordinator not checked" "0" "$(printf '%s' "$out" | jq '[.[] | select(.node=="coord")] | length')"

sleep 1
start=$(date +%s)
out=$(o node verify-owners "$R" --json)
elapsed=$(( $(date +%s) - start ))
st() { printf '%s' "$out" | jq -r --arg n "$1" '.[] | select(.node==$n) | .owner_state'; }
expect_eq "idle finished" finished "$(st idle)"
expect_eq "busy alive" alive "$(st busy)"
expect_eq "404 gone" gone "$(st gone)"
expect_eq "error unknown" unknown "$(st err)"
expect_eq "timeout unknown" unknown "$(st slow)"
expect_eq "live pid alive" alive "$(st pid)"
expect_eq "dead pid gone" gone "$(st dead)"

expect_eq "finished -> done" done "$(nf "$R" idle .status)"
expect_eq "finished unverified" true "$(nf "$R" idle .unverified)"
expect_eq "finished auto" true "$(nf "$R" idle .auto)"
expect_eq "finished reported_by" owner-liveness "$(nf "$R" idle .report.reported_by)"
expect_match "finished note" 'all done, tests pass' "$(nf "$R" idle .report.note)"
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
expect_match "event done by owner-liveness" '"to":"done".*"by":"owner-liveness"|"by":"owner-liveness".*"to":"done"' "$ev"
expect_match "event error by owner-liveness" '"to":"error".*owner ses_gone is gone' "$ev"
expect_match "owner event" '"kind":"owner"' "$ev"

# total bound: with a 2 s budget and 1 s calls, three slow owners cannot all be probed
RB=$(o run start "bound")
for n in s1 s2 s3; do o node add "$RB" $n $n >/dev/null; echo slow > "$fake/modes/ses_$n"; o node update "$RB" $n running --owner ses_$n >/dev/null; done
: > "$fake/calls"
ORCH_OWNER_CALL_TIMEOUT=1 ORCH_OWNER_TOTAL_SECS=2 o node verify-owners "$RB" >/dev/null
expect_eq "budget caps the number of probes" 1 "$([ "$(wc -l < "$fake/calls" | tr -d ' ')" -le 2 ] && echo 1 || echo 0)"

# coordinator review clears unverified
o node update "$R" idle done --force >/dev/null 2>&1
expect_eq "review clears unverified" null "$(nf "$R" idle '.unverified')"

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

# run status shows and applies
R2=$(o run start "status apply")
o node add "$R2" a a >/dev/null
echo idle > "$fake/modes/ses_st"
o node update "$R2" a running --owner ses_st >/dev/null
out=$(o run status "$R2")
expect_match "status shows finished line" 'owner finished: a' "$out"
expect_eq "status applied" done "$(nf "$R2" a .status)"

R3=$(o run start "sync apply")
o node add "$R3" g g >/dev/null
o node update "$R3" g running --owner ses_gone >/dev/null
out=$(o run sync "$R3" --no-retry --verify-owners)
expect_match "sync shows gone line" 'owner gone: g' "$out"
expect_eq "sync applied" error "$(nf "$R3" g .status)"

# brief
b=$(o node brief "$R" busy)
expect_match "brief ping" "node ping $R busy --note" "$b"
expect_match "brief report" "node report $R busy --model" "$b"
expect_match "brief done" "node update $R busy done" "$b"
expect_match "brief error" "node update $R busy error --error" "$b"
expect_match "brief rule" '/dev/null' "$b"

# owner event (seeded registry from node update --owner)
R4=$(o run start "owner events")
o node add "$R4" w w >/dev/null
o node update "$R4" w running --owner ses_ev >/dev/null
o owner event ses_unknown finished --harness opencode; expect_eq "unknown id exit 0" 0 $?
expect_eq "unknown id writes nothing" running "$(nf "$R4" w .status)"
o owner event ses_ev alive --harness opencode
expect_eq "alive stamps owner_state" alive "$(nf "$R4" w .owner_state)"
o owner event ses_ev finished --harness opencode --note "built it"
expect_eq "finished -> done" done "$(nf "$R4" w .status)"
expect_eq "finished unverified" true "$(nf "$R4" w .unverified)"
expect_eq "finished reported_by" "owner-event:opencode" "$(nf "$R4" w .report.reported_by)"
expect_eq "finished note" "built it" "$(nf "$R4" w .report.note)"
o node add "$R4" x x >/dev/null
o node update "$R4" x running --owner ses_ex >/dev/null
o owner event ses_ex failed --harness claude --note "crashed"
expect_eq "failed -> error" error "$(nf "$R4" x .status)"
expect_eq "failed message" crashed "$(nf "$R4" x .error)"
o owner event ses_ex finished --harness claude
expect_eq "idempotent on non-running" error "$(nf "$R4" x .status)"
expect_eq "dispatch-path written" "$SCRIPT" "$(cat "$home/.dispatch-path")"

kill "$livepid" 2>/dev/null
printf 'liveness: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
