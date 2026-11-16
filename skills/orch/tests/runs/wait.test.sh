#!/usr/bin/env bash
# Tests for `run wait` (lib/runs/wait.sh), the coordinator wake-up: a status change, needs-user, the
# timeout, --follow and --json, and stall / dead-owner detection over a fake opencode session store
# read without the sqlite3 CLI. Temp homes only. Run with: bash wait.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

scratch=$(new_tmp)
home=$(new_tmp); seed_home "$home"
export HARNESS_ORCH_HOME="$home" ORCH_WAIT_POLL_SECS=1 ORCH_HEALTH_MONITOR=0 ORCH_OWNER_CACHE_SECS=0
export ORCH_OPENCODE_DB="$scratch/none.db"
o() { bash "$SCRIPT" "$@"; }
cursor_of() { printf '%s/runs/%s/wait.cursor' "$home" "$1"; }
# after_cursor <run> <cmd...>: runs the command in the background once the wait has its snapshot.
after_cursor() {
  local f; f=$(cursor_of "$1"); shift
  ( for _ in $(seq 1 300); do [ -f "$f" ] && break; sleep 0.3; done; "$@" >/dev/null 2>&1 ) &
}

# 1. a status change wakes the wait, and the report names from -> to
R=$(o run start "wait")
o node add "$R" a "A" >/dev/null; o node add "$R" b "B" --after a >/dev/null; o node add "$R" w "W" >/dev/null
o node update "$R" a running --owner coordinator >/dev/null
o node update "$R" w running --owner coordinator >/dev/null
after_cursor "$R" o node update "$R" a done
out=$(o run wait "$R" --timeout 60); rc=$?
wait
expect_exit "change: exit 0" 0 "$rc"
expect_match "change: from -> to" '^a running->done$' "$out"
expect_match "change: the dependent became ready" '^ready: b$' "$out"

# 2. nothing new: --timeout ends with 124 and "no change"
out=$(o run wait "$R" --timeout 2); rc=$?
expect_exit "timeout: exit 124" 124 "$rc"
expect_match "timeout: says no change" '^no change' "$out"

# 3. needs-user wakes the wait (the event, and a state-only edit caught by the snapshot diff)
o node update "$R" b running --owner coordinator >/dev/null
o run wait "$R" --timeout 5 >/dev/null 2>&1
o node add "$R" q "Q" >/dev/null
o run wait "$R" --timeout 5 >/dev/null 2>&1
after_cursor "$R" o node update "$R" q --needs-user "pick a database"
out=$(o run wait "$R" --timeout 60); rc=$?
wait
expect_exit "needs-user: exit 0" 0 "$rc"
expect_match "needs-user: reason" '^q needs-user: pick a database$' "$out"
expect_no_match "needs-user: reported once" 'needs-user.*needs-user' "$(printf '%s' "$out" | tr '\n' ' ')"
o run wait "$R" --timeout 2 >/dev/null 2>&1; expect_exit "needs-user: not repeated" 124 "$?"

# 4. --follow prints one line per event and ends with the run; --json is one object per line
log="$scratch/follow.log"
o run wait "$R" --follow --json --timeout 120 > "$log" 2>&1 &
fpid=$!
# The cursor already holds the last wait's position, so events before this process starts are kept.
o node update "$R" w done >/dev/null
wait_until "grep -q '\"node\":\"w\"' '$log'" 60
o node update "$R" b error --error boom >/dev/null
wait_until "grep -q '\"node\":\"b\"' '$log'" 60
o node update "$R" q --clear-needs-user >/dev/null
o node update "$R" q skipped >/dev/null
o run finish "$R" --status done >/dev/null 2>&1
wait_until "! kill -0 $fpid" 60
wait "$fpid"; rc=$?
expect_exit "follow: ends 0 with the run" 0 "$rc"
expect_match "follow: w done" '"kind":"status","node":"w","from":"running","to":"done"' "$(cat "$log")"
expect_match "follow: b error with the reason" '"node":"b".*"to":"error","note":"boom"' "$(cat "$log")"
expect_match "follow: run ended" '"kind":"run-ended"' "$(cat "$log")"
expect_match "follow: several events" '^[3-9]|^[1-9][0-9]' "$(wc -l < "$log" | tr -d ' ')"
expect_match "follow: every line is JSON" '^true$' "$(jq -s 'all(.[]; has("kind") and has("run"))' "$log" 2>&1)"

# 5. stall and dead owner from opencode's session table, read with no sqlite3 CLI (python3/bun)
export ORCH_OPENCODE_DB="$scratch/opencode.db" ORCH_SQLITE3="$scratch/no-sqlite3"
now_ms=$(( $(date +%s) * 1000 )); old_ms=$(( now_ms - 40 * 60 * 1000 ))
python3 - "$ORCH_OPENCODE_DB" "$now_ms" "$old_ms" <<'PY'
import sqlite3, sys
db, now, old = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
c = sqlite3.connect(db)
c.execute("""create table session_v2 (id text primary key, parent_id text, title text, model text,
  cost real default 0, tokens_input integer default 0, tokens_output integer default 0, tokens_reasoning integer default 0,
  tokens_cache_read integer default 0, tokens_cache_write integer default 0, time_created integer, time_updated integer,
  time_busy integer, time_idle integer)""")
c.executemany("insert into session_v2 (id, title, time_created, time_updated, time_busy, time_idle) values (?,?,?,?,?,?)",
  [("ses_busy1", "busy", old, now, now, None), ("ses_stall1", "stalled", old, old, old, None)])
c.commit()
PY
S=$(o run start "stall")
o node add "$S" ok "ok" >/dev/null; o node add "$S" st "st" >/dev/null; o node add "$S" dg "dg" >/dev/null
o node update "$S" ok running --owner ses_busy1 >/dev/null
o node update "$S" st running --owner ses_stall1 >/dev/null
o node update "$S" dg running --owner ses_gone99 >/dev/null
out=$(o run wait "$S" --timeout 60 --stall-min 60); rc=$?
expect_exit "stall: the dead owner wakes even with a high --stall-min" 0 "$rc"
expect_match "stall: dead owner" '^dg dead: session ses_gone99 is gone$' "$out"
expect_no_match "stall: --stall-min 60 keeps a 40 min quiet node ok" '^st stalled' "$out"
out=$(o run wait "$S" --timeout 60); rc=$?
expect_exit "stall: exit 0" 0 "$rc"
expect_match "stall: quiet session is stalled" '^st stalled: no activity since [0-9]{2}:[0-9]{2}$' "$out"
expect_no_match "stall: the busy session is not" '^ok ' "$out"
out=$(o run wait "$S" --timeout 3 --json); rc=$?
expect_exit "stall: not reported twice" 124 "$rc"
expect_match "stall: json timeout object" '"kind":"timeout"' "$out"

# 6. bad arguments
o run wait "$S" --stall-min 0 >/dev/null 2>&1; expect_exit "args: --stall-min 0 refused" 2 "$?"
o run wait "$S" --bogus >/dev/null 2>&1; expect_exit "args: unknown flag refused" 2 "$?"

cleanup_dir "$scratch"; cleanup_dir "$home"
finish
