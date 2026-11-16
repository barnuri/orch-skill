#!/usr/bin/env bash
# Tests for the owner binder and filler: literal id, plugin pending list (title, time, tie), opencode
# child listing, unbound reason, fill of empty fields only, unowned flag. Run with: bash owner-bind.test.sh
set -u
export ORCH_NO_ANNOUNCE=1
# Sections 0-6 test the API paths only; section 7 points this at a fixture session table.
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

# 7. opencode's session table (session_v2): prefix ids, title+time of child sessions, umbrella, fill, stall
if command -v sqlite3 >/dev/null 2>&1; then
  new_home
  db="$home/fixture-opencode.db"
  export ORCH_OPENCODE_DB="$db"
  now_ms=$(( $(date +%s) * 1000 ))
  old_ms=$(( now_ms - 20 * 60 * 1000 ))
  row() { # id parent title model cost created updated busy(0|1)
    local busy="NULL" idle="$7"
    [ "$8" = 1 ] && { busy="$7"; idle="NULL"; }
    printf "insert into session_v2 values ('%s', %s, '%s', '{\"id\":\"%s\"}', %s, 100, 20, 0, 5, 0, %s, %s, %s, %s);\n" \
      "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$busy" "$idle"
  }
  {
    echo "create table session_v2 (id text, parent_id text, title text, model text, cost real, tokens_input int, tokens_output int,
      tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_created int, time_updated int, time_busy int, time_idle int);"
    row ses_aaaaaaaaaaaa1XXXXXXXXXXXXX "'ses_root'" "prefix work" prov/m1 1.5 "$now_ms" "$now_ms" 1
    row ses_bbbbbbbbbbbb1XXXXXXXXXXXXX "'ses_root'" "one" prov/m1 0 "$now_ms" "$now_ms" 1
    row ses_bbbbbbbbbbbb2XXXXXXXXXXXXX "'ses_root'" "two" prov/m1 0 "$now_ms" "$now_ms" 1
    row ses_chatXXXXXXXXXXXXXXXXXXXXXX "'ses_other'" "Persistent chat turns across restarts" prov/m1 0.75 "$now_ms" "$now_ms" 1
    row ses_noiseXXXXXXXXXXXXXXXXXXXXX "'ses_other'" "unrelated words entirely" prov/m1 0 "$now_ms" "$now_ms" 1
    row ses_stallXXXXXXXXXXXXXXXXXXXXX "'ses_root'" "stall" prov/m2 0 "$old_ms" "$old_ms" 0
    row ses_busyoldXXXXXXXXXXXXXXXXXXX "'ses_root'" "busy old" prov/m2 0 "$old_ms" "$old_ms" 1
  } | sqlite3 "$db"
  R=$(o run start "index")
  o node add "$R" p1 "Prefix node" >/dev/null
  o node add "$R" amb "Ambiguous node" >/dev/null
  o node add "$R" chats "Persistent chat turns" >/dev/null
  o node add "$R" st "Stall node" >/dev/null
  o node add "$R" bz "Busy node" >/dev/null
  o node add "$R" x2 "Other model" >/dev/null
  o node add "$R" um "Umbrella one" >/dev/null
  o node add "$R" mx "Umbrella mixed" >/dev/null
  o node update "$R" p1 running --owner "agent ses_aaaaaaaaaaaa1" >/dev/null
  o node update "$R" amb running --owner "agent ses_bbbbbbbbbbbb" >/dev/null
  o node update "$R" chats running --owner "agent restart-chats (spawned)" >/dev/null
  o node update "$R" st running --owner "ses_stallXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  o node update "$R" bz running --owner "ses_busyoldXXXXXXXXXXXXXXXXXXX" >/dev/null
  o node update "$R" x2 running --owner coordinator >/dev/null
  o node report "$R" x2 --model prov/other >/dev/null
  o node update "$R" um running --owner "see p1 and chats" >/dev/null
  o node update "$R" mx running --owner "see p1 and x2" >/dev/null
  out=$(o node bind-owners --run "$R")
  expect_eq "prefix: full id bound" ses_aaaaaaaaaaaa1XXXXXXXXXXXXX "$(nf "$R" p1 .owner_id)"
  expect_eq "prefix: how" prefix "$(nf "$R" p1 .owner_bind)"
  expect_eq "ambiguous prefix: unbound" unbound "$(nf "$R" amb .owner_state)"
  expect_match "ambiguous prefix: candidates" 'ambiguous: ses_bbbbbbbbbbbb1X+, ses_bbbbbbbbbbbb2X+' "$(nf "$R" amb .owner_reason)"
  expect_eq "index title+time: child bound" ses_chatXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" chats .owner_id)"
  expect_eq "index title+time: how" index-title "$(nf "$R" chats .owner_bind)"
  expect_eq "fill: session" ses_chatXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" chats .session)"
  expect_eq "fill: model" prov/m1 "$(nf "$R" chats .model)"
  expect_eq "fill: model_id" prov/m1 "$(nf "$R" chats .model_id)"
  expect_eq "fill: cost" 0.75 "$(nf "$R" chats .session_stats.cost)"
  expect_eq "fill: tokens" 100 "$(nf "$R" chats .session_stats.tokens.input)"
  expect_eq "fill: report usd" 0.75 "$(nf "$R" chats .report.usd)"
  expect_eq "fill: node cost from session" 0.75 "$(nf "$R" chats .cost.usd)"
  expect_eq "fill: node cost basis" opencode-session "$(nf "$R" chats .cost.cost_basis)"
  expect_eq "fill: node cost tokens" 100 "$(nf "$R" chats .cost.input_tokens)"
  expect_eq "fill: prefix node model" prov/m1 "$(nf "$R" p1 .model)"
  expect_eq "stall: flagged" true "$(nf "$R" st .stalled)"
  expect_match "stall: reason" '^no activity since 20' "$(nf "$R" st .stalled_reason)"
  expect_match "stall: bind-owners prints it" 'st: stalled: no activity since' "$out"
  expect_eq "stall: one event" 1 "$(grep -c '"to":"stalled"' "$home/runs/$R/events.jsonl")"
  expect_eq "stall: node keeps running" running "$(nf "$R" st .status)"
  expect_eq "busy old session: not stalled" null "$(nf "$R" bz .stalled)"
  o node bind-owners --run "$R" >/dev/null
  expect_eq "umbrella: kind" umbrella "$(nf "$R" um .owner_kind)"
  expect_eq "umbrella: one model" prov/m1 "$(nf "$R" um .model)"
  expect_eq "umbrella: status" "0/2 done" "$(nf "$R" um .umbrella_status)"
  expect_eq "umbrella: mixed models" mixed "$(nf "$R" mx .model)"
  expect_eq "stall: still one event" 1 "$(grep -c '"to":"stalled"' "$home/runs/$R/events.jsonl")"
  # refresh: usage and duration follow the session; a filled model is never overwritten
  sleep 1
  later=$(( now_ms + 60000 ))
  sqlite3 "$db" "update session_v2 set cost = 2.5, model = '{\"id\":\"prov/changed\"}', time_updated = $later, time_busy = $later where id = 'ses_chatXXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "refresh: cost" 2.5 "$(nf "$R" chats .session_stats.cost)"
  expect_eq "refresh: duration" 60 "$(nf "$R" chats .session_stats.duration_s)"
  expect_eq "refresh: owner-fill report usd" 2.5 "$(nf "$R" chats .report.usd)"
  expect_eq "refresh: model kept" prov/m1 "$(nf "$R" chats .model)"
  expect_eq "refresh: node cost" 2.5 "$(nf "$R" chats .cost.usd)"

  # A coordinator report wins: no session cost on the node, and an earlier one is dropped.
  o node report "$R" chats --usd 9 --input-tokens 1 >/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "report wins: cost dropped" null "$(nf "$R" chats .cost)"
  expect_eq "report wins: report kept" 9 "$(nf "$R" chats .report.usd)"
  expect_eq "report wins: stats still filled" 2.5 "$(nf "$R" chats .session_stats.cost)"

  # A resumed retry keeps the session: the archived attempt's share is not counted twice.
  ( source "$SCRIPT"; node_patch "$R" p1 '.attempts = [{session: "ses_aaaaaaaaaaaa1XXXXXXXXXXXXX", cost: {usd: 1, cost_basis: "opencode-session", input_tokens: 40}}]' )
  o node bind-owners --run "$R" >/dev/null
  expect_eq "attempts: only the remainder" 0.5 "$(nf "$R" p1 .cost.usd)"
  expect_eq "attempts: token remainder" 60 "$(nf "$R" p1 .cost.input_tokens)"

  # Final totals when a session-bound node ends, and a one-off backfill of older terminal nodes.
  sqlite3 "$db" "update session_v2 set cost = 3.25 where id = 'ses_aaaaaaaaaaaa1XXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node update "$R" p1 done >/dev/null
  expect_eq "final: done keeps the prefix-bound full id" ses_aaaaaaaaaaaa1XXXXXXXXXXXXX "$(nf "$R" p1 .owner_id)"
  expect_eq "final: stats on done" true "$(nf "$R" p1 .session_stats.final)"
  expect_eq "final: session total taken at done" 3.25 "$(nf "$R" p1 .session_stats.session_total.cost)"
  expect_eq "final: share at done (less the attempt)" 2.25 "$(nf "$R" p1 .session_stats.cost)"
  expect_eq "final: node cost at done" 2.25 "$(nf "$R" p1 .cost.usd)"
  o node add "$R" old "Old done node" >/dev/null
  o node update "$R" old done --force >/dev/null 2>&1
  ( source "$SCRIPT"; node_patch "$R" old '.status = "done" | .owner_kind = "session" | .owner_id = "ses_stallXXXXXXXXXXXXXXXXXXXXX" | .session_stats = null' )
  o node bind-owners --run "$R" >/dev/null
  expect_eq "backfill: terminal node filled" true "$(nf "$R" old .session_stats.final)"
  expect_eq "backfill: no stall on a done node" null "$(nf "$R" old .stalled)"
  sqlite3 "$db" "update session_v2 set cost = 99 where id = 'ses_stallXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "backfill: only once" true "$(nf "$R" old ".session_stats.cost == 0")"

  # A report figure captured from the session is not the coordinator's: a later `node report` without
  # --usd keeps it marked auto, and the newer session total replaces it.
  o node add "$R" rp "Report node" >/dev/null
  o node update "$R" rp running --owner "ses_noiseXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  sqlite3 "$db" "update session_v2 set cost = 1.25 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node bind-owners --run "$R" >/dev/null
  o node report "$R" rp --model prov/m1 --note "progress" >/dev/null
  expect_eq "stale report: relabelled inline" inline "$(nf "$R" rp .report.reported_by)"
  expect_match "stale report: usd marked auto" '"usd"' "$(nf "$R" rp '.report.auto | tojson')"
  sqlite3 "$db" "update session_v2 set cost = 2.75 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "stale report: usd refreshed" 2.75 "$(nf "$R" rp .report.usd)"
  expect_eq "stale report: node cost from session" 2.75 "$(nf "$R" rp .cost.usd)"
  o node report "$R" rp --usd 0.4 >/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "explicit --usd wins" 0.4 "$(nf "$R" rp .report.usd)"
  expect_eq "explicit --usd: no session cost" null "$(nf "$R" rp .cost)"
  sqlite3 "$db" "update session_v2 set cost = 3 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node update "$R" rp done >/dev/null
  expect_eq "explicit --usd survives done" 0.4 "$(nf "$R" rp .report.usd)"

  # One session owning two nodes in a row: the second shows only what it added.
  sqlite3 "$db" "insert into session_v2 values ('ses_seqXXXXXXXXXXXXXXXXXXXXXXX', 'ses_root', 'seq', '{\"id\":\"prov/m1\"}', 4.11, 400, 40, 0, 0, 0, $now_ms, $now_ms, $now_ms, NULL)"
  trash "$home/owners/cache" 2>/dev/null
  o node add "$R" seq1 "First in a row" >/dev/null; o node add "$R" seq2 "Second in a row" >/dev/null
  o node update "$R" seq1 running --owner "ses_seqXXXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  o node update "$R" seq1 done >/dev/null
  expect_eq "seq: first final share" 4.11 "$(nf "$R" seq1 .session_stats.cost)"
  sleep 1
  o node update "$R" seq2 running --owner "ses_seqXXXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  sqlite3 "$db" "update session_v2 set cost = 5.04, tokens_input = 500 where id = 'ses_seqXXXXXXXXXXXXXXXXXXXXXXX'"
  trash "$home/owners/cache" 2>/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "seq: second shows the delta" 93 "$(nf "$R" seq2 '.cost.usd * 100 | round')"
  expect_eq "seq: second token delta" 100 "$(nf "$R" seq2 .cost.input_tokens)"
  expect_eq "seq: baseline recorded" 4.11 "$(nf "$R" seq2 .session_stats.baseline.cost)"
  expect_eq "seq: first unchanged" 4.11 "$(nf "$R" seq1 .cost.usd)"
  expect_eq "seq: run total counts the session once" 504 "$(jq '[.nodes[] | select(.id | IN("seq1","seq2")) | .cost.usd] | add * 100 | round' "$home/runs/$R/state.json")"

  # One session bound to two nodes at once: the first node gets the session cost, the other 0.
  sqlite3 "$db" "insert into session_v2 values ('ses_dupXXXXXXXXXXXXXXXXXXXXXXX', 'ses_root', 'dup', '{\"id\":\"prov/m1\"}', 3, 300, 30, 0, 0, 0, $now_ms, $now_ms, $now_ms, NULL)"
  trash "$home/owners/cache" 2>/dev/null
  o node add "$R" dup1 "First co-owner" >/dev/null; o node add "$R" dup2 "Second co-owner" >/dev/null
  o node update "$R" dup1 running --owner "ses_dupXXXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  o node update "$R" dup2 running --owner "ses_dupXXXXXXXXXXXXXXXXXXXXXXX" >/dev/null
  o node bind-owners --run "$R" >/dev/null
  o node bind-owners --run "$R" >/dev/null
  dup_total() { jq '[.nodes[] | select(.id | IN("dup1","dup2")) | (.cost.usd // 0)] | add * 100 | round' "$home/runs/$R/state.json"; }
  expect_eq "co-owners: first gets the session cost" 3 "$(nf "$R" dup1 .cost.usd)"
  expect_eq "co-owners: second gets 0" 0 "$(nf "$R" dup2 .cost.usd)"
  expect_eq "co-owners: run total counts the session once" 300 "$(dup_total)"
  o node update "$R" dup1 done >/dev/null
  o node update "$R" dup2 done >/dev/null
  o node bind-owners --run "$R" >/dev/null
  expect_eq "co-owners: run total once after both end" 300 "$(dup_total)"

  # actual_model: the session's real model next to the requested alias, which stays in `model`.
  expect_eq "actual: real model recorded" prov/changed "$(nf "$R" chats .actual_model)"
  expect_eq "actual: alias kept" prov/m1 "$(nf "$R" chats .model)"
  # A Smart Auto alias is not a real model: the hub says what served the session.
  if command -v python3 >/dev/null 2>&1; then
    hub_dir=$(mktemp -d)
    cat > "$hub_dir/hub.py" <<'PY'
import http.server, json, sys
from urllib.parse import urlparse, parse_qs
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        body = {"selection": {"main": {"model": "copilot/claude-opus-5-5", "stage": "solver"}}} \
            if q.get("session") == ["ses_autoXXXXXXXXXXXXXXXXXXXXXX"] else {"selection": None}
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *_): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_address[1]))
s.serve_forever()
PY
    python3 "$hub_dir/hub.py" "$hub_dir/port" & hub_pid=$!
    for _ in $(seq 1 100); do [ -s "$hub_dir/port" ] && break; sleep 0.1; done
    printf 'LLM_HUB_URL=http://127.0.0.1:%s\n' "$(cat "$hub_dir/port")" >> "$home/env"
    sqlite3 "$db" "insert into session_v2 values ('ses_autoXXXXXXXXXXXXXXXXXXXXXX', 'ses_root', 'auto', '{\"id\":\"hub/smart-auto-balance\"}', 0, 1, 1, 0, 0, 0, $now_ms, $now_ms, $now_ms, NULL)"
    trash "$home/owners/cache" 2>/dev/null
    o node add "$R" auto "Smart Auto node" >/dev/null
    o node update "$R" auto running --owner "ses_autoXXXXXXXXXXXXXXXXXXXXXX" >/dev/null
    o node bind-owners --run "$R" >/dev/null
    expect_eq "actual: alias stays the model" hub/smart-auto-balance "$(nf "$R" auto .model)"
    expect_eq "actual: hub names the served model" copilot/claude-opus-5-5 "$(nf "$R" auto .actual_model)"
    kill "$hub_pid" 2>/dev/null; wait "$hub_pid" 2>/dev/null
  else
    printf 'owner-bind: SKIP hub actual-model test (no python3)\n'
  fi
  export ORCH_OPENCODE_DB=/nonexistent/opencode.db
else
  printf 'owner-bind: SKIP session table tests (no sqlite3)\n'
fi

# 8. copilot: the real model from Copilot's own events.jsonl (main agent only, latest call wins).
new_home
cp_dir=$(mktemp -d)
export ORCH_COPILOT_SESSION_DIR="$cp_dir"
mkdir -p "$cp_dir/11111111-2222-3333-4444-555555555555"
{
  echo '{"type":"session.start","data":{"selectedModel":"auto"}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"user","model":"gpt-6-luna","responseModel":"gpt-6-luna"}}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"agent","model":"gpt-6.1-sol","responseModel":"gpt-6.1-sol"}}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"sub-agent","model":"claude-sonnet-5.5","responseModel":"claude-sonnet-5-5"}}}'
} > "$cp_dir/11111111-2222-3333-4444-555555555555/events.jsonl"
R=$(o run start "copilot")
o node add "$R" cp "Copilot node" >/dev/null
o node update "$R" cp running --owner coordinator >/dev/null
( source "$SCRIPT"; node_patch "$R" cp '.adapter = "copilot" | .model = "copilot-auto" | .session = "11111111-2222-3333-4444-555555555555"' )
o node bind-owners --run "$R" >/dev/null
expect_eq "copilot: actual model from events.jsonl" gpt-6.1-sol "$(nf "$R" cp .actual_model)"
expect_eq "copilot: alias kept" copilot-auto "$(nf "$R" cp .model)"
o node add "$R" cq "Copilot no session file" >/dev/null
o node update "$R" cq running --owner coordinator >/dev/null
( source "$SCRIPT"; node_patch "$R" cq '.adapter = "copilot" | .session = "99999999-0000-0000-0000-000000000000"' )
o node bind-owners --run "$R" >/dev/null
expect_eq "copilot: no session file leaves actual unset" null "$(nf "$R" cq .actual_model)"
unset ORCH_COPILOT_SESSION_DIR

printf 'owner-bind: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
