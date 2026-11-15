#!/usr/bin/env bash
# Tests for `run health` (lib/health.sh): classification, ready nodes and slots, change-only events,
# the nudge and its rate limit, and the per-run health:<run> monitor (auto-start, interval, stop on a
# terminal run, --ensure-monitors after a kill). Temp homes; opencode is a stub on PATH and its
# session table a temp sqlite file. Run with: bash health.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-lib.sh"

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
for n in ok stall dead orphan idle; do o node add "$R" "$n" "$n" >/dev/null; done
o node update "$R" ok running --owner ses_busy1 >/dev/null
o node update "$R" stall running --owner ses_stall1 >/dev/null
o node update "$R" dead running --owner ses_gone99 >/dev/null
o node update "$R" orphan running >/dev/null
o node update "$R" idle running --owner ses_idle1 >/dev/null
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

# 4. ready nodes and slots
new_home
R=$(o run start "ready")
o node add "$R" a "A" >/dev/null
o node add "$R" b "B" --after a >/dev/null
o node add "$R" p "P" >/dev/null
o node add "$R" c "C" --after p >/dev/null
o node add "$R" free "Free" >/dev/null
o node update "$R" a done >/dev/null
o node update "$R" p running --owner ses_busy1 >/dev/null
out=$(hj "$R")
expect_eq "ready: deps done or none, pending deps excluded" '["b","free"]' "$(printf '%s' "$out" | jq -c '.ready')"
expect_eq "ready: slots = max_parallel - running" 3 "$(printf '%s' "$out" | jq .slots)"
expect_match "ready: pending dep named" 'waiting on p' "$(printf '%s' "$out" | jq -r '.nodes[] | select(.id == "c") | .note')"
expect_match "ready: change event" '"kind":"ready".*"note":"ready: b,free"' "$out"
for n in x1 x2 x3; do o node add "$R" "$n" "$n" >/dev/null; o node update "$R" "$n" running --owner ses_busy1 >/dev/null; done
out=$(hj "$R")
expect_eq "slots full: 0" 0 "$(printf '%s' "$out" | jq .slots)"
expect_eq "slots full: ready still listed" '["b","free"]' "$(printf '%s' "$out" | jq -c '.ready')"
expect_no_match "ready: an unchanged ready set is not a new change" '"kind":"ready"' "$out"
o node update "$R" p done >/dev/null
expect_match "ready: only the newly ready node is the change" '"note":"ready: c"' "$(hj "$R")"
o run finish "$R" >/dev/null 2>&1

# 4b. deps and a user block set after the fact: node update --after / --needs-user / --after '*'
new_home
R=$(o run start "late deps")
for n in a b ask gate; do o node add "$R" "$n" "$n" >/dev/null; done
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
sleep 13
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

# 6. usage
expect_exit "usage: no run id" 2 "$(o run health >/dev/null 2>&1; echo $?)"
expect_exit "usage: unknown run" 2 "$(o run health nope >/dev/null 2>&1; echo $?)"

cleanup_dir "$scratch"
finish
