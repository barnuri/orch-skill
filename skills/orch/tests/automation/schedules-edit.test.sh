#!/usr/bin/env bash
# dispatch.sh tests: `schedule edit`
# Run: bash schedules-edit.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
export ORCH_NO_ANNOUNCE=1
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

se_home=$(new_tmp)
se_shims=$(new_tmp)
printf '#!/usr/bin/env bash\nprintf "ran\\n"\n' > "$se_shims/claude"
chmod +x "$se_shims/claude"
se() { env PATH="$se_shims:$PATH" HARNESS_ORCH_HOME="$se_home" bash "$SCRIPT" schedule "$@"; }
env PATH="$se_shims:$PATH" HARNESS_ORCH_HOME="$se_home" bash "$SCRIPT" init >/dev/null 2>&1

cid=$(se add --name echoer --cron "0 9 * * *" --command 'echo one' 2>&1)
expect_match "a command schedule to edit" '^sch-' "$cid"
cfile="$se_home/schedules/$cid/schedule.json"
created=$(jq -r '.created_at' "$cfile")
# A fake history entry and a paused state that the edit must keep.
edit_json "$cfile" '.runs = [{started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z", kind: "command", ref: "/x", status: "ok", exit: 0}] | .last_run_at = "2026-01-01T00:00:00Z"'

out=$(se edit "$cid" --name renamed 2>&1); rc=$?
expect_exit "edit --name exits 0" 0 "$rc"
expect_match "edit prints the id" "edited: $cid" "$out"
expect_match "the name changed" '^renamed$' "$(jq -r '.name' "$cfile")"
expect_match "updated_at is set" '^20[0-9-]+T' "$(jq -r '.updated_at' "$cfile")"
expect_match "created_at is kept" "^$created\$" "$(jq -r '.created_at' "$cfile")"
expect_match "the run history is kept" '^1 2026-01-01T00:00:00Z$' "$(jq -r '"\(.runs | length) \(.last_run_at)"' "$cfile")"

old_next=$(jq -r '.next_at' "$cfile")
# A due run (next_at in the past, not yet claimed by tick) must survive an edit that leaves the cron alone.
edit_json "$cfile" '.next_at = 1000'
out=$(se edit "$cid" --name renamed-again --cron "0 9 * * *" 2>&1); rc=$?
expect_exit "a same-cron edit exits 0" 0 "$rc"
expect_match "a name edit with the same cron keeps a due next_at" '^1000$' "$(jq -r '.next_at' "$cfile")"
edit_json "$cfile" ".next_at = $old_next"
out=$(se edit "$cid" --cron "30 14 * * *" 2>&1); rc=$?
expect_exit "edit --cron exits 0" 0 "$rc"
expect_match "the cron changed" '^30 14 \* \* \*$' "$(jq -r '.cron' "$cfile")"
expect_match "next_at is recomputed for the new cron" '^true$' "$(jq -r --argjson o "$old_next" '.next_at != $o and (.next_at | strflocaltime("%H:%M")) == "14:30"' "$cfile")"

before=$(cat "$cfile")
out=$(se edit "$cid" --cron "61 * * * *" 2>&1); rc=$?
expect_exit "an invalid cron is rejected with 2" 2 "$rc"
expect_match "the error names the cron" 'bad or never-matching cron' "$out"
expect_match "a rejected edit leaves the file unchanged" '^same$' "$([ "$before" = "$(cat "$cfile")" ] && echo same)"

wd=$(new_tmp)
out=$(se edit "$cid" --command 'echo two' --workdir "$wd" --timeout 5m 2>&1); rc=$?
expect_exit "edit --command --workdir --timeout exits 0" 0 "$rc"
expect_match "command, workdir and timeout changed" "^echo two\|$wd\|300\$" "$(jq -r '"\(.command)|\(.workdir)|\(.timeout)"' "$cfile")"
out=$(se edit "$cid" --workdir /no/such/dir 2>&1); rc=$?
expect_exit "a missing workdir is rejected" 2 "$rc"
out=$(se edit "$cid" --timeout soon 2>&1); rc=$?
expect_exit "a bad timeout is rejected" 2 "$rc"
out=$(se edit "$cid" --workdir "" 2>&1); rc=$?
expect_match "--workdir \"\" clears it" '^null$' "$(jq -r '.workdir' "$cfile")"

se disable "$cid" >/dev/null 2>&1
out=$(se edit "$cid" --name paused-one 2>&1); rc=$?
expect_match "a paused schedule stays paused with no next run" '^false null$' "$(jq -r '"\(.enabled) \(.next_at)"' "$cfile")"
se enable "$cid" >/dev/null 2>&1

out=$(se edit "$cid" --prompt hi 2>&1); rc=$?
expect_exit "switching to prompt without a profile is rejected" 2 "$rc"
out=$(se edit "$cid" --prompt hi --profile no-such-profile 2>&1); rc=$?
expect_exit "an unknown profile is rejected" 2 "$rc"
out=$(se edit "$cid" --profile claude-default 2>&1); rc=$?
expect_exit "--profile on a command schedule is rejected" 2 "$rc"
out=$(se edit "$cid" --prompt 'say hi' --profile claude-default 2>&1); rc=$?
expect_exit "a switch to a prompt schedule exits 0" 0 "$rc"
expect_match "the kind switch clears the command fields" '^prompt\|say hi\|claude-default\|null\|null\|0$' \
  "$(jq -r '"\(.kind)|\(.prompt)|\(.profile)|\(.command)|\(.workdir)|\(.timeout)"' "$cfile")"
expect_match "history survives a kind switch" '^1$' "$(jq -r '.runs | length' "$cfile")"

printf 'from a file\n' > "$wd/p.md"
out=$(se edit "$cid" --prompt "@$wd/p.md" 2>&1); rc=$?
expect_match "--prompt @file reads the file and keeps the profile" '^from a file\|claude-default$' "$(jq -r '"\(.prompt)|\(.profile)"' "$cfile")"
edit_json "$se_home/profiles.json" '.profiles["claude-default"].allowed_models = ["claude-sonnet", "claude-opus"]'
out=$(se edit "$cid" --model claude-opus 2>&1); rc=$?
expect_exit "edit --model exits 0" 0 "$rc"
expect_match "the model changed and the prompt is kept" '^claude-opus\|from a file$' "$(jq -r '"\(.model)|\(.prompt)"' "$cfile")"
out=$(se edit "$cid" --model claude-haiku 2>&1); rc=$?
expect_exit "a model the profile does not allow is rejected" 2 "$rc"
expect_match "a rejected model leaves the old one" '^claude-opus$' "$(jq -r '.model' "$cfile")"
out=$(se edit "$cid" --model "" 2>&1); rc=$?
expect_match "--model \"\" goes back to the profile default" '^null$' "$(jq -r '.model' "$cfile")"
se edit "$cid" --model claude-opus >/dev/null 2>&1
out=$(se edit "$cid" --profile claude-default 2>&1); rc=$?
expect_match "a profile edit keeps a model the profile allows" '^claude-opus$' "$(jq -r '.model' "$cfile")"
edit_json "$se_home/profiles.json" '.profiles["claude-default"].allowed_models = ["claude-sonnet"]'
out=$(se edit "$cid" --profile claude-default 2>&1); rc=$?
expect_match "a profile edit drops a model the profile no longer allows" '^null$' "$(jq -r '.model' "$cfile")"
edit_json "$se_home/profiles.json" '.profiles["claude-default"].allowed_models = ["claude-sonnet", "claude-opus"]'
se edit "$cid" --model claude-opus >/dev/null 2>&1

out=$(se edit "$cid" --timeout 5m 2>&1); rc=$?
expect_exit "--timeout on a prompt schedule is rejected" 2 "$rc"

out=$(se edit "$cid" --command 'echo back' 2>&1); rc=$?
expect_match "a switch back to command clears the prompt fields" '^command\|echo back\|null\|null$' "$(jq -r '"\(.kind)|\(.command)|\(.prompt)|\(.profile)"' "$cfile")"
expect_match "a switch to command clears the model" '^null$' "$(jq -r '.model' "$cfile")"
out=$(se edit "$cid" --model claude-opus 2>&1); rc=$?
expect_exit "--model on a command schedule is rejected" 2 "$rc"

out=$(se edit "$cid" --prompt a --command b 2>&1); rc=$?
expect_exit "--prompt with --command is rejected" 2 "$rc"
out=$(se edit "$cid" 2>&1); rc=$?
expect_exit "an edit with nothing to change is rejected" 2 "$rc"
out=$(se edit "$cid" --bogus x 2>&1); rc=$?
expect_exit "an unknown flag is rejected" 2 "$rc"
out=$(se edit "$cid" --name 2>&1); rc=$?
expect_exit "a flag without a value is rejected" 2 "$rc"
out=$(se edit sch-20200101-000000-abcd --name x 2>&1); rc=$?
expect_exit "an unknown id is rejected with 2" 2 "$rc"
expect_match "the error says unknown schedule" '^unknown schedule' "$out"
expect_match "the id never changes" "^$cid\$" "$(jq -r '.id' "$cfile")"

cleanup_dir "$wd"
cleanup_dir "$se_shims"
cleanup_dir "$se_home"

finish
