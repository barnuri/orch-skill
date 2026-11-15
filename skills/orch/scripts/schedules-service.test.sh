#!/usr/bin/env bash
# dispatch.sh tests: skill folder, disabled harness, schedules, service.sh restart
# Run: bash schedules-service.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
export ORCH_NO_ANNOUNCE=1
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

# --- the skill folder holds the CLI, not the dashboard code ------------------------------------
# The server and browser client live in <repo>/src so that loading the skill never pulls in their
# code. A TypeScript or CSS file inside skills/orch means that split has started to erode.
skill_dir="$SCRIPT_DIR/.."
stray=$(find "$skill_dir" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) -not -path '*/node_modules/*' | head -3)
expect_no_match "the skill folder holds no server or dashboard code" '.' "$stray"
expect_file "the dashboard code lives under src/" "$SCRIPT_DIR/../../../src/server/main.ts"
expect_missing "there is no server folder inside the skill" "$skill_dir/server"

# --- a profile on a disabled harness cannot run -------------------------------------------------
dh_home=$(new_tmp)
dh_shims=$(new_tmp)
printf '#!/usr/bin/env bash\nprintf "ran\\n"\n' > "$dh_shims/claude"
chmod +x "$dh_shims/claude"
dh() { env PATH="$dh_shims:$PATH" HARNESS_ORCH_HOME="$dh_home" bash "$SCRIPT" "$@"; }
dh init >/dev/null 2>&1
out=$(dh run --profile claude-default "hi" 2>&1); rc=$?
expect_exit "an enabled harness runs its profile" 0 "$rc"
edit_json "$dh_home/profiles.json" '.settings.disabled_harnesses = ["claude"]'
out=$(dh run --profile claude-default "hi" 2>&1); rc=$?
expect_exit "a profile on a disabled harness is refused" 2 "$rc"
expect_match "the refusal names the harness and the fix" 'harness "claude" is disabled.*Harnesses page' "$out"
out=$(dh start --profile claude-default "hi" 2>&1); rc=$?
expect_exit "start refuses it too, before anything is backgrounded" 2 "$rc"
out=$(dh profile sanity --profile claude-default 2>&1)
expect_match "the sanity probe reports it as disabled, without running it" '"status":"disabled".*"error":"harness disabled"' "$out"
edit_json "$dh_home/profiles.json" '.settings.disabled_harnesses = []'
out=$(dh run --profile claude-default "hi" 2>&1); rc=$?
expect_exit "enabling the harness again lets the profile run" 0 "$rc"
cleanup_dir "$dh_shims"
cleanup_dir "$dh_home"

# --- schedules ----------------------------------------------------------------
sch_home=$(new_tmp)
sch_shims=$(new_tmp)
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/claude-argv"\n' "$sch_home" > "$sch_shims/claude"
chmod +x "$sch_shims/claude"
sch() { env PATH="$sch_shims:$PATH" HARNESS_ORCH_HOME="$sch_home" bash "$SCRIPT" schedule "$@"; }

out=$(sch next "0 9 * * 1-5" 2>&1); rc=$?
expect_exit "schedule next accepts a weekday cron" 0 "$rc"
expect_match "schedule next prints a 09:00 time" ' 09:00$' "$out"
for bad in "61 * * * *" "* * *" "0 0 31 2 *" "x * * * *"; do
  out=$(sch next "$bad" 2>&1); rc=$?
  expect_exit "schedule next rejects: $bad" 2 "$rc"
done
out=$(sch add --name n --cron "* * * * *" 2>&1); rc=$?
expect_exit "schedule add without prompt or command exits 2" 2 "$rc"
out=$(sch add --name n --cron "* * * * *" --prompt hi 2>&1); rc=$?
expect_exit "schedule add --prompt without --profile exits 2" 2 "$rc"
out=$(sch add --name n --cron "* * * * *" --prompt hi --command true --profile claude-default 2>&1); rc=$?
expect_exit "schedule add with both prompt and command exits 2" 2 "$rc"

cmd_id=$(sch add --name echoer --cron "* * * * *" --command 'echo from-schedule' 2>&1)
expect_match "schedule add prints an id" '^sch-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$' "$cmd_id"
sch run "$cmd_id" >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(sch show "$cmd_id" | jq -r '.runs[0].status')" = running ] || break
  sleep 1
done
expect_match "a command run ends ok" '^ok$' "$(sch show "$cmd_id" | jq -r '.runs[0].status')"
sleep 3
expect_match "a run's recorded end is when it finished, not when it was noticed" '^true$' \
  "$(sch show "$cmd_id" | jq -r '.runs[0] | ((.ended_at | fromdate) - (.started_at | fromdate)) <= 1')"
expect_match "a command run keeps its output" 'from-schedule' "$(cat "$sch_home"/schedules/"$cmd_id"/runs/*/out)"

due_file="$sch_home/schedules/$cmd_id/schedule.json"
edit_json "$due_file" '.next_at = 1'
out=$(sch tick 2>&1)
expect_match "tick fires a due schedule" "fired: $cmd_id" "$out"
expect_match "tick moves next_at into the future" '^true$' "$(jq -r '.next_at > now' "$due_file")"
out=$(sch tick 2>&1)
expect_no_match "tick does not fire a schedule that is not due" 'fired:' "$out"

# Overlap: a long command with a generous limit, so it is certainly still running when tick looks.
slow_id=$(sch add --name slow --cron "* * * * *" --command 'sleep 60' --timeout 5m 2>&1)
sch run "$slow_id" >/dev/null 2>&1
slow_file="$sch_home/schedules/$slow_id/schedule.json"
edit_json "$slow_file" '.next_at = 1'
out=$(sch tick 2>&1)
expect_match "tick skips a schedule whose last run is still going" "skipped \(still running\): $slow_id" "$out"
sch remove "$slow_id" >/dev/null 2>&1

# Timeout: a separate schedule, polled until its run ends instead of sleeping a guessed time.
kill_id=$(sch add --name timeout --cron "* * * * *" --command 'sleep 60' --timeout 2s 2>&1)
sch run "$kill_id" >/dev/null 2>&1
for _ in $(seq 1 60); do
  [ "$(sch show "$kill_id" | jq -r '.runs[0].status')" = running ] || break
  sleep 1
done
expect_match "a timed-out command run is failed" '^failed$' "$(sch show "$kill_id" | jq -r '.runs[0].status')"
expect_match "a timed-out command exits 142 (killed by the alarm)" '^142$' "$(sch show "$kill_id" | jq -r '.runs[0].exit')"
sch remove "$kill_id" >/dev/null 2>&1

sch disable "$cmd_id" >/dev/null 2>&1
expect_match "disable clears next_at" '^null$' "$(jq -r '.next_at' "$due_file")"
edit_json "$due_file" '.next_at = 1'
out=$(sch tick 2>&1)
expect_no_match "tick never fires a disabled schedule" "fired: $cmd_id" "$out"
sch enable "$cmd_id" >/dev/null 2>&1
expect_match "enable sets the next time again" '^true$' "$(jq -r '.next_at > now' "$due_file")"

prompt_id=$(sch add --name prompter --cron "* * * * *" --prompt "say hi" --profile claude-default 2>&1)
expect_match "schedule add accepts a prompt with a profile" '^sch-' "$prompt_id"
out=$(sch run "$prompt_id" 2>&1); rc=$?
expect_exit "run a prompt schedule exits 0" 0 "$rc"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(sch show "$prompt_id" | jq -r '.runs[0].status')" = running ] || break
  sleep 1
done
expect_match "a prompt run goes through the profile's harness" 'say hi' "$(cat "$sch_home/claude-argv" 2>/dev/null)"
expect_match "a prompt run ends ok" '^ok$' "$(sch show "$prompt_id" | jq -r '.runs[0].status')"

out=$(sch list --json 2>&1)
expect_match "list --json has the two schedules still there" '^2$' "$(printf '%s' "$out" | jq 'length')"
out=$(sch show "$kill_id" 2>&1); rc=$?
expect_exit "a removed schedule is unknown" 2 "$rc"
cleanup_dir "$sch_shims"
cleanup_dir "$sch_home"

# --- service.sh restart (launchd, with a stubbed launchctl) -----------------------------------
# The real launchctl is never touched: a shim keeps "loaded" in a file. It reproduces the two ways a
# restart used to leave nothing loaded: bootout returns before the unit is gone, and `load -w`
# exits 0 without loading anything.
if [ "$(uname -s)" = Darwin ]; then
  SERVICE_SH="$SCRIPT_DIR/../../../scripts/service.sh"
  svc_home=$(new_tmp)
  svc_state=$(new_tmp)
  svc_bin=$(new_tmp)
  mkdir -p "$svc_home/Library/LaunchAgents" "$svc_home/orch"
  : > "$svc_home/Library/LaunchAgents/io.github.barnuri.orch.plist"
  cat > "$svc_bin/launchctl" <<'SHIM'
#!/usr/bin/env bash
st="$SVC_STATE"
case "$1" in
  print)
    if [ -f "$st/unload_left" ]; then
      n=$(cat "$st/unload_left")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$st/unload_left"; exit 0; fi
      rm -f "$st/loaded" "$st/unload_left"; exit 113
    fi
    [ -f "$st/loaded" ] ;;
  bootout) echo bootout >> "$st/calls"; [ -f "$st/loaded" ] || exit 3; echo 2 > "$st/unload_left" ;;
  bootstrap)
    echo bootstrap >> "$st/calls"
    [ -z "${BOOTSTRAP_FAIL:-}" ] && [ ! -f "$st/loaded" ] || exit 5
    : > "$st/loaded" ;;
  kickstart) echo kickstart >> "$st/calls"; [ -f "$st/loaded" ] && [ -z "${KICKSTART_FAIL:-}" ] || exit 113 ;;
  load) echo load >> "$st/calls" ;;
  *) exit 0 ;;
esac
SHIM
  chmod +x "$svc_bin/launchctl"
  svc() { env HOME="$svc_home" HARNESS_ORCH_HOME="$svc_home/orch" SVC_STATE="$svc_state" PATH="$svc_bin:$PATH" "$@" bash "$SERVICE_SH" restart; }
  svc_reset() { rm -f "$svc_state"/*; }

  svc_reset; : > "$svc_state/loaded"
  out=$(svc env 2>&1); rc=$?
  expect_exit "restart of a loaded unit exits 0" 0 "$rc"
  expect_match "a loaded unit is restarted in place with kickstart" 'kickstart' "$(cat "$svc_state/calls")"
  expect_no_match "an in-place restart never unloads the unit" 'bootout' "$(cat "$svc_state/calls")"

  svc_reset
  out=$(svc env 2>&1); rc=$?
  expect_exit "restart of an unloaded unit exits 0" 0 "$rc"
  expect_file "an unloaded unit is loaded by restart" "$svc_state/loaded"

  svc_reset; : > "$svc_state/loaded"
  out=$(svc env KICKSTART_FAIL=1 2>&1); rc=$?
  expect_exit "restart waits out a slow bootout, then loads" 0 "$rc"
  expect_file "the unit is loaded after a bootout that lagged" "$svc_state/loaded"

  svc_reset
  out=$(svc env BOOTSTRAP_FAIL=1 2>&1); rc=$?
  expect_exit "restart exits 1 when launchd never loads the unit" 1 "$rc"
  expect_no_match "restart does not claim success when nothing loaded" 'restarted' "$out"

  cleanup_dir "$svc_bin"
  cleanup_dir "$svc_state"
  cleanup_dir "$svc_home"
fi


finish
