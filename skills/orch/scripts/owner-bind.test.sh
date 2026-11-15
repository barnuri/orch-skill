#!/usr/bin/env bash
# Tests for the owner binder and filler: literal id, plugin pending list (title, time, tie), opencode
# child listing, unbound reason, fill of empty fields only, unowned flag. Run with: bash owner-bind.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
export OPENCODE_SESSION_ID=ses_parent

new_home() { home=$(mktemp -d); export HARNESS_ORCH_HOME="$home"; bash "$SCRIPT" init >/dev/null 2>&1; }
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
o node add "$R" speed "Make the test suites faster" >/dev/null
o node add "$R" colours "Restore status colours" >/dev/null
o node update "$R" speed running --owner "agent (spawned)" >/dev/null
o node update "$R" colours running --owner "agent (spawned)" >/dev/null
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
o node add "$R" alpha "Alpha" >/dev/null
o node update "$R" alpha running --owner "agent (spawned)" >/dev/null
pend ses_near "zzz qqq" 5000
pend ses_far "yyy www" 60000
out=$(o node bind-owners --run "$R")
expect_match "time: closest bound" 'alpha: bound ses_near \(time\)' "$out"

# 3. tie leaves unbound with candidates in the reason
new_home
R=$(o run start "bind")
o node add "$R" alpha "Alpha" >/dev/null
o node update "$R" alpha running --owner "agent (spawned)" >/dev/null
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
o node add "$R" a1 "Aone" >/dev/null; o node add "$R" a2 "Atwo" >/dev/null
o node update "$R" a1 running --owner "agent (spawned)" >/dev/null
o node update "$R" a2 running --owner "agent (spawned)" >/dev/null
pend ses_one "qqq" 1000
o node bind-owners --run "$R" >/dev/null
expect_match "two nodes: a1 unbound" 'also fits node' "$(nf "$R" a1 .owner_reason)"

# 4. opencode child listing when there is no pending file
new_home
R=$(o run start "bind")
o node add "$R" speed "Make the test suites faster" >/dev/null
o node update "$R" speed running --owner "agent (spawned)" >/dev/null
now_s=$(date +%s)
jq -nc --argjson ms "$((now_s * 1000 + 3000))" --argjson old "$(( (now_s - 3600) * 1000 ))" '{data: [
  {id: "ses_k1", parentID: "ses_parent", title: "test suites speedup", time: {created: $ms}},
  {id: "ses_old", parentID: "ses_parent", title: "test suites", time: {created: $old}},
  {id: "ses_other", parentID: "ses_zzz", title: "test suites", time: {created: $ms}}]}' > "$fake/children.json"
out=$(o node bind-owners --run "$R")
expect_match "listing: bound" 'speed: bound ses_k1 \(listing-title\)' "$out"
rm -f "$fake/children.json"

# 5. nothing found: unbound reason (listing unavailable), then the unowned flag
new_home
R=$(o run start "bind")
o node add "$R" x "X node" >/dev/null; o node add "$R" y "Y node" >/dev/null
o node update "$R" x running --owner "agent (spawned)" >/dev/null
o node update "$R" y running >/dev/null
o node bind-owners --run "$R" >/dev/null
expect_match "unbound reason" 'listing unavailable' "$(nf "$R" x .owner_reason)"
expect_eq "unowned flag" true "$(nf "$R" y .unowned)"
expect_match "unowned reason" 'running without an owner' "$(nf "$R" y .owner_reason)"
expect_eq "unowned event once" 1 "$(grep -c '"unowned"' "$home/runs/$R/events.jsonl")"
o node bind-owners --run "$R" >/dev/null
expect_eq "unowned event still once" 1 "$(grep -c '"unowned"' "$home/runs/$R/events.jsonl")"

# 6. fill: only empty fields, never overwrite
new_home
R=$(o run start "bind")
o node add "$R" f1 "Fill one" >/dev/null; o node add "$R" f2 "Fill two" >/dev/null
o node update "$R" f1 running --owner "ses_fill1" >/dev/null
o node update "$R" f2 running --owner "ses_fill2" >/dev/null
o node report "$R" f2 --model coordinator-model --input-tokens 7 --usd 0.5 >/dev/null
now_s=$(date +%s)
for s in fill1 fill2; do
  jq -nc --arg id "ses_$s" --argjson c "$((now_s * 1000))" '{data: {id: $id, model: {id: "prov/real-model"}, cost: 1.25, tokens: {input: 900, output: 100}, time: {created: $c, updated: $c}}}' > "$fake/info-ses_$s.json"
done
o node bind-owners --run "$R" >/dev/null
expect_eq "fill: model" prov/real-model "$(nf "$R" f1 .model)"
expect_eq "fill: input tokens" 900 "$(nf "$R" f1 .report.input_tokens)"
expect_eq "fill: output tokens" 100 "$(nf "$R" f1 .report.output_tokens)"
expect_eq "fill: usd" 1.25 "$(nf "$R" f1 .report.usd)"
expect_eq "fill: harness" opencode "$(nf "$R" f1 .harness)"
expect_eq "fill: last activity set" true "$(nf "$R" f1 '.last_activity != null')"
expect_eq "no overwrite: model" coordinator-model "$(nf "$R" f2 .model)"
expect_eq "no overwrite: tokens" 7 "$(nf "$R" f2 .report.input_tokens)"
expect_eq "no overwrite: usd" 0.5 "$(nf "$R" f2 .report.usd)"
expect_eq "fill: only tokens not set on f2 output" null "$(nf "$R" f2 .report.output_tokens)"

printf 'owner-bind: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
