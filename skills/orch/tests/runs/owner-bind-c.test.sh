#!/usr/bin/env bash
# Tests for the owner binder and filler, part C: opencode session table: prefix ids, title+time, umbrella, fill, stall, refresh, final, backfill (split from owner-bind.test.sh).
# Run with: bash owner-bind-c.test.sh
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
# wait_until "<condition>" [seconds]: polls until the condition holds (as test-lib.sh does).
wait_until() {
  local cond="$1" limit="${2:-60}" waited=0
  while ! eval "$cond" >/dev/null 2>&1; do
    [ "$waited" -lt $((limit * 10)) ] || return 1
    sleep 0.1; waited=$((waited + 1))
  done
}
new_home() { home=$(mktemp -d); export HARNESS_ORCH_HOME="$home"; seed_home "$home"; }
o() { bash "$SCRIPT" "$@"; }
nf() { jq -r --arg n "$2" ".nodes[] | select(.id==\$n) | $3" "$home/runs/$1/state.json"; }
now_ms() { printf '%s000' "$(date +%s)"; }
pend() { # child title offset-ms
  mkdir -p "$home/owners/pending"
  jq -nc --arg c "$1" --arg t "$2" --argjson ms "$(( $(date +%s) * 1000 + $3 ))" \
    '{child: $c, parent: "ses_parent", title: $t, created: "2026-01-01T00:00:00Z", created_ms: $ms}' > "$home/owners/pending/$1.json"
}

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
  o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"p1","label":"Prefix node"}
{"op":"add","id":"amb","label":"Ambiguous node"}
{"op":"add","id":"chats","label":"Persistent chat turns"}
{"op":"add","id":"st","label":"Stall node"}
{"op":"add","id":"bz","label":"Busy node"}
{"op":"add","id":"x2","label":"Other model"}
{"op":"add","id":"um","label":"Umbrella one"}
{"op":"add","id":"mx","label":"Umbrella mixed"}
{"op":"update","id":"p1","status":"running","owner":"agent ses_aaaaaaaaaaaa1"}
{"op":"update","id":"amb","status":"running","owner":"agent ses_bbbbbbbbbbbb"}
{"op":"update","id":"chats","status":"running","owner":"agent restart-chats (spawned)"}
{"op":"update","id":"st","status":"running","owner":"ses_stallXXXXXXXXXXXXXXXXXXXXX"}
{"op":"update","id":"bz","status":"running","owner":"ses_busyoldXXXXXXXXXXXXXXXXXXX"}
{"op":"update","id":"x2","status":"running","owner":"coordinator"}
{"op":"report","id":"x2","model":"prov/other"}
{"op":"update","id":"um","status":"running","owner":"see p1 and chats"}
{"op":"update","id":"mx","status":"running","owner":"see p1 and x2"}
OPS
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
  t0=$(date +%s); wait_until "[ \"\$(date +%s)\" -gt $t0 ]" 5
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

  # actual_model: the session's real model next to the requested alias, which stays in `model`.
  expect_eq "actual: real model recorded" prov/changed "$(nf "$R" chats .actual_model)"
  expect_eq "actual: alias kept" prov/m1 "$(nf "$R" chats .model)"
  export ORCH_OPENCODE_DB=/nonexistent/opencode.db
else
  printf 'owner-bind: SKIP session table tests (no sqlite3)\n'
fi

printf 'owner-bind-c: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
