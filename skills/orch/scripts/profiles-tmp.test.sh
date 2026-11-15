#!/usr/bin/env bash
# profiles.json migrations must not leave scratch files or run on every call.
set -u
export ORCH_NO_ANNOUNCE=1
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dispatch.sh"
pass=0; fail=0
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL: %s\n' "$1" >&2; fi; }
home=$(mktemp -d); export HARNESS_ORCH_HOME="$home"
bash "$SCRIPT" init >/dev/null 2>&1
strays() { find "$home" -maxdepth 1 -name 'profiles.json.tmp.*' | wc -l | tr -d ' '; }
trash_n() { find "$home/.trash" -type f 2>/dev/null | wc -l | tr -d ' '; }
ok "marker written after the first migration" "$([ -s "$home/.migrations/profiles-main" ] && echo 1 || echo 0)"
t0=$(date +%s); t_before=$(trash_n)
for i in $(seq 1 20); do bash "$SCRIPT" profile list >/dev/null 2>&1; done
ok "20 profile list calls leave 0 stray tmp files" "$([ "$(strays)" = 0 ] && echo 1 || echo 0)"
ok "and move nothing into the trash dir" "$([ "$(trash_n)" = "$t_before" ] && echo 1 || echo 0)"
ok "20 calls finish in under 180 s" "$([ $(( $(date +%s) - t0 )) -lt 180 ] && echo 1 || echo 0)"
for i in 1 2 3; do bash "$SCRIPT" profile list >/dev/null 2>&1 & p=$!; sleep 0.2; kill -TERM $p 2>/dev/null; wait $p 2>/dev/null; done
ok "kill -TERM during a run leaves 0 strays" "$([ "$(strays)" = 0 ] && echo 1 || echo 0)"
# SIGKILL (the server's dispatch timeouts) skips every trap: the next call sweeps the dead writer's file.
cp "$home/profiles.json" "$home/profiles.json.tmp.999999"
sleep 30 & live=$!
cp "$home/profiles.json" "$home/profiles.json.tmp.$live"
bash "$SCRIPT" profile list >/dev/null 2>&1
ok "a SIGKILLed writer's temp file is swept" "$([ ! -e "$home/profiles.json.tmp.999999" ] && echo 1 || echo 0)"
ok "a live writer's temp file is kept" "$([ -e "$home/profiles.json.tmp.$live" ] && echo 1 || echo 0)"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
bash "$SCRIPT" profile list >/dev/null 2>&1
ok "and swept once its writer is gone" "$([ "$(strays)" = 0 ] && echo 1 || echo 0)"
printf '%s\n' "$(jq -c '.settings.x_test = 1' "$home/profiles.json")" > "$home/profiles.json.new" && mv "$home/profiles.json.new" "$home/profiles.json"
bash "$SCRIPT" profile list >/dev/null 2>&1
ok "a changed profiles.json re-runs the migrations and re-marks" "$([ "$(cat "$home/.migrations/profiles-main")" != "" ] && [ "$(strays)" = 0 ] && echo 1 || echo 0)"
printf 'profiles-tmp: %s passed, %s failed\n' "$pass" "$fail"; [ "$fail" -eq 0 ]
