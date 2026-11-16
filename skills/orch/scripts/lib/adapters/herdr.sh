#!/usr/bin/env bash
# Dedicated herdr instance for dispatch.sh — sourced, never executed. The orch skill never touches
# the user's live herdr session: jobs run in panes of a second, headless herdr server that lives
# under <orch-home>/herdr/ with its own HOME, minimal config.toml (no plugins), socket, pidfile
# and log. Every herdr call here is best effort; when it fails the caller starts the job detached.

HERDR_USAGE='dispatch.sh herdr on|off|auto|status|attach|ensure|stop | herdr health [--json] [--nudge]'
HERDR_NO_RUN_TAB_LABEL="jobs"
HERDR_PID_WAIT_SECS=15
HERDR_PANE_CAP_DEFAULT=20
HERDR_LINGER_DEFAULT=600
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
  while IFS= read -r name; do HERDR_ENV_ARGS+=("$name=${!name-}"); done < <(compgen -e | grep -E '^ORCH_HERDR_')
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

# One workspace per run, labelled with the run id. herdr_run_workspace <run-label> <cwd> prints
# "<workspace_id>\t<root_tab_id>\t<root_pane_id>". The root tab and pane are set only when this call
# created the workspace; herdr_start_job closes that empty default tab after the first node tab exists.
herdr_run_workspace() {
  local label="$1" cwd="$2" ws created
  ws=$(herdr_cli workspace list | jq -r --arg l "$label" \
    "[.result.workspaces[] | $HERDR_LABEL_FILTER][0].workspace_id // empty") || return 1
  if [ -n "$ws" ]; then printf '%s\t\t\n' "$ws"; return 0; fi
  created=$(herdr_cli workspace create --cwd "$cwd" --label "$label" --no-focus) || return 1
  printf '%s' "$created" | jq -er '[.result.workspace.workspace_id, .result.tab.tab_id, .result.root_pane.pane_id] | @tsv'
}

# herdr_node_tab_create <workspace_id> <title> <cwd>: prints "<tab_id>\t<pane_id>" of a new tab.
herdr_node_tab_create() {
  herdr_cli tab create --workspace "$1" --cwd "$3" --label "$2" --no-focus \
    | jq -er '[.result.tab.tab_id, .result.root_pane.pane_id] | @tsv'
}

# herdr_find_node_tab <workspace_id> <node-id>: the node's tab, whatever its attempt suffix is.
# Herdr prefixes labels with "[n] ", and a retry titles the tab "<node> #<attempt>".
herdr_find_node_tab() {
  herdr_cli tab list --workspace "$1" | jq -r --arg n "$2" \
    '[.result.tabs[] | select((.label // "") | sub("^\\[[0-9]+\\] "; "") | sub(" #[0-9]+$"; "") == $n)][0].tab_id // empty'
}

herdr_tab_first_pane() {
  herdr_cli pane list --workspace "$1" | jq -r --arg t "$2" \
    '[.result.panes[] | select(.tab_id == $t) | .pane_id][0] // empty'
}

# The owner file names the job that currently runs in a tab. A retry reuses the tab, so only the
# owner may close it: an older attempt's closer finds another owner and leaves the tab open.
herdr_owner_file() {
  printf '%s/tabs/%s.job\n' "$(herdr_dir)" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
}

# How long an ended job's tab stays open. ORCH_HERDR_CLOSE_AFTER overrides the setting.
herdr_linger_sec() {
  local v="${ORCH_HERDR_CLOSE_AFTER:-$(setting_get herdr_linger_sec "$HERDR_LINGER_DEFAULT")}"
  case "$v" in ''|*[!0-9]*) printf '%s\n' "$HERDR_LINGER_DEFAULT" ;; *) printf '%s\n' "$v" ;; esac
}

# herdr_close_job_tab <job_dir>: closes the job's tab now when this job still owns it (cancelled or
# duplicate jobs). Best effort, never fails the caller.
herdr_close_job_tab() {
  local job_dir="$1" tab
  tab=$(cat "$job_dir/herdr_tab" 2>/dev/null || true)
  [ -n "$tab" ] || return 0
  [ "$(cat "$(herdr_owner_file "$tab")" 2>/dev/null)" = "$job_dir" ] || return 0
  herdr_cli tab close "$tab" >/dev/null 2>&1 || true
  return 0
}

# Writes the script the pane runs. The pane shell inherits the instance HOME, so the launcher
# restores the real HOME and the job's env first. It carries only the orch env, PATH, a short
# allow-list, so no other secret from the caller's environment lands on disk. The job's argv is
# in <job_dir>/argv.json, read by the TypeScript launcher, which runs the job under a pty and writes
# log, log.plain and exit_code. A background closer closes the job's tab once the job has ended and
# the linger has passed, but only while this job still owns the tab (see herdr_owner_file).
# Bun is required: without it the shim prints the requirement and exits 127.
# herdr_write_launcher <launcher> <job_dir> <tab_id> <owner_file> <inst> <linger>
herdr_write_launcher() {
  local launcher="$1" job_dir="$2" tab_id="$3" owner="$4" inst="$5" linger="$6" name
  {
    printf '#!/usr/bin/env bash\n'
    printf '%s\n' 'command -v bun >/dev/null 2>&1 || { echo "orch needs bun: install it from https://bun.sh" >&2; exit 127; }'
    printf 'unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID\n'
    for name in $(compgen -e | grep -E '^(ORCH_|HARNESS_ORCH_)|^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR|SSH_AUTH_SOCK|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$'); do
      printf 'export %s=%q\n' "$name" "${!name}"
    done
    printf 'cd -- %q || exit 1\n' "$PWD"
    printf 'me=$$\n'
    printf 'printf %%s "$me" > %q\n' "$job_dir/pid"
    printf '( while kill -0 "$me" 2>/dev/null; do sleep 1; done\n'
    printf '  sleep %q\n' "$linger"
    printf '  [ "$(cat %q 2>/dev/null)" = %q ] || exit 0\n' "$owner" "$job_dir"
    printf '  env -i PATH=%q HOME=%q herdr tab close %q >/dev/null 2>&1\n' "$PATH" "$inst" "$tab_id"
    printf ') >/dev/null 2>&1 </dev/null &\n'
    printf 'disown 2>/dev/null\n'
    printf 'exec bun %q %q\n' "$(herdr_launch_ts)" "$job_dir"
  } > "$launcher" && chmod 700 "$launcher"
}

# herdr_launch_ts: the TypeScript launcher path, resolved when a launcher is written (not at source time).
herdr_launch_ts() { printf '%s/herdr-launch.ts\n' "$(cd "$SCRIPT_DIR/../core/commands" && pwd -P)"; }

# herdr_start_job <job_dir> <start_script> <argv...>: runs the job in its own tab of the run's
# workspace in the orch instance. A node's retry reuses the node's tab. Returns 1 when nothing runs
# there (disabled, herdr missing, unreachable, pane cap), so the caller falls back to a detached job.
herdr_start_job() {
  local job_dir="$1" start_script="$2" launcher run base attempt title total ws root_tab root_pane
  local tab_id pane_id inst linger owner
  shift 2
  herdr_enabled || return 1
  herdr_orch ensure 2>/dev/null || return 1
  inst=$(herdr_inst_home) || return 1
  total=$(herdr_cli pane list | jq -r '.result.panes | length') 2>/dev/null || return 1
  [ "$total" -lt "${ORCH_HERDR_PANE_CAP:-$HERDR_PANE_CAP_DEFAULT}" ] || return 1
  run="${ORCH_RUN_ID:-$HERDR_NO_RUN_TAB_LABEL}"
  base="${ORCH_NODE_ID:-$(basename "$job_dir")}"
  attempt="${ORCH_NODE_ATTEMPT:-1}"
  title="$base"
  [ "$attempt" -le 1 ] 2>/dev/null || title="$base #$attempt"
  IFS=$'\t' read -r ws root_tab root_pane <<< "$(herdr_run_workspace "$run" "$PWD" 2>/dev/null)" || return 1
  [ -n "$ws" ] || return 1
  tab_id=""
  [ "$attempt" -le 1 ] || tab_id=$(herdr_find_node_tab "$ws" "$base")
  if [ -n "$tab_id" ]; then
    herdr_cli tab rename "$tab_id" "$title" >/dev/null 2>&1 || return 1
    pane_id=$(herdr_tab_first_pane "$ws" "$tab_id")
  else
    IFS=$'\t' read -r tab_id pane_id <<< "$(herdr_node_tab_create "$ws" "$title" "$PWD" 2>/dev/null)" || return 1
    # The workspace of a new run came with an empty default tab: close it now that the node has its own.
    [ -z "$root_tab" ] || herdr_cli tab close "$root_tab" >/dev/null 2>&1 || true
  fi
  [ -n "$tab_id" ] && [ -n "$pane_id" ] || return 1
  linger=$(herdr_linger_sec)
  owner=$(herdr_owner_file "$tab_id")
  mkdir -p "$(dirname "$owner")" && printf '%s\n' "$job_dir" > "$owner" || return 1
  launcher="$job_dir/herdr-launch.sh"
  jq -n -c '$ARGS.positional' --args -- bash -c "$start_script" _ "$@" > "$job_dir/argv.json" || return 1
  herdr_write_launcher "$launcher" "$job_dir" "$tab_id" "$owner" "$inst" "$linger" || return 1
  herdr_cli pane rename "$pane_id" "$title" >/dev/null 2>&1 || true
  if ! herdr_cli pane run "$pane_id" "bash $(printf '%q' "$launcher")" >/dev/null 2>&1; then
    herdr_cli tab close "$tab_id" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s\n' "$pane_id" > "$job_dir/herdr_pane"
  printf '%s\n' "$tab_id" > "$job_dir/herdr_tab"
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
