#!/usr/bin/env bash
# Tests for `run health` (lib/runs/health.sh), part c: deps and a user block set after the fact.
# Temp homes; opencode is a stub on PATH and its session table a temp sqlite file. Run with: bash health-c.test.sh
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

# 4b. deps and a user block set after the fact: node update --after / --needs-user / --after '*'
new_home
R=$(o run start "late deps")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"a","label":"a"}
{"op":"add","id":"b","label":"b"}
{"op":"add","id":"ask","label":"ask"}
{"op":"add","id":"gate","label":"gate"}
OPS
expect_eq "late: all four ready before the update" '["a","ask","b","gate"]' "$(hj "$R" | jq -c '.ready | sort')"
o node update "$R" b --after a >/dev/null
o node update "$R" ask --needs-user "pick the product name" >/dev/null
o node update "$R" gate --after '*' >/dev/null
out=$(hj "$R")
expect_eq "late: only a is ready" '["a"]' "$(printf '%s' "$out" | jq -c .ready)"
expect_eq "late: needs-user health" needs-user "$(health_of "$out" ask)"
expect_eq "late: needs-user note has the reason" 'needs the user: pick the product name' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "ask") | .note')"
expect_eq "late: gate waits on the other nodes" 'waiting on a,ask,b' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "gate") | .note')"
expect_eq "late: run sync agrees" 'ready: a' "$(o run sync "$R" --no-retry 2>/dev/null | grep '^ready:')"
expect_eq "late: events recorded" 3 "$(jq -s '[.[] | select(.kind == "deps" or .kind == "needs-user")] | length' "$home/runs/$R/events.jsonl")"
expect_exit "late: self dep refused" 2 "$(o node update "$R" a --after a >/dev/null 2>&1; echo $?)"
expect_exit "late: cycle refused" 2 "$(o node update "$R" a --after b >/dev/null 2>&1; echo $?)"
expect_exit "late: unknown dep refused" 2 "$(o node update "$R" a --after nope >/dev/null 2>&1; echo $?)"
o node update "$R" a done >/dev/null; o node update "$R" b done >/dev/null
o node update "$R" ask --clear-needs-user >/dev/null
expect_eq "late: cleared block makes it ready, gate still waits" '["ask"]' "$(hj "$R" | jq -c .ready)"
o node update "$R" ask skipped >/dev/null
expect_eq "late: gate ready once every other node is done or skipped" '["gate"]' "$(hj "$R" | jq -c .ready)"
o node update "$R" gate --after "" >/dev/null
expect_eq "late: --after '' clears the gate flag" false "$(jq '.nodes[] | select(.id == "gate") | .after_all' "$home/runs/$R/state.json")"
expect_exit "late: no status and no flag is a usage error" 2 "$(o node update "$R" gate >/dev/null 2>&1; echo $?)"
o node update "$R" gate running --needs-user "confirm" >/dev/null
expect_eq "late: status and block in one call" "running confirm" "$(jq -r '.nodes[] | select(.id == "gate") | "\(.status) \(.needs_user)"' "$home/runs/$R/state.json")"

cleanup_dir "$scratch"
finish
