#!/usr/bin/env bash
# Tests for the owner binder and filler, part D: opencode session table: stale reports, sessions shared in a row or at once, hub actual model (split from owner-bind.test.sh).
# Run with: bash owner-bind-d.test.sh
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

  # A report figure captured from the session is not the coordinator's: a later `node report` without
  # --usd keeps it marked auto, and the newer session total replaces it.
  o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"rp","label":"Report node"}
{"op":"update","id":"rp","status":"running","owner":"ses_noiseXXXXXXXXXXXXXXXXXXXXX"}
OPS
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
  o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"seq1","label":"First in a row"}
{"op":"add","id":"seq2","label":"Second in a row"}
{"op":"update","id":"seq1","status":"running","owner":"ses_seqXXXXXXXXXXXXXXXXXXXXXXX"}
OPS
  o node update "$R" seq1 done >/dev/null
  expect_eq "seq: first final share" 4.11 "$(nf "$R" seq1 .session_stats.cost)"
  t0=$(date +%s); wait_until "[ \"\$(date +%s)\" -gt $t0 ]" 5
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
  o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"dup1","label":"First co-owner"}
{"op":"add","id":"dup2","label":"Second co-owner"}
{"op":"update","id":"dup1","status":"running","owner":"ses_dupXXXXXXXXXXXXXXXXXXXXXXX"}
{"op":"update","id":"dup2","status":"running","owner":"ses_dupXXXXXXXXXXXXXXXXXXXXXXX"}
OPS
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
    o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"auto","label":"Smart Auto node"}
{"op":"update","id":"auto","status":"running","owner":"ses_autoXXXXXXXXXXXXXXXXXXXXXX"}
OPS
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

printf 'owner-bind-d: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
