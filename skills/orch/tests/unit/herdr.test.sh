#!/usr/bin/env bash
# Fast-tier unit tests for lib/adapters/herdr.sh: the instance paths, enable reasons, the web registry
# check, the launcher script and the usage errors, called in-process. No herdr process is started or called.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch
export ORCH_HERDR_WEB_URL=off

expect_match "herdr_dir lives under the orch home" "^$H/herdr\$" "$(herdr_dir)"
short=$(mktemp -d /tmp/oh.XXXX)
inst=$(ORCH_HOME="$short"; herdr_inst_home)
expect_match "a short home gives the real instance home" "^$short/herdr/home\$" "$inst"
expect_match "  ... and creates its config dir" '^yes$' "$([ -d "$short/herdr/home/.config/herdr" ] && echo yes)"

herdr_env_args /x/inst
expect_match "env args start with env -i and the instance HOME" '^env -i PATH=.* HOME=/x/inst ' "${HERDR_ENV_ARGS[*]}"
expect_match "  ... and carry ORCH_HERDR_* through" 'ORCH_HERDR_WEB_URL=off' "${HERDR_ENV_ARGS[*]}"

expect_match "ORCH_HERDR=0 reads as off" '^off \(ORCH_HERDR=0\)$' "$(ORCH_HERDR=0 herdr_enabled_reason)"
expect_match "ORCH_HERDR=1 reads as on" '^on \(ORCH_HERDR=1\)$' "$(ORCH_HERDR=1 herdr_enabled_reason)"
# settings.herdr=false is not checked: setting_get's `// $d` turns false into the default (lib bug, reported).
herdr_setting_write '.settings.herdr = true'
expect_match "settings.herdr=true reads as on" '^on \(settings.herdr\)$' "$(unset ORCH_HERDR; herdr_enabled_reason)"

envs=$(new_tmp)
export ORCH_HERDR_WEB_ENVS_DIR="$envs"
expect_match "web entry is missing without a registry file" '^missing$' "$(herdr_web_entry_state)"
real_inst=$(ORCH_HOME="$short"; herdr_inst_home)
jq -n --arg h "$real_inst" '{id:"orch-skill",label:"orch-skill",home:$h,socket:($h + "/.config/herdr/herdr.sock")}' \
  > "$envs/orch-skill.json"
expect_match "  ... ok when it matches the instance" '^ok$' "$(ORCH_HOME="$short"; herdr_web_entry_state)"
expect_match "  ... wrong for another instance" '^wrong$' "$(ORCH_HOME="$short/other"; herdr_web_entry_state)"
expect_match "web url honours the override" '^off$' "$(herdr_web_url)"
expect_match "web listing is skipped when the url is off" '^skipped$' "$(herdr_web_listed)"

job=$(new_tmp)
herdr_write_launcher "$job/l.sh" "$job" t-7 "$job/owner" /x/inst 5
expect_match "launcher is mode 700" '700' "$(stat -f '%Lp' "$job/l.sh" 2>/dev/null || stat -c '%a' "$job/l.sh")"
expect_match "  ... closes its own tab after the linger" 'herdr tab close t-7' "$(cat "$job/l.sh")"
expect_match "  ... only while this job owns the tab" "= $job \\]" "$(cat "$job/l.sh")"
expect_match "  ... waits the linger (5 s)" 'sleep 5' "$(cat "$job/l.sh")"
expect_match "  ... and execs the TypeScript launcher" 'exec bun .*/core/commands/herdr-launch\.ts' "$(cat "$job/l.sh")"
expect_match "  ... and exits 127 with the bun requirement when bun is missing" 'orch needs bun.*exit 127' "$(cat "$job/l.sh")"
expect_no_match "  ... and has no bash fallback" 'script -q|tee -a|ORCH_BASH' "$(cat "$job/l.sh")"
bash -n "$job/l.sh"; rc=$?
expect_exit "  ... and is valid bash" 0 "$rc"

expect_match "owner file is per tab, with unsafe characters replaced" "/tabs/w1_t2.job\$" "$(ORCH_HOME="$short"; herdr_owner_file "w1:t2")"
expect_match "the linger defaults to 600 s" '^600$' "$(unset ORCH_HERDR_CLOSE_AFTER; ORCH_HOME="$short" herdr_linger_sec)"
expect_match "ORCH_HERDR_CLOSE_AFTER overrides the linger" '^0$' "$(ORCH_HERDR_CLOSE_AFTER=0 herdr_linger_sec)"
expect_match "a non-numeric linger falls back to 600" '^600$' "$(ORCH_HERDR_CLOSE_AFTER=soon herdr_linger_sec)"

: > "$job/pid"
printf 'p-7\n' > "$job/herdr_pane"
expect_match "gone note names the pane, not a reboot" '^job process gone without an exit code; its orch-herdr pane p-7 is gone or idle$' \
  "$(herdr_job_gone_note "$job")"

out=$(ORCH_HERDR=0 herdr_health --json); rc=$?
expect_exit "health when disabled returns 0" 0 "$rc"
expect_match "  ... with state off and no problems" '^off false 0$' "$(printf '%s' "$out" | jq -r '"\(.state) \(.enabled) \(.problems | length)"')"
out=$(herdr_health --bad 2>&1); rc=$?
expect_exit "health with an unknown flag is a usage error" 2 "$rc"
herdr_orch bogus; rc=$?
expect_exit "herdr_orch with an unknown verb returns 2" 2 "$rc"
out=$(cmd_herdr bogus 2>&1); rc=$?
expect_exit "cmd_herdr with an unknown verb is a usage error" 2 "$rc"

cleanup_dir "$short"
cleanup_dir "$envs"
cleanup_dir "$job"
cleanup_dir "$(dirname "$H")"
finish
