#!/usr/bin/env bash
# Tests for `run health` (lib/runs/health.sh), part d: a coordinator hold, 120 nodes, a corrupt state.json, usage.
# Temp homes; opencode is a stub on PATH and its session table a temp sqlite file. Run with: bash health-d.test.sh
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

# 4b2. a coordinator hold: --hold keeps a ready node out of ready, shows as held; running clears it
new_home
R=$(o run start "holds")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"h1","label":"h1"}
{"op":"add","id":"h2","label":"h2"}
OPS
o node update "$R" h1 --hold "until load < 4" >/dev/null
out=$(hj "$R")
expect_eq "hold: held node not ready" '["h2"]' "$(printf '%s' "$out" | jq -c .ready)"
expect_eq "hold: health held" held "$(health_of "$out" h1)"
expect_eq "hold: note has the reason" 'held: until load < 4' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "h1") | .note')"
expect_match "hold: text report lists it" '^held: h1 — held: until load < 4$' "$(o run health "$R" 2>/dev/null)"
expect_eq "hold: run sync agrees" 'ready: h2' "$(o run sync "$R" --no-retry 2>/dev/null | grep '^ready:')"
expect_eq "hold: event recorded" 'until load < 4' "$(jq -rs '[.[] | select(.kind == "hold")][0].note' "$home/runs/$R/events.jsonl")"
expect_exit "hold: empty reason refused" 2 "$(o node update "$R" h1 --hold "" >/dev/null 2>&1; echo $?)"
o node update "$R" h2 --needs-user "pick" --hold "later" >/dev/null
expect_eq "hold: needs-user wins over held" needs-user "$(health_of "$(hj "$R")" h2)"
o node update "$R" h1 --clear-hold >/dev/null
expect_eq "hold: cleared hold is ready again" '["h1"]' "$(hj "$R" | jq -c .ready)"
expect_eq "hold: cleared event" 'cleared' "$(jq -rs '[.[] | select(.kind == "hold")] | last | .note' "$home/runs/$R/events.jsonl")"
o node update "$R" h1 --hold "wait" >/dev/null
o node update "$R" h1 running --owner coordinator >/dev/null
expect_eq "hold: running clears the hold" null "$(jq '.nodes[] | select(.id == "h1") | .hold' "$home/runs/$R/state.json")"

# 4c. 120 nodes: one pass stays one jq call and stays fast
new_home
R=$(o run start "big")
{ for i in $(seq 1 120); do printf '{"op":"add","id":"n%s","label":"n%s"%s}\n' "$i" "$i" "$([ "$i" -gt 1 ] && printf ',"after":"n%s"' $((i - 1)))"; done; } \
  | o node batch "$R" >/dev/null 2>&1
t0=$(date +%s)
out=$(hj "$R")
expect_eq "big: 120 nodes reported" 120 "$(printf '%s' "$out" | jq '.nodes | length')"
expect_eq "big: one ready" '["n1"]' "$(printf '%s' "$out" | jq -c .ready)"
expect_eq "big: pass under 10 s" 1 "$([ $(( $(date +%s) - t0 )) -lt 10 ] && echo 1 || echo 0)"

# 4d. a corrupt state.json fails the pass cleanly (no snapshot overwrite, non-zero exit)
printf '{bad' > "$home/runs/$R/state.json"
expect_exit "corrupt: run health fails" 1 "$(hj "$R" >/dev/null 2>&1; echo $?)"
expect_eq "corrupt: the last good snapshot is kept" 120 "$(jq '.nodes | length' "$home/health/$R.json")"

# 6. usage
expect_exit "usage: no run id" 2 "$(o run health >/dev/null 2>&1; echo $?)"
expect_exit "usage: unknown run" 2 "$(o run health nope >/dev/null 2>&1; echo $?)"

cleanup_dir "$scratch"
finish
