#!/usr/bin/env bash
# Herdr integration for dispatch.sh — sourced, never executed. With settings.herdr on, `start`
# runs each job in a pane of the main Herdr session.

HERDR_USAGE='dispatch.sh herdr on|off|status'
HERDR_WORKSPACE_LABEL="orch"
HERDR_NO_RUN_TAB_LABEL="jobs"
HERDR_PID_WAIT_SECS=15

# The calling pane's HERDR_* env points the CLI at whatever session the caller runs in; jobs always
# go to the main session, which is the CLI's default socket.
herdr_main() {
  env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID herdr "$@"
}

herdr_enabled() {
  [ "$(setting_get herdr false)" = "true" ]
}

herdr_server_running() {
  command -v herdr >/dev/null 2>&1 || return 1
  herdr_main status --json 2>/dev/null | jq -e '.server.running == true' >/dev/null 2>&1
}

# Herdr shows labels with a "[n] " prefix, so a label matches exactly or as that suffix.
HERDR_LABEL_FILTER='select(.label == $l or (.label // "" | endswith(" " + $l)))'

# herdr_target_pane <tab-label> <cwd>: prints the pane id the next job runs in, creating the orch
# workspace, the run's tab, or a split pane as needed.
herdr_target_pane() {
  local tab_label="$1" cwd="$2" workspace_id tab_id created panes pane_count last_pane direction
  workspace_id=$(herdr_main workspace list | jq -r --arg l "$HERDR_WORKSPACE_LABEL" \
    "[.result.workspaces[] | $HERDR_LABEL_FILTER][0].workspace_id // empty") || return 1
  if [ -z "$workspace_id" ]; then
    created=$(herdr_main workspace create --cwd "$cwd" --label "$HERDR_WORKSPACE_LABEL" --no-focus) || return 1
    tab_id=$(printf '%s' "$created" | jq -r '.result.tab.tab_id // empty')
    [ -n "$tab_id" ] && herdr_main tab rename "$tab_id" "$tab_label" >/dev/null || return 1
    printf '%s' "$created" | jq -er '.result.root_pane.pane_id'
    return
  fi
  tab_id=$(herdr_main tab list --workspace "$workspace_id" | jq -r --arg l "$tab_label" \
    "[.result.tabs[] | $HERDR_LABEL_FILTER][0].tab_id // empty") || return 1
  if [ -z "$tab_id" ]; then
    herdr_main tab create --workspace "$workspace_id" --cwd "$cwd" --label "$tab_label" --no-focus \
      | jq -er '.result.root_pane.pane_id'
    return
  fi
  panes=$(herdr_main pane list --workspace "$workspace_id" | jq -c --arg t "$tab_id" \
    '[.result.panes[] | select(.tab_id == $t) | .pane_id]') || return 1
  pane_count=$(printf '%s' "$panes" | jq 'length')
  last_pane=$(printf '%s' "$panes" | jq -r '.[-1] // empty')
  [ -n "$last_pane" ] || return 1
  direction=right
  [ $((pane_count % 2)) -eq 0 ] && direction=down
  herdr_main pane split "$last_pane" --direction "$direction" --cwd "$cwd" --no-focus \
    | jq -er '.result.pane.pane_id'
}

# Writes the script the pane runs. It carries only the orch env, PATH and the job's argv, so no
# other secret from the caller's environment lands on disk.
herdr_write_launcher() {
  local launcher="$1" job_dir="$2" start_script="$3" name
  shift 3
  {
    printf '#!/usr/bin/env bash\n'
    for name in $(compgen -e | grep -E '^(ORCH_|HARNESS_ORCH_)|^PATH$'); do
      printf 'export %s=%q\n' "$name" "${!name}"
    done
    printf 'cd -- %q || exit 1\n' "$PWD"
    printf 'printf %%s "$$" > %q\n' "$job_dir/pid"
    printf 'exec bash -c %q _' "$start_script"
    printf ' %q' "$@"
    printf ' > >(tee %q) 2>&1 </dev/null\n' "$job_dir/log"
  } > "$launcher" && chmod 700 "$launcher"
}

# herdr_start_job <job_dir> <start_script> <argv...>: runs the job in a Herdr pane. Returns 1 when
# nothing was sent to Herdr, so the caller can fall back to a detached job.
herdr_start_job() {
  local job_dir="$1" start_script="$2" launcher pane_id
  shift 2
  herdr_server_running || return 1
  launcher="$job_dir/herdr-launch.sh"
  herdr_write_launcher "$launcher" "$job_dir" "$start_script" "$@" || return 1
  pane_id=$(herdr_target_pane "${ORCH_RUN_ID:-$HERDR_NO_RUN_TAB_LABEL}" "$PWD" 2>/dev/null) || return 1
  [ -n "$pane_id" ] || return 1
  herdr_main pane run "$pane_id" "bash $(printf '%q' "$launcher")" >/dev/null 2>&1 || return 1
  printf '%s\n' "$pane_id" > "$job_dir/herdr_pane"
  return 0
}

herdr_setting_write() {
  local value="$1" tmp="$PROFILES_FILE.tmp.$$"
  if ! jq --argjson v "$value" '.settings.herdr = $v' "$PROFILES_FILE" > "$tmp"; then
    printf 'herdr: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  mv -f "$tmp" "$PROFILES_FILE"
}

cmd_herdr() {
  require_jq "herdr"
  ensure_home || return 1
  case "${1:-}" in
    on) herdr_setting_write true || return 1 ;;
    off) herdr_setting_write false || return 1 ;;
    status) ;;
    *) printf 'usage: %s\n' "$HERDR_USAGE" >&2; return 2 ;;
  esac
  if herdr_enabled; then printf 'herdr: on\n'; else printf 'herdr: off\n'; fi
  if herdr_server_running; then
    printf 'server: running\n'
  elif command -v herdr >/dev/null 2>&1; then
    printf 'server: not running (jobs start detached)\n'
  else
    printf 'server: herdr not on PATH (jobs start detached)\n'
  fi
}
