#!/usr/bin/env bash
# Tests for `run health` (lib/runs/health.sh), part e: the per-run health:<run> monitor (auto-start, interval, stop on a terminal run, --ensure-monitors).
# Temp homes; opencode is a stub on PATH and its session table a temp sqlite file. Run with: bash health-e.test.sh
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

# 5. the monitor: auto-start with the interval, change-only events, stop on a terminal run, ensure after a kill
new_home
export ORCH_HEALTH_MONITOR=1 ORCH_HEALTH_EVERY_SEC=12
R=$(o run start "monitored")
active=$(o active --json)
expect_eq "monitor: started by run start" "health:$R" "$(printf '%s' "$active" | jq -r '.[] | select(.kind == "watch") | .name')"
expect_eq "monitor: interval from ORCH_HEALTH_EVERY_SEC" 12 "$(printf '%s' "$active" | jq -r '.[0].interval')"
expect_match "monitor: start is an event" 'monitor started' "$(cat "$home/runs/$R/events.jsonl")"
o run start "monitored" --id "$R" >/dev/null 2>&1
expect_eq "monitor: one per run" 1 "$(o active --json | jq '[.[] | select(.name == "health:'"$R"'")] | length')"
o node add "$R" n1 "N1" >/dev/null
wait_until "grep -q 'ready: n1' '$home/runs/$R/events.jsonl'" 60
expect_match "monitor: change event recorded" '"note":"ready: n1"' "$(cat "$home/runs/$R/events.jsonl")"
# Wait for the next tick instead of a fixed sleep: move the pass's skip key away, so the next tick
# runs a full pass (against the saved snapshot) and writes the key again.
mv_key_after_tick() { ! pgrep -f "run health $R --monitor" >/dev/null && [ -f "$home/health/$R.key" ] && mv "$home/health/$R.key" "$scratch/health-key-$$"; }
wait_until mv_key_after_tick 30
wait_until "[ -f '$home/health/$R.key' ]" 40
expect_eq "monitor: no event on an unchanged tick" 1 "$(jq -s '[.[] | select(.kind == "health" and .note == "ready: n1")] | length' "$home/runs/$R/events.jsonl")"
wid=$(o active --json | jq -r '.[0].id')
kill -9 -- "-$(jq -r .pid "$home/watches/$wid/state.json")" 2>/dev/null
out=$(o run health --ensure-monitors)
expect_match "ensure: recreates a SIGKILLed monitor" "^started watch-.* for $R" "$out"
expect_match "ensure: the killed monitor is recorded dead" '^dead process' "$(jq -r '.status+" "+.reason' "$home/watches/$wid/state.json")"
expect_match "ensure: the dead monitor is a run event" "monitor $wid dead" "$(cat "$home/runs/$R/events.jsonl")"
expect_eq "ensure: second call is a no-op" "" "$(o run health --ensure-monitors)"
# A corrupt state.json in another run must not hide this one, and racing ensures start one monitor.
mkdir -p "$home/runs/0000-bad" && printf '{bad' > "$home/runs/0000-bad/state.json"
wid=$(o active --json | jq -r '[.[] | select(.status == "running")][0].id')
kill -TERM -- "-$(jq -r .pid "$home/watches/$wid/state.json")" 2>/dev/null
wait_until "[ \"\$(o active --json | jq '[.[] | select(.status == \"running\")] | length')\" = 0 ]" 20
o run health --ensure-monitors >/dev/null & o run health --ensure-monitors >/dev/null & o run health --ensure-monitors >/dev/null & wait
expect_eq "ensure: corrupt neighbour skipped, racing calls start exactly one" 1 \
  "$(o active --json | jq '[.[] | select(.status == "running" and .name == "health:'"$R"'")] | length')"
mv "$home/runs/0000-bad" "$scratch/bad-run-$$"
o run finish "$R" >/dev/null 2>&1
wait_until "[ \"\$(o active --json | jq '[.[] | select(.status == \"running\")] | length')\" = 0 ]" 60
expect_eq "monitor: stops when the run is terminal" 0 "$(o active --json | jq '[.[] | select(.status == "running")] | length')"
expect_match "monitor: stop is an event" 'monitor stopped \(run done\)' "$(cat "$home/runs/$R/events.jsonl")"
ORCH_HEALTH_EVERY_SEC=3 o run start "fast" >/dev/null
expect_eq "interval: floor of 10 s" 10 "$(o active --json | jq -r '[.[] | select(.status == "running")][0].interval')"
for w in "$home"/watches/*/; do o watch stop "$(basename "$w")" >/dev/null 2>&1; done
export ORCH_HEALTH_MONITOR=0
unset ORCH_HEALTH_EVERY_SEC

cleanup_dir "$scratch"
finish
