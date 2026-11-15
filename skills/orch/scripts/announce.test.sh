#!/usr/bin/env bash
# Tests for announce.sh. Run with: bash announce.test.sh
set -u
# The hook would start an announce daemon that inherits the fake herdr and ticks into the 1.5 s
# assertion windows below. announce-daemon.test.sh covers the daemon.
export ANNOUNCE_NO_DAEMON=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANN="$SCRIPT_DIR/announce.sh"; DISP="$SCRIPT_DIR/dispatch.sh"
failures=0; pass_count=0
expect_match() {
  if printf '%s' "$3" | grep -qE -e "$2"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected: %s\n  got:\n%s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}
expect_exit() { [ "$2" = "$3" ] && { pass_count=$((pass_count + 1)); return; }; printf 'FAIL: %s want %s got %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1)); }

mk() { T=$(mktemp -d); H="$T/home"; O="$T/orch"; mkdir -p "$H" "$O"; CALLS="$T/calls"; : > "$CALLS"
  FAKE="$T/herdr"; printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nif [ "$1 $2" = "pane current" ]; then echo %s; fi\n%s\n' "$CALLS" "'{\"result\":{\"pane\":{\"agent\":\"opencode\"}}}'" "${FAKE_TAIL:-exit 0}" > "$FAKE"; chmod +x "$FAKE"; }
ann() { HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_ENV=1 HERDR_PANE_ID=p1 HERDR_BIN_PATH="$FAKE" CLAUDE_CODE_SESSION_ID=sess1 bash "$ANN" "$@"; }
seed_run() { mkdir -p "$O/runs/r1"; cat > "$O/runs/r1/state.json" <<J
{"run_id":"r1","status":"running","nodes":[{"id":"a","status":"done"},{"id":"b","status":"running"},{"id":"c","status":"running"},{"id":"d","status":"waiting"}]}
J
}
seed_loop() { mkdir -p "$O/loops/$1"; printf '{"status":"running","pid":%s}' "$2" > "$O/loops/$1/state.json"; }
seed_watch() { mkdir -p "$O/watches/$1"; printf '{"status":"running","pid":%s}' "$2" > "$O/watches/$1/state.json"; }

# nothing running
mk; ann --quiet; rc=$?
expect_exit "exit 0 idle" 0 "$rc"
expect_match "idle writes active:false" '"active":false' "$(cat "$O/activity/sess1.json")"
expect_match "idle clears herdr" 'clear-state-labels.*clear-token orch' "$(cat "$CALLS")"
expect_match "claude file active false" '"active":false' "$(cat "$H/.claude/workflow-active/sess1")"

# running nodes, live loop, dead loop, live watch
mk; seed_run; sleep 900 & P=$!; seed_loop l1 "$P"; seed_loop l2 999999; seed_watch w1 "$P"; seed_watch w2 "$P"
ann --quiet --ttl-sec 45
j=$(cat "$O/activity/sess1.json")
expect_match "counts" '"running":2,"done":1,"total":4' "$j"
expect_match "summary text" 'orch: 2 running, 1/4 done · 1 loop · 2 monitors' "$j"
expect_match "dead loop ignored" '^true$' "$(printf '%s' "$j" | jq -r '(.summary|contains("loops"))|not')"
expect_match "ttl passed" 'ttl-ms 45000' "$(cat "$CALLS")"
expect_match "agent label from pane" '--agent opencode' "$(cat "$CALLS")"
expect_match "source" '--source user:orch' "$(cat "$CALLS")"
expect_match "no report-agent" '^0$' "$(grep -c report-agent "$CALLS")"
expect_match "mode 0600" '^600$' "$(stat -f %Lp "$O/activity/sess1.json" 2>/dev/null || stat -c %a "$O/activity/sess1.json")"
expect_match "no tmp left" '^0$' "$(ls -A "$O/activity" | grep -c '^\.tmp')"
expect_match "workflow file active" '"active":true' "$(cat "$H/.claude/workflow-active/sess1")"
kill $P 2>/dev/null; wait $P 2>/dev/null

# --run filter
mk; seed_run; ann --quiet --run nope
expect_match "other run filtered" '"active":false' "$(cat "$O/activity/sess1.json")"

# outside herdr
mk; seed_run; env -u HERDR_ENV -u HERDR_PANE_ID HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_BIN_PATH="$FAKE" CLAUDE_CODE_SESSION_ID=s bash "$ANN" --quiet
expect_match "no herdr call outside herdr" '^0$' "$(wc -l < "$CALLS" | tr -d ' ')"

# failing herdr
FAKE_TAIL='exit 3'; mk; seed_run; ann --quiet; rc=$?
expect_exit "failing herdr exit 0" 0 "$rc"
# hanging herdr
FAKE_TAIL='exec sleep 20'; mk; seed_run; s=$(date +%s); ANNOUNCE_HERDR_TIMEOUT=1 ann --quiet; rc=$?; e=$(date +%s)
expect_exit "hanging herdr exit 0" 0 "$rc"
expect_match "hang bounded" '^([0-9]|[12][0-9])$' "$((e - s))"
unset FAKE_TAIL

# dry-run
mk; seed_run; o=$(ann --dry-run)
expect_match "dry shows herdr cmd" 'report-metadata p1 .*--ttl-ms 120000' "$o"
expect_match "dry shows file" 'file: .*activity/sess1.json' "$o"
expect_match "dry sends nothing" '^0$' "$(grep -c report-metadata "$CALLS")"
expect_match "dry writes nothing" '^0$' "$(ls "$O/activity" 2>/dev/null | wc -l | tr -d ' ')"
[ -z "$(ann --dry-run --quiet)" ] && pass_count=$((pass_count + 1)) || { echo "FAIL: quiet prints" >&2; failures=$((failures + 1)); }

# bounded summary with many nodes
mk; mkdir -p "$O/runs/big"; jq -nc '{status:"running",nodes:[range(0;500)|{id:("n\(.)"),status:"running"}]}' > "$O/runs/big/state.json"; ann --quiet
expect_match "summary bounded" '^[0-9]{1,3}$' "$(jq -r '.summary|length' "$O/activity/sess1.json")"

# real state through dispatch.sh
mk; R=$(HARNESS_ORCH_HOME="$O" bash "$DISP" run start "real" 2>/dev/null)
HARNESS_ORCH_HOME="$O" bash "$DISP" node add "$R" a "A" >/dev/null 2>&1
HARNESS_ORCH_HOME="$O" bash "$DISP" node add "$R" b "B" >/dev/null 2>&1
HARNESS_ORCH_HOME="$O" bash "$DISP" node update "$R" a running >/dev/null 2>&1
HARNESS_ORCH_HOME="$O" bash "$DISP" node update "$R" a done >/dev/null 2>&1
HARNESS_ORCH_HOME="$O" bash "$DISP" node update "$R" b running >/dev/null 2>&1
ann --quiet --run "$R"
expect_match "reads real dispatch state" 'orch: 1 running, 1/2 done' "$(cat "$O/activity/sess1.json")"

# --clear
mk; seed_run; ann --quiet --clear
expect_match "clear forces inactive" '"active":false' "$(cat "$O/activity/sess1.json")"

# loop states: only a live running loop counts
mk; sleep 900 & P=$!
seed_loop live "$P"
for st in stopped done failed; do mkdir -p "$O/loops/$st"; printf '{"status":"%s","pid":%s}' "$st" "$P" > "$O/loops/$st/state.json"; done
seed_loop dead 999999
ann --quiet
expect_match "only the live loop counts" 'orch: 0 running, 0/0 done · 1 loop$' "$(jq -r .summary "$O/activity/sess1.json")"
kill $P 2>/dev/null; wait $P 2>/dev/null
expect_match "announce reads the same dirs as loops.sh" '^LOOPS_HOME="\$ORCH_HOME/loops"$' "$(grep '^LOOPS_HOME=' "$SCRIPT_DIR/lib/loops.sh")"
expect_match "announce reads the same watch dir" '^WATCHES_HOME="\$ORCH_HOME/watches"$' "$(grep '^WATCHES_HOME=' "$SCRIPT_DIR/lib/loops.sh")"

# hook: a mutating command announces in the background
hk() { env -u ORCH_NO_ANNOUNCE HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_ENV=1 HERDR_PANE_ID=p1 HERDR_BIN_PATH="$FAKE" CLAUDE_CODE_SESSION_ID=sess1 bash "$DISP" "$@"; }
waitcalls() { local i=0; while [ $i -lt 40 ]; do grep -q report-metadata "$CALLS" && return 0; sleep 0.25; i=$((i + 1)); done; return 1; }
mk; ORCH_NO_ANNOUNCE=1 HOME="$H" HARNESS_ORCH_HOME="$O" bash "$DISP" init >/dev/null 2>&1; R=$(hk run start "hook" 2>/dev/null); waitcalls
expect_match "run start announces" 'report-metadata p1' "$(cat "$CALLS")"
hk node add "$R" a "A" >/dev/null 2>&1; sleep 1; : > "$CALLS"; printf '%s\n' "$(( $(date +%s) + 60 ))" > "$O/.announce-ts"
hk node update "$R" a running >/dev/null 2>&1; rc=$?
sleep 1
expect_exit "hook keeps exit code" 0 "$rc"
expect_match "debounced: no second announce within 5s" '^0$' "$(grep -c report-metadata "$CALLS")"
printf '%s\n' "$(( $(date +%s) - 10 ))" > "$O/.announce-ts"
hk node ping "$R" a --note x >/dev/null 2>&1; waitcalls
expect_match "node ping announces after debounce window" 'orch: 1 running' "$(cat "$CALLS")"
: > "$CALLS"; printf '0\n' > "$O/.announce-ts"
env ORCH_NO_ANNOUNCE=1 HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_ENV=1 HERDR_PANE_ID=p1 HERDR_BIN_PATH="$FAKE" CLAUDE_CODE_SESSION_ID=sess1 bash "$DISP" node ping "$R" a --note y >/dev/null 2>&1; sleep 1.5
expect_match "ORCH_NO_ANNOUNCE suppresses the hook" '^0$' "$(grep -c report-metadata "$CALLS")"
env -u ORCH_NO_ANNOUNCE -u HERDR_ENV -u CLAUDE_CODE_SESSION_ID -u OPENCODE_SESSION_ID HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_BIN_PATH="$FAKE" bash "$DISP" node ping "$R" a --note z >/dev/null 2>&1; sleep 1.5
expect_match "no Herdr and no session id is a no-op" '^0$' "$(grep -c report-metadata "$CALLS")"
expect_match "announce subcommand dry-run" 'orch: 1 running' "$(env -u ORCH_NO_ANNOUNCE HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_ENV=1 HERDR_PANE_ID=p1 HERDR_BIN_PATH="$FAKE" CLAUDE_CODE_SESSION_ID=sess1 bash "$DISP" announce --dry-run)"

# watch keeps refreshing and carries the HERDR_* env
: > "$CALLS"; rm_ts() { printf '0\n' > "$O/.announce-ts"; }; rm_ts
W=$(env -u ORCH_NO_ANNOUNCE HOME="$H" HARNESS_ORCH_HOME="$O" HERDR_ENV=1 HERDR_PANE_ID=p1 HERDR_BIN_PATH="$FAKE" HERDR_SOCKET_PATH=/tmp/x.sock CLAUDE_CODE_SESSION_ID=sess1 \
  bash "$DISP" watch start --name envcheck --every 10s "env | grep '^HERDR_' | sort | tr '\n' ' '; bash $DISP run sync $R" 2>/dev/null)
i=0; while [ $i -lt 80 ] && ! grep -q HERDR_ "$O"/watches/*/events.jsonl 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
env_line=$(cat "$O"/watches/*/events.jsonl 2>/dev/null | tr '\n' ' ')
expect_match "watch env has HERDR_ENV, PANE_ID, BIN_PATH, SOCKET_PATH" 'HERDR_BIN_PATH=.*HERDR_ENV=1.*HERDR_PANE_ID=p1.*HERDR_SOCKET_PATH=/tmp/x.sock' "$env_line"
i=0; while [ $i -lt 120 ] && [ "$(grep -c report-metadata "$CALLS")" -lt 2 ]; do sleep 0.5; i=$((i + 1)); done
n=$(grep -c report-metadata "$CALLS")
expect_match "watch refreshed at least twice" '^([2-9]|[1-9][0-9])$' "$n"
env HOME="$H" HARNESS_ORCH_HOME="$O" bash "$DISP" watch stop "$W" >/dev/null 2>&1

printf 'announce tests: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
