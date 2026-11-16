#!/usr/bin/env bash
# Tests for `run health` (lib/runs/health.sh), part b: ready nodes and slots.
# Temp homes; opencode is a stub on PATH and its session table a temp sqlite file. Run with: bash health-b.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

expect_eq() {
  if [ "$2" = "$3" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}

scratch=$(new_tmp)
mkdir -p "$scratch/bin"
export FAKE_DIR="$scratch"
cat > "$scratch/bin/opencode" <<'EOS'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
echo '{"data":{"id":"msg_1"}}'
EOS
chmod +x "$scratch/bin/opencode"
export PATH="$scratch/bin:$PATH"

# opencode's session table, as owners.sh reads it (read-only).
export ORCH_OPENCODE_DB="$scratch/opencode.db"
now_ms=$(( $(date +%s) * 1000 ))
old_ms=$(( now_ms - 40 * 60 * 1000 ))
sqlite3 "$ORCH_OPENCODE_DB" "create table session_v2 (id text primary key, parent_id text, title text, model text,
  cost real default 0, tokens_input integer default 0, tokens_output integer default 0, tokens_reasoning integer default 0,
  tokens_cache_read integer default 0, tokens_cache_write integer default 0, time_created integer, time_updated integer,
  time_busy integer, time_idle integer);
  insert into session_v2 (id, title, time_created, time_updated, time_busy, time_idle) values
  ('ses_busy1', 'busy', $old_ms, $now_ms, $now_ms, null),
  ('ses_stall1', 'stalled', $old_ms, $old_ms, $old_ms, null),
  ('ses_idle1', 'idle', $old_ms, $now_ms, $((now_ms - 5000)), $now_ms);"

export ORCH_OWNER_CACHE_SECS=0 ORCH_HEALTH_MONITOR=0
new_home() { home=$(new_tmp); seed_home "$home"; export HARNESS_ORCH_HOME="$home"; }
o() { bash "$SCRIPT" "$@"; }
hj() { o run health "$1" --json; }
health_of() { printf '%s' "$1" | jq -r --arg n "$2" '.nodes[] | select(.id == $n) | .health'; }
health_events() { jq -s '[.[] | select(.kind == "health")] | length' "$home/runs/$1/events.jsonl"; }

# 4. ready nodes and slots
new_home
R=$(o run start "ready")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"a","label":"A"}
{"op":"add","id":"b","label":"B","after":"a"}
{"op":"add","id":"p","label":"P"}
{"op":"add","id":"c","label":"C","after":"p"}
{"op":"add","id":"free","label":"Free"}
{"op":"update","id":"a","status":"done"}
{"op":"update","id":"p","status":"running","owner":"ses_busy1"}
OPS
out=$(hj "$R")
expect_eq "ready: deps done or none, pending deps excluded" '["b","free"]' "$(printf '%s' "$out" | jq -c '.ready')"
expect_eq "ready: slots = max_parallel - running" 3 "$(printf '%s' "$out" | jq .slots)"
expect_match "ready: pending dep named" 'waiting on p' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "c") | .note')"
expect_match "ready: change event" '"kind":"ready".*"note":"ready: b,free"' "$out"
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"x1","label":"x1"}
{"op":"update","id":"x1","status":"running","owner":"ses_busy1"}
{"op":"add","id":"x2","label":"x2"}
{"op":"update","id":"x2","status":"running","owner":"ses_busy1"}
{"op":"add","id":"x3","label":"x3"}
{"op":"update","id":"x3","status":"running","owner":"ses_busy1"}
OPS
out=$(hj "$R")
expect_eq "slots full: 0" 0 "$(printf '%s' "$out" | jq .slots)"
expect_eq "slots full: ready still listed" '["b","free"]' "$(printf '%s' "$out" | jq -c '.ready')"
expect_no_match "ready: an unchanged ready set is not a new change" '"kind":"ready"' "$out"
o node update "$R" p done >/dev/null
expect_match "ready: only the newly ready node is the change" '"note":"ready: c"' "$(hj "$R")"
o run finish "$R" >/dev/null 2>&1


cleanup_dir "$scratch"
finish
