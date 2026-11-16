#!/usr/bin/env bash
# Tests for `run health` (lib/runs/health.sh), part a: classification, change-only events, the nudge and its rate limit.
# Temp homes; opencode is a stub on PATH and its session table a temp sqlite file. Run with: bash health-a.test.sh
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

# 1. classification: ok, stalled, dead, unowned, no-report
new_home
R=$(o run start "health")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"ok","label":"ok"}
{"op":"add","id":"stall","label":"stall"}
{"op":"add","id":"dead","label":"dead"}
{"op":"add","id":"orphan","label":"orphan"}
{"op":"add","id":"idle","label":"idle"}
{"op":"update","id":"ok","status":"running","owner":"ses_busy1"}
{"op":"update","id":"stall","status":"running","owner":"ses_stall1"}
{"op":"update","id":"dead","status":"running","owner":"ses_gone99"}
{"op":"update","id":"orphan","status":"running"}
{"op":"update","id":"idle","status":"running","owner":"ses_idle1"}
OPS
out=$(hj "$R")
expect_eq "class: busy session is ok" ok "$(health_of "$out" ok)"
expect_eq "class: quiet session is stalled" stalled "$(health_of "$out" stall)"
expect_eq "class: missing session is dead" dead "$(health_of "$out" dead)"
expect_eq "class: no owner, no job is unowned" unowned "$(health_of "$out" orphan)"
expect_eq "class: idle unreported session is no-report" no-report "$(health_of "$out" idle)"
expect_match "class: stalled note has the time" 'no activity since [0-9]{2}:[0-9]{2}' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "stall") | .note')"
expect_eq "class: owner_id" ses_stall1 "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "stall") | .owner_id')"
expect_eq "class: idle_min >= 40" true "$(printf '%s' "$out" | jq '.nodes[] | select(.id == "stall") | .idle_min >= 40')"
expect_eq "class: contract keys" '["at","changes","max_parallel","nodes","ready","run","running","slots"]' \
  "$(printf '%s' "$out" | jq -c 'del(.status, .would_nudge) | keys')"
expect_eq "class: running 5, max 4, slots 0" "5 4 0" "$(printf '%s' "$out" | jq -r '"\(.running) \(.max_parallel) \(.slots)"')"
expect_eq "class: dry run lists the stalled session" '["stall"]' "$(printf '%s' "$out" | jq -c .would_nudge)"
expect_eq "class: dry run sends nothing" 0 "$( [ -f "$scratch/calls" ] && grep -c prompt "$scratch/calls" || echo 0)"
text=$(o run health "$R")
expect_match "text: header" 'running 5/4, slots 0' "$text"
expect_match "text: stalled line" '^stalled: stall \(ses_stall1\)' "$text"

# 2. change-only events: the first pass records each problem once, a repeat pass records nothing
first=$(health_events "$R")
expect_eq "events: one per problem node on the first pass" 4 "$first"
hj "$R" >/dev/null
hj "$R" >/dev/null
expect_eq "events: repeat passes add none" "$first" "$(health_events "$R")"
expect_eq "events: repeat pass reports no changes" '[]' "$(hj "$R" | jq -c .changes)"
o node update "$R" orphan done >/dev/null
out=$(hj "$R")
expect_match "events: a finished node is a change" '"kind":"finished","node":"orphan"' "$out"
expect_eq "events: exactly one more event" "$((first + 1))" "$(health_events "$R")"

# 3. nudge: sent once, recorded as a node event, not again within 30 min
: > "$scratch/calls"
out=$(o run health "$R" --nudge 2>&1)
expect_match "nudge: posted to the prompt endpoint" 'api POST /api/session/ses_stall1/prompt --data' "$(cat "$scratch/calls")"
expect_match "nudge: message text" 'You stopped mid-task at [0-9]{2}:[0-9]{2}\. Continue the task to completion and reply only with the final report\.' "$(cat "$scratch/calls")"
expect_eq "nudge: only the stalled opencode session" 1 "$(grep -c prompt "$scratch/calls")"
expect_eq "nudge: node event" 1 "$(jq -s '[.[] | select(.kind == "nudge" and .node == "stall" and .by == "health")] | length' "$home/runs/$R/events.jsonl")"
o run health "$R" --nudge >/dev/null 2>&1
o run health "$R" --nudge >/dev/null 2>&1
expect_eq "nudge: rate limited to once per 30 min" 1 "$(grep -c prompt "$scratch/calls")"
ORCH_HEALTH_NUDGE_GAP_SECS=0 o run health "$R" --nudge >/dev/null 2>&1
expect_eq "nudge: sent again once the gap has passed" 2 "$(grep -c prompt "$scratch/calls")"


cleanup_dir "$scratch"
finish
