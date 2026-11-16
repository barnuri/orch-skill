#!/usr/bin/env bash
# Dedicated herdr instance for dispatch.sh — sourced, never executed. The orch skill never touches
# the user's live herdr session: jobs run in panes of a second, headless herdr server that lives
# under <orch-home>/herdr/ with its own HOME, minimal config.toml (no plugins), socket, pidfile
# and log. Every herdr call here is best effort; when it fails the caller starts the job detached.

HERDR_USAGE='dispatch.sh herdr on|off|auto|status|attach|ensure|stop | herdr health [--json] [--nudge]'
HERDR_WORKSPACE_LABEL="orch"
HERDR_NO_RUN_TAB_LABEL="jobs"
HERDR_PID_WAIT_SECS=15
HERDR_PANE_CAP_DEFAULT=20
HERDR_CLOSE_AFTER_DEFAULT=60
HERDR_CALL_TIMEOUT_SECS="${ORCH_HERDR_CALL_TIMEOUT:-8}"
HERDR_START_WAIT_SECS="${ORCH_HERDR_START_WAIT:-15}"
HERDR_SOCK_MAX_BYTES=100
HERDR_CONFIG_TOML='# Managed by orch (dispatch.sh herdr). No plugins, no notifications: the orch skill has its own.
onboarding = false

[ui.toast]
delivery = "off"
'

herdr_dir() { printf '%s/herdr\n' "$ORCH_HOME"; }

herdr_bin_present() { command -v herdr >/dev/null 2>&1; }

# The HOME the instance runs with. Unix socket paths must stay under ~104 bytes, so a long
# <orch-home> is reached through a short symlink in /tmp.
herdr_inst_home() {
  local real sock link
  real="$(herdr_dir)/home"
  sock="$real/.config/herdr/herdr.sock"
  mkdir -p "$real/.config/herdr" || return 1
  if [ "${#sock}" -le "$HERDR_SOCK_MAX_BYTES" ]; then printf '%s\n' "$real"; return 0; fi
  link="/tmp/orch-herdr-$(id -u)-$(printf '%s' "$ORCH_HOME" | cksum | cut -d' ' -f1)"
  if [ -e "$link" ] && [ ! -L "$link" ]; then return 1; fi
  [ "$(readlink "$link" 2>/dev/null)" = "$real" ] || ln -sfn "$real" "$link" || return 1
  printf '%s\n' "$link"
}

# herdr_env_args <inst-home>: sets HERDR_ENV_ARGS, the env -i prefix every instance command uses.
herdr_env_args() {
  local inst="$1" name
  HERDR_ENV_ARGS=(env -i "PATH=$PATH" "HOME=$inst" "TERM=${TERM:-xterm-256color}" "LANG=${LANG:-en_US.UTF-8}")
  for name in $(compgen -e | grep -E '^ORCH_HERDR_'); do HERDR_ENV_ARGS+=("$name=${!name}"); done
}

# herdr_cli <args...>: the herdr CLI against the dedicated instance only. env -i drops every
# HERDR_* variable of a calling pane and the real HOME, so the live session's socket is unreachable.
herdr_cli() {
  local inst args
  inst=$(herdr_inst_home) || return 1
  herdr_env_args "$inst"
  args=("${HERDR_ENV_ARGS[@]}")
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$HERDR_CALL_TIMEOUT_SECS" "${args[@]}" herdr "$@"
  else
    "${args[@]}" herdr "$@"
  fi
}

# ORCH_HERDR=0 turns it off, ORCH_HERDR=1 on; else settings.herdr; else on exactly when the binary exists.
herdr_enabled() {
  herdr_bin_present || return 1
  case "${ORCH_HERDR:-}" in 0|false|off) return 1 ;; 1|true|on) return 0 ;; esac
  [ "$(setting_get herdr auto)" != "false" ]
}

herdr_enabled_reason() {
  case "${ORCH_HERDR:-}" in
    0|false|off) printf 'off (ORCH_HERDR=0)\n'; return ;;
    1|true|on) printf 'on (ORCH_HERDR=1)\n'; return ;;
  esac
  case "$(setting_get herdr auto)" in
    true) printf 'on (settings.herdr)\n' ;;
    false) printf 'off (settings.herdr)\n' ;;
    *) if herdr_bin_present; then printf 'on (default: herdr found)\n'; else printf 'off (default: herdr not on PATH)\n'; fi ;;
  esac
}

herdr_server_running() {
  herdr_bin_present || return 1
  herdr_cli status --json 2>/dev/null | jq -e '.server.running == true' >/dev/null 2>&1
}

herdr_attach_hint() {
  local inst
  inst=$(herdr_inst_home) || return 1
  printf 'env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID HOME=%q herdr\n' "$inst"
}

# Registry file for the herdr web plugin: it lists this instance as environment "orch-skill".
# Best effort, never fails the caller. ORCH_HERDR_WEB_ENVS_DIR overrides the directory (tests).
HERDR_WEB_ENV_ID="orch-skill"

herdr_web_envs_dir() { printf '%s\n' "${ORCH_HERDR_WEB_ENVS_DIR:-$HOME/.config/herdr-web/envs.d}"; }

herdr_web_register() {
  herdr_enabled || return 0
  local dir inst file tmp
  dir=$(herdr_web_envs_dir)
  inst=$(herdr_inst_home 2>/dev/null) || return 0
  mkdir -p "$dir" 2>/dev/null || return 0
  file="$dir/$HERDR_WEB_ENV_ID.json"
  tmp="$file.tmp.$$"
  jq -n --arg id "$HERDR_WEB_ENV_ID" --arg home "$inst" --arg sock "$inst/.config/herdr/herdr.sock" \
    '{id: $id, label: $id, home: $home, socket: $sock}' > "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$file" 2>/dev/null || { recoverable_remove "$tmp" 2>/dev/null; true; }
  return 0
}

herdr_web_unregister() {
  recoverable_remove "$(herdr_web_envs_dir)/$HERDR_WEB_ENV_ID.json" 2>/dev/null
  return 0
}

# herdr_web_entry_state: ok | missing | wrong — the registry file against the current instance.
herdr_web_entry_state() {
  local file inst
  file="$(herdr_web_envs_dir)/$HERDR_WEB_ENV_ID.json"
  [ -f "$file" ] || { printf 'missing\n'; return; }
  inst=$(herdr_inst_home 2>/dev/null) || { printf 'wrong\n'; return; }
  if jq -e --arg id "$HERDR_WEB_ENV_ID" --arg home "$inst" --arg sock "$inst/.config/herdr/herdr.sock" \
    '.id == $id and .label == $id and .home == $home and .socket == $sock' "$file" >/dev/null 2>&1; then
    printf 'ok\n'
  else
    printf 'wrong\n'
  fi
}

# The herdr web plugin's base URL. ORCH_HERDR_WEB_URL overrides it; "off" skips the check.
herdr_web_url() { printf '%s\n' "${ORCH_HERDR_WEB_URL:-http://127.0.0.1:2222}"; }

# herdr_web_listed: listed | unreachable | missing | no-plugin | skipped — what GET /api/envs of the
# web plugin says about the orch-skill env ("unreachable": listed, but the plugin cannot reach its socket).
herdr_web_listed() {
  local url body
  url=$(herdr_web_url)
  [ "$url" != off ] && command -v curl >/dev/null 2>&1 || { printf 'skipped\n'; return; }
  body=$(curl -fsS -m 3 "$url/api/envs" 2>/dev/null) || { printf 'no-plugin\n'; return; }
  printf '%s' "$body" | jq -r --arg id "$HERDR_WEB_ENV_ID" \
    '[.[]? | select(.id == $id)][0] | if . == null then "missing" elif .reachable == true then "listed" else "unreachable" end' \
    2>/dev/null || printf 'no-plugin\n'
}

# herdr_server_pid_alive <pid>: the pidfile's process is alive and is a herdr server.
herdr_server_pid_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  ps -p "$1" -o command= 2>/dev/null | grep -q 'herdr'
}

# herdr_health [--json] [--nudge]: is the orch herdr instance up and listed in herdr web.
# state: ok | degraded (up, but the registry file or the web listing is wrong) | down | off.
# --nudge re-ensures the server and re-registers the env when either is broken (self-heal). Only
# ever acts on the instance under <orch-home>/herdr; the user's own herdr is never touched.
herdr_health() {
  local json=0 nudge=0 a nudged=false pid="" pid_alive=false socket_ok=false registry=missing web=skipped state problems
  for a in "$@"; do
    case "$a" in
      --json) json=1 ;;
      --nudge) nudge=1 ;;
      *) printf 'usage: dispatch.sh herdr health [--json] [--nudge]\n' >&2; return 2 ;;
    esac
  done
  if ! herdr_enabled; then
    state=off
  else
    herdr_health_collect
    if [ "$nudge" -eq 1 ] && { [ "$socket_ok" != true ] || [ "$registry" != ok ]; }; then
      herdr_orch ensure >/dev/null 2>&1 || true
      nudged=true
      herdr_health_collect
    fi
    if [ "$socket_ok" != true ]; then state=down
    elif [ "$registry" != ok ] || [ "$web" = missing ] || [ "$web" = unreachable ]; then state=degraded
    else state=ok
    fi
  fi
  problems=$(herdr_health_problems)
  if [ "$json" -eq 1 ]; then
    jq -nc --arg state "$state" --arg reason "$(herdr_enabled_reason)" --arg pid "$pid" \
      --argjson pid_alive "$pid_alive" --argjson socket_ok "$socket_ok" --arg registry "$registry" \
      --arg registry_path "$(herdr_web_envs_dir)/$HERDR_WEB_ENV_ID.json" --arg web "$web" \
      --arg web_url "$(herdr_web_url)" --arg env_id "$HERDR_WEB_ENV_ID" --argjson nudged "$nudged" \
      --arg problems "$problems" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{state: $state, enabled: ($state != "off"), reason: $reason, env_id: $env_id,
        pid: (if $pid == "" then null else ($pid | tonumber? // null) end), pid_alive: $pid_alive,
        socket_ok: $socket_ok, registry: $registry, registry_path: $registry_path, web: $web,
        web_url: $web_url, nudged: $nudged, at: $at,
        problems: ($problems | split("\n") | map(select(. != "")))}'
  else
    printf 'herdr health: %s (%s)\n' "$state" "$(herdr_enabled_reason)"
    if [ "$state" != off ]; then
      printf 'server pid: %s (%s)\nsocket: %s\nregistry: %s (%s)\nweb: %s (%s)\n' "${pid:-none}" \
        "$([ "$pid_alive" = true ] && echo alive || echo dead)" "$([ "$socket_ok" = true ] && echo answers || echo no answer)" \
        "$registry" "$(herdr_web_envs_dir)/$HERDR_WEB_ENV_ID.json" "$web" "$(herdr_web_url)"
      [ "$nudged" = false ] || printf 'nudged: re-ensured the instance and its registry\n'
      [ -z "$problems" ] || printf '%s\n' "$problems" | sed 's/^/problem: /'
    fi
  fi
  case "$state" in ok|off) return 0 ;; degraded) return 1 ;; *) return 3 ;; esac
}

# Sets pid, pid_alive, socket_ok, registry and web in the caller (herdr_health).
herdr_health_collect() {
  pid=$(tr -d ' \n' < "$(herdr_dir)/server.pid" 2>/dev/null || true)
  pid_alive=false; herdr_server_pid_alive "$pid" && pid_alive=true
  socket_ok=false; herdr_server_running && socket_ok=true
  registry=$(herdr_web_entry_state)
  web=$(herdr_web_listed)
}

herdr_health_problems() {
  [ "$state" != off ] || return 0
  [ "$socket_ok" = true ] || printf 'the orch herdr instance does not answer on its socket\n'
  [ "$pid_alive" = true ] || [ "$socket_ok" != true ] || printf 'the server pidfile is stale\n'
  case "$registry" in
    missing) printf 'herdr web registry file is missing\n' ;;
    wrong) printf 'herdr web registry file does not match the instance\n' ;;
  esac
  case "$web" in
    missing) printf 'herdr web does not list %s\n' "$HERDR_WEB_ENV_ID" ;;
    unreachable) printf 'herdr web lists %s but cannot reach its socket\n' "$HERDR_WEB_ENV_ID" ;;
    no-plugin) printf 'herdr web plugin does not answer at %s\n' "$(herdr_web_url)" ;;
  esac
}

# herdr_serve_boot: `dispatch.sh serve` (and so the service) ensures and registers the instance at
# start, in the background so the server's start is never delayed. The server's herdr watcher keeps
# it alive afterwards (`herdr health --nudge`).
herdr_serve_boot() {
  herdr_enabled || return 0
  ( herdr_orch ensure ) </dev/null >/dev/null 2>&1 &
  disown $! 2>/dev/null || true
  return 0
}

# herdr_ensure_server: starts the instance when it is not running (idempotent, single flight).
herdr_ensure_server() {
  local inst dir log waited=0 pid
  herdr_bin_present || return 1
  herdr_server_running && return 0
  # Single flight: one starter at a time; the others wait and then find it running.
  while ! orch_lock_acquire herdr-ensure; do
    sleep 0.5; waited=$((waited + 1))
    herdr_server_running && return 0
    [ "$waited" -lt $((HERDR_START_WAIT_SECS * 2)) ] || return 1
  done
  herdr_server_running && { orch_lock_release herdr-ensure; return 0; }
  dir=$(herdr_dir); log="$dir/server.log"
  inst=$(herdr_inst_home) || { orch_lock_release herdr-ensure; return 1; }
  [ -f "$inst/.config/herdr/config.toml" ] || printf '%s' "$HERDR_CONFIG_TOML" > "$inst/.config/herdr/config.toml"
  # A socket left by a crashed server blocks the next one: move it aside (never delete).
  [ ! -e "$inst/.config/herdr/herdr.sock" ] || recoverable_remove "$inst/.config/herdr/herdr.sock"
  herdr_env_args "$inst"
  run_detached "${HERDR_ENV_ARGS[@]}" herdr server >>"$log" 2>&1 </dev/null &
  pid=$!
  disown "$pid" 2>/dev/null || true
  printf '%s\n' "$pid" > "$dir/server.pid"
  waited=0
  while ! herdr_server_running; do
    waited=$((waited + 1))
    [ "$waited" -lt $((HERDR_START_WAIT_SECS * 4)) ] || { orch_lock_release herdr-ensure; return 1; }
    sleep 0.25
  done
  orch_lock_release herdr-ensure
  return 0
}

# herdr_orch ensure|status|stop|attach-hint
herdr_orch() {
  local sub="${1:-status}" waited=0
  case "$sub" in
    status) herdr_server_running ;;
    attach-hint) herdr_attach_hint ;;
    stop)
      herdr_server_running || { herdr_web_unregister; return 0; }
      herdr_cli server stop >/dev/null 2>&1
      while herdr_server_running && [ "$waited" -lt 20 ]; do sleep 0.5; waited=$((waited + 1)); done
      ! herdr_server_running && { : > "$(herdr_dir)/server.pid"; herdr_web_unregister; return 0; }
      return 1 ;;
    ensure) herdr_ensure_server || return 1; herdr_web_register; return 0 ;;
    *) return 2 ;;
  esac
}

# Herdr shows labels with a "[n] " prefix, so a label matches exactly or as that suffix.
HERDR_LABEL_FILTER='select(.label == $l or (.label // "" | endswith(" " + $l)))'

# herdr_target_pane <tab-label> <cwd>: prints the pane id the next job runs in, creating the orch
# workspace, the run's tab, or a split pane as needed. Returns 1 at the pane cap.
herdr_target_pane() {
  local tab_label="$1" cwd="$2" workspace_id tab_id created panes pane_count last_pane direction cap total
  cap="${ORCH_HERDR_PANE_CAP:-$HERDR_PANE_CAP_DEFAULT}"
  total=$(herdr_cli pane list | jq -r '.result.panes | length') || return 1
  [ "$total" -lt "$cap" ] || return 1
  workspace_id=$(herdr_cli workspace list | jq -r --arg l "$HERDR_WORKSPACE_LABEL" \
    "[.result.workspaces[] | $HERDR_LABEL_FILTER][0].workspace_id // empty") || return 1
  if [ -z "$workspace_id" ]; then
    created=$(herdr_cli workspace create --cwd "$cwd" --label "$HERDR_WORKSPACE_LABEL" --no-focus) || return 1
    tab_id=$(printf '%s' "$created" | jq -r '.result.tab.tab_id // empty')
    [ -n "$tab_id" ] && herdr_cli tab rename "$tab_id" "$tab_label" >/dev/null || return 1
    printf '%s' "$created" | jq -er '.result.root_pane.pane_id'
    return
  fi
  tab_id=$(herdr_cli tab list --workspace "$workspace_id" | jq -r --arg l "$tab_label" \
    "[.result.tabs[] | $HERDR_LABEL_FILTER][0].tab_id // empty") || return 1
  if [ -z "$tab_id" ]; then
    herdr_cli tab create --workspace "$workspace_id" --cwd "$cwd" --label "$tab_label" --no-focus \
      | jq -er '.result.root_pane.pane_id'
    return
  fi
  panes=$(herdr_cli pane list --workspace "$workspace_id" | jq -c --arg t "$tab_id" \
    '[.result.panes[] | select(.tab_id == $t) | .pane_id]') || return 1
  pane_count=$(printf '%s' "$panes" | jq 'length')
  last_pane=$(printf '%s' "$panes" | jq -r '.[-1] // empty')
  [ -n "$last_pane" ] || return 1
  direction=right
  [ $((pane_count % 2)) -eq 0 ] && direction=down
  herdr_cli pane split "$last_pane" --direction "$direction" --cwd "$cwd" --no-focus \
    | jq -er '.result.pane.pane_id'
}

# Writes the script the pane runs. The pane shell inherits the instance HOME, so the launcher
# restores the real HOME and the job's env first. It carries only the orch env, PATH, a short
# allow-list and the job's argv, so no other secret from the caller's environment lands on disk.
# It execs the job wrapper (the wrapper writes pid-visible status and exit_code, as for a detached
# job); a background closer closes the pane after a successful exit and leaves a failed one open.
herdr_write_launcher() {
  local launcher="$1" job_dir="$2" start_script="$3" pane_id="$4" inst="$5" close_after="$6" name
  shift 6
  {
    printf '#!/usr/bin/env bash\n'
    printf 'unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID\n'
    for name in $(compgen -e | grep -E '^(ORCH_|HARNESS_ORCH_)|^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR|SSH_AUTH_SOCK|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$'); do
      printf 'export %s=%q\n' "$name" "${!name}"
    done
    printf 'cd -- %q || exit 1\n' "$PWD"
    printf 'me=$$\n'
    printf 'printf %%s "$me" > %q\n' "$job_dir/pid"
    printf '( while kill -0 "$me" 2>/dev/null; do sleep 1; done\n'
    printf '  [ "$(cat %q 2>/dev/null)" = 0 ] || exit 0\n' "$job_dir/exit_code"
    printf '  sleep %q\n' "$close_after"
    printf '  env -i PATH=%q HOME=%q herdr pane close %q >/dev/null 2>&1\n' "$PATH" "$inst" "$pane_id"
    printf ') >/dev/null 2>&1 </dev/null &\n'
    printf 'disown 2>/dev/null\n'
    printf 'exec bash -c %q _' "$start_script"
    printf ' %q' "$@"
    printf ' > >(tee %q) 2>&1 </dev/null\n' "$job_dir/log"
  } > "$launcher" && chmod 700 "$launcher"
}

# herdr_start_job <job_dir> <start_script> <argv...>: runs the job in a pane of the orch instance.
# Returns 1 when nothing runs there (disabled, herdr missing, unreachable, pane cap), so the caller
# falls back to a detached job.
herdr_start_job() {
  local job_dir="$1" start_script="$2" launcher pane_id inst title close_after
  shift 2
  herdr_enabled || return 1
  herdr_orch ensure 2>/dev/null || return 1
  inst=$(herdr_inst_home) || return 1
  pane_id=$(herdr_target_pane "${ORCH_RUN_ID:-$HERDR_NO_RUN_TAB_LABEL}" "$PWD" 2>/dev/null) || return 1
  [ -n "$pane_id" ] || return 1
  close_after="${ORCH_HERDR_CLOSE_AFTER:-$HERDR_CLOSE_AFTER_DEFAULT}"
  launcher="$job_dir/herdr-launch.sh"
  herdr_write_launcher "$launcher" "$job_dir" "$start_script" "$pane_id" "$inst" "$close_after" "$@" || return 1
  title="${ORCH_RUN_ID:-job} ${ORCH_NODE_ID:-$HERDR_NO_RUN_TAB_LABEL} $(basename "$job_dir")"
  herdr_cli pane rename "$pane_id" "$title" >/dev/null 2>&1 || true
  if ! herdr_cli pane run "$pane_id" "bash $(printf '%q' "$launcher")" >/dev/null 2>&1; then
    herdr_cli pane close "$pane_id" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s\n' "$pane_id" > "$job_dir/herdr_pane"
  printf '%s\n' "$inst" > "$job_dir/herdr_home"
  printf '%s/.config/herdr/herdr.sock\n' "$inst" > "$job_dir/herdr_sock"
  return 0
}

herdr_setting_write() {
  local filter="$1" tmp="$PROFILES_FILE.tmp.$$"
  if ! jq "$filter" "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'herdr: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp"
}

# herdr_job_gone_note <job_dir>: why a job with no exit code is gone, for the node's event log.
herdr_job_gone_note() {
  local job_dir="$1" pane started booted note
  note="job process gone without an exit code"
  pane=$(cat "$job_dir/herdr_pane" 2>/dev/null || true)
  [ -z "$pane" ] || note="$note; its orch-herdr pane $pane is gone or idle"
  started=$(file_mtime "$job_dir/pid" 2>/dev/null) || started=""
  booted=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p')
  [ -n "$booted" ] || booted=$(( $(date +%s) - $(cut -d. -f1 /proc/uptime 2>/dev/null || date +%s) ))
  if [ -n "$started" ] && [ -n "$booted" ] && [ "$booted" -gt "$started" ] 2>/dev/null; then
    note="$note; the host rebooted after the job started"
  fi
  printf '%s\n' "$note"
}

cmd_herdr() {
  require_jq "herdr"
  ensure_home || return 1
  case "${1:-}" in
    on) herdr_setting_write '.settings.herdr = true' || return 1 ;;
    off) herdr_setting_write '.settings.herdr = false' || return 1 ;;
    auto) herdr_setting_write 'del(.settings.herdr)' || return 1 ;;
    status|attach) ;;
    ensure)
      herdr_orch ensure || { printf 'herdr: could not start the orch instance\n' >&2; return 1; } ;;
    stop) herdr_orch stop || return 1 ;;
    health) shift; herdr_health "$@"; return $? ;;
    *) printf 'usage: %s\n' "$HERDR_USAGE" >&2; return 2 ;;
  esac
  printf 'herdr: %s\n' "$(herdr_enabled_reason)"
  if herdr_server_running; then
    printf 'server: running\n'
  elif herdr_bin_present; then
    printf 'server: not running (started by serve and on the first job; jobs start detached if it cannot start)\n'
  else
    printf 'server: herdr not on PATH (jobs start detached)\n'
  fi
  if herdr_bin_present; then
    printf 'home: %s\n' "$(herdr_inst_home)"
    printf 'log: %s/server.log\n' "$(herdr_dir)"
    printf 'attach (in a separate terminal, never inside your own herdr pane): %s\n' "$(herdr_attach_hint)"
  fi
}
