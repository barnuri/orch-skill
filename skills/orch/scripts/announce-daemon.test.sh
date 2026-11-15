#!/usr/bin/env bash
# Tests for announce.sh --daemon (freshness without dispatch.sh) and the single-flight locks.
# Self-contained; run with: bash announce-daemon.test.sh
set -u
export ORCH_NO_ANNOUNCE=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
ANN="$SCRIPT_DIR/announce.sh"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2; fi; }
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL: %s\n' "$1" >&2; fi; }

home=$(mktemp -d); fake=$(mktemp -d)
cat > "$fake/herdr" <<'X'
#!/usr/bin/env bash
if [ "$1 $2" = "pane current" ]; then echo '{"result":{"pane":{"agent":"claude"}}}'; exit 0; fi
echo "$@" >> "$FAKE_HERDR_LOG"
X
chmod +x "$fake/herdr"
export FAKE_HERDR_LOG="$fake/herdr.log" HERDR_BIN_PATH="$fake/herdr" HERDR_ENV=1 HERDR_PANE_ID=p1
export HARNESS_ORCH_HOME="$home" ANNOUNCE_INTERVAL=1 ANNOUNCE_IDLE_SECS=3 ANNOUNCE_SID=sess1 ANNOUNCE_HARNESS=claude
o() { bash "$SCRIPT" "$@"; }
. "$SCRIPT_DIR/test-home.sh"; seed_home "$home"
R=$(o run start "daemon demo")
o node add "$R" a a >/dev/null
o node update "$R" a running --owner coordinator >/dev/null

daemons() { ps -axo command | grep -c "[a]nnounce.sh --daemon"; }
upd() { jq -r '.updated_at' "$home/activity/sess1.json" 2>/dev/null; }
# poll "<condition>" <secs>: re-checks every 0.2 s instead of a fixed sleep sized for an idle machine.
poll() { local i=0; while ! eval "$1" >/dev/null 2>&1 && [ $i -lt $(($2 * 5)) ]; do sleep 0.2; i=$((i + 1)); done; }

( time bash "$ANN" --quiet ) 2> "$fake/time" >/dev/null
poll "[ \"\$(jq -r .pane \"$home/activity/sess1.json\" 2>/dev/null)\" = p1 ] && kill -0 \"\$(cat \"$home/announce.pid\" 2>/dev/null)\"" 15
ok "single shot wrote the activity file with pane" "$([ "$(jq -r .pane "$home/activity/sess1.json")" = p1 ] && echo 1 || echo 0)"
pid=$(cat "$home/announce.pid" 2>/dev/null)
ok "daemon started with a live pidfile" "$(kill -0 "$pid" 2>/dev/null && echo 1 || echo 0)"
u1=$(upd); sleep 4; u2=$(upd)
ok "daemon refreshed the file (updated_at advanced)" "$([ "$u2" -gt "$u1" ] && echo 1 || echo 0)"
sleep 8; u3=$(upd)
ok "daemon refreshed twice" "$([ "$u3" -gt "$u2" ] && echo 1 || echo 0)"
ok "herdr metadata reported by the daemon" "$([ "$(grep -c report-metadata "$fake/herdr.log")" -ge 3 ] && echo 1 || echo 0)"

bash "$ANN" --quiet; bash "$ANN" --quiet; sleep 2
eq "a second start creates no second daemon" 1 "$(grep -c 'started' "$home/announce.log")"
eq "one daemon process for this home" "$pid" "$(cat "$home/announce.pid")"

# --clear stops it
bash "$ANN" --clear --quiet; poll "! kill -0 $pid" 15
ok "--clear stops the daemon" "$(kill -0 "$pid" 2>/dev/null && echo 0 || echo 1)"

# dead pidfile survived
echo 999999 > "$home/announce.pid"
bash "$ANN" --quiet; poll "[ \"\$(cat \"$home/announce.pid\")\" != 999999 ] && kill -0 \"\$(cat \"$home/announce.pid\")\"" 15
npid=$(cat "$home/announce.pid")
ok "dead pidfile is replaced" "$([ "$npid" != 999999 ] && kill -0 "$npid" 2>/dev/null && echo 1 || echo 0)"

# idle exit: finish the run, the daemon leaves after ANNOUNCE_IDLE_SECS
o node update "$R" a done --force >/dev/null 2>&1
o run finish "$R" >/dev/null 2>&1
poll "! kill -0 $npid" 30
ok "daemon exits by itself when idle" "$(kill -0 "$npid" 2>/dev/null && echo 0 || echo 1)"
ok "idle exit logged" "$(grep -q 'idle, exiting' "$home/announce.log" && echo 1 || echo 0)"

# log cap
head -c 200000 /dev/zero | tr '\0' 'x' > "$home/announce.log"
echo 999999 > "$home/announce.pid"
R2=$(o run start "log cap")
o node add "$R2" a a >/dev/null
o node update "$R2" a running --owner coordinator >/dev/null 2>&1
bash "$ANN" --quiet; poll "[ \"\$(cat \"$home/announce.pid\")\" != 999999 ] && [ \"\$(wc -c < \"$home/announce.log\")\" -lt 160000 ]" 15
ok "log stays near the 100 KB cap" "$([ "$(wc -c < "$home/announce.log")" -lt 160000 ] && echo 1 || echo 0)"
bash "$ANN" --clear --quiet; poll "! kill -0 \"\$(cat \"$home/announce.pid\" 2>/dev/null)\"" 15

# locks: a second sync is skipped while the first holds the lock; a dead holder is taken over
mkdir -p "$home/locks"
sleep 20 & holder=$!
echo "$holder" > "$home/locks/sync-$R.pid"
out=$(o run sync "$R" --lock 2>&1)
ok "sync skipped while a live holder runs" "$(printf '%s' "$out" | grep -q 'still running, skipped' && echo 1 || echo 0)"
kill "$holder" 2>/dev/null
out=$(o run sync "$R" --lock 2>&1)
ok "sync runs when the holder is dead" "$(printf '%s' "$out" | grep -q '^running: ' && echo 1 || echo 0)"
eq "lock released (truncated)" "" "$(cat "$home/locks/sync-$R.pid")"
sleep 20 & holder=$!
echo "$holder" > "$home/locks/harness-list.pid"
printf '{"cached":true}\n' > "$home/locks/harness-list.last"
out=$(o harness list --json 2>&1)
eq "harness list returns the last answer while locked" '{"cached":true}' "$out"
kill "$holder" 2>/dev/null

bash "$ANN" --clear --quiet 2>/dev/null
printf 'announce-daemon: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
