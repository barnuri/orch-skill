#!/usr/bin/env bash
# `serve`/`ui` lifecycle for orch — sourced by dispatch.sh, never executed.
# One Bun server per config home. `serve` runs it in the foreground; `ui` reuses a healthy one,
# starts one with nohup when nothing answers, and restarts it when the skill sources are newer
# than the running server (Bun bundles the dashboard once at startup and caches it in-process).
#
# Bind address, port and auth policy live in <ORCH_HOME>/serve.json — service and ad-hoc `serve`/`ui`
# both read the same file. CLI --host/--port override for one shot; `serve config set` persists.
#
# The server owns the markers under <ORCH_HOME>/serve/ (host, port, then pid) — this file only
# reads them, and truncates `pid` instead of deleting it (never `rm`).

SERVE_HOME="$ORCH_HOME/serve"
SERVE_PID_FILE="$SERVE_HOME/pid"
SERVE_PORT_FILE="$SERVE_HOME/port"
SERVE_HOST_FILE="$SERVE_HOME/host"
SERVE_LOG_FILE="$SERVE_HOME/log"
SERVE_TOKEN_FILE="$ORCH_HOME/serve.token"
SERVE_CONFIG_FILE="$ORCH_HOME/serve.json"
SERVE_CONFIG_TEMPLATE="$TEMPLATES_DIR/serve.json"
SERVE_ENTRY="$SCRIPT_DIR/../server/main.ts"
SERVE_SOURCE_DIRS="$SCRIPT_DIR/../server $SCRIPT_DIR/../dashboard $SCRIPT_DIR/../shared"
SERVE_DEFAULT_HOST=0.0.0.0
SERVE_DEFAULT_PORT=6724
SERVE_MAX_PORT=65535
SERVE_START_WAIT_TICKS=50
SERVE_STOP_WAIT_TICKS=50

SERVE_USAGE='dispatch.sh serve [--host H] [--port P] | serve --stop'
SERVE_CONFIG_USAGE='dispatch.sh serve config show | serve config get <key> | serve config set [--host H] [--port P] [--require-token|--no-require-token] [--allow-remote|--no-allow-remote]'
UI_USAGE='dispatch.sh ui [--stop]'

# Copies templates/serve.json on first use; never overwrites an existing file.
ensure_serve_config() {
  ensure_home || return 1
  [ -f "$SERVE_CONFIG_FILE" ] && return 0
  [ -f "$SERVE_CONFIG_TEMPLATE" ] || {
    printf 'serve: template %s missing\n' "$SERVE_CONFIG_TEMPLATE" >&2
    return 1
  }
  cp "$SERVE_CONFIG_TEMPLATE" "$SERVE_CONFIG_FILE" || return 1
}

# serve_config_get <key> <default> — scalar value as text; booleans print true/false.
serve_config_get() {
  local key="$1" default="$2"
  if [ ! -f "$SERVE_CONFIG_FILE" ]; then
    printf '%s\n' "$default"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$default"
    return 0
  fi
  jq -r --arg k "$key" --arg d "$default" '.[$k] // $d' "$SERVE_CONFIG_FILE" 2>/dev/null \
    || printf '%s\n' "$default"
}

serve_config_bool() {
  case "$(serve_config_get "$1" false)" in
    true|1) return 0 ;;
  esac
  return 1
}

serve_config_load_bind() {
  ensure_serve_config || return $?
  SERVE_HOST=$(serve_config_get host "$SERVE_DEFAULT_HOST")
  SERVE_PORT=$(serve_config_get port "$SERVE_DEFAULT_PORT")
}

# ORCH_REQUIRE_TOKEN / ORCH_ALLOW_REMOTE override serve.json (used by tests).
serve_config_require_token() {
  [ -n "${ORCH_REQUIRE_TOKEN:-}" ] && return 0
  serve_config_bool require_token
}

serve_config_allow_remote() {
  [ -n "${ORCH_ALLOW_REMOTE:-}" ] && return 0
  serve_config_bool allow_remote
}

# Prints zero or more auth flags for the bun argv line (must not use `set` — callers own $@).
serve_auth_argv() {
  local out=""
  if serve_config_require_token; then
    out="--require-token"
  fi
  if serve_config_allow_remote; then
    out="${out:+$out }--allow-remote"
  fi
  printf '%s' "$out"
}

# Prints the bun binary to use, or explains its absence and returns 127.
serve_bun() {
  local bun_bin="${ORCH_BUN:-bun}"
  if ! command -v "$bun_bin" >/dev/null 2>&1; then
    printf 'serve: %s not found on PATH — install Bun 1.3+ (https://bun.sh) or set ORCH_BUN\n' "$bun_bin" >&2
    return 127
  fi
  printf '%s\n' "$bun_bin"
}

# parse_serve_opts <caller> [args…] — sets SERVE_HOST / SERVE_PORT / SERVE_STOP.
# `ui` takes only --stop: the bind address belongs to `serve`, and `ui` always opens 127.0.0.1.
parse_serve_opts() {
  local caller="$1" usage="$SERVE_USAGE" flag
  shift
  [ "$caller" != ui ] || usage="$UI_USAGE"
  serve_config_load_bind || return $?
  SERVE_STOP=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --stop) SERVE_STOP=1 ;;
      --host|--port)
        if [ "$caller" = ui ]; then
          printf '%s: unknown argument %s\n  usage: %s\n' "$caller" "$1" "$usage" >&2
          return 2
        fi
        flag="$1"
        shift
        if [ "$flag" = --host ]; then
          SERVE_HOST="${1:-}"
          [ -n "$SERVE_HOST" ] || { printf '%s: --host expects a host\n' "$caller" >&2; return 2; }
        else
          SERVE_PORT="${1:-}"
          if ! is_uint "$SERVE_PORT" || [ "$SERVE_PORT" -gt "$SERVE_MAX_PORT" ]; then
            printf '%s: --port expects 0-%s\n' "$caller" "$SERVE_MAX_PORT" >&2
            return 2
          fi
        fi
        ;;
      *) printf '%s: unknown argument %s\n  usage: %s\n' "$caller" "$1" "$usage" >&2; return 2 ;;
    esac
    shift
  done
}

parse_serve_config_set_opts() {
  CONFIG_SET_HOST=""
  CONFIG_SET_PORT=""
  CONFIG_SET_REQUIRE_TOKEN=""
  CONFIG_SET_ALLOW_REMOTE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)
        shift
        CONFIG_SET_HOST="${1:-}"
        [ -n "$CONFIG_SET_HOST" ] || { printf 'serve config set: --host expects a host\n' >&2; return 2; }
        ;;
      --port)
        shift
        CONFIG_SET_PORT="${1:-}"
        if ! is_uint "$CONFIG_SET_PORT" || [ "$CONFIG_SET_PORT" -gt "$SERVE_MAX_PORT" ]; then
          printf 'serve config set: --port expects 0-%s\n' "$SERVE_MAX_PORT" >&2
          return 2
        fi
        ;;
      --require-token) CONFIG_SET_REQUIRE_TOKEN=1 ;;
      --no-require-token) CONFIG_SET_REQUIRE_TOKEN=0 ;;
      --allow-remote) CONFIG_SET_ALLOW_REMOTE=1 ;;
      --no-allow-remote) CONFIG_SET_ALLOW_REMOTE=0 ;;
      *) printf 'serve config set: unknown argument %s\n  usage: %s\n' "$1" "$SERVE_CONFIG_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  return 0
}

serve_config_write() {
  local host="$1" port="$2" require_token="$3" allow_remote="$4" tmp
  require_jq "serve config set" || return 127
  tmp="${SERVE_CONFIG_FILE}.tmp.$$"
  jq -n \
    --arg host "$host" \
    --argjson port "$port" \
    --argjson require_token "$require_token" \
    --argjson allow_remote "$allow_remote" \
    '{host: $host, port: $port, require_token: $require_token, allow_remote: $allow_remote}' \
    >"$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$SERVE_CONFIG_FILE"
}

serve_config_merge() {
  local host port rt ar rt_json ar_json
  ensure_serve_config || return $?
  host=$(serve_config_get host "$SERVE_DEFAULT_HOST")
  port=$(serve_config_get port "$SERVE_DEFAULT_PORT")
  rt=$(serve_config_get require_token false)
  ar=$(serve_config_get allow_remote false)
  [ -n "${CONFIG_SET_HOST:-}" ] && host="$CONFIG_SET_HOST"
  [ -n "${CONFIG_SET_PORT:-}" ] && port="$CONFIG_SET_PORT"
  [ -n "${CONFIG_SET_REQUIRE_TOKEN:-}" ] && {
    [ "$CONFIG_SET_REQUIRE_TOKEN" -eq 1 ] && rt=true || rt=false
  }
  [ -n "${CONFIG_SET_ALLOW_REMOTE:-}" ] && {
    [ "$CONFIG_SET_ALLOW_REMOTE" -eq 1 ] && ar=true || ar=false
  }
  case "$rt" in true|1) rt_json=true ;; *) rt_json=false ;; esac
  case "$ar" in true|1) ar_json=true ;; *) ar_json=false ;; esac
  serve_config_write "$host" "$port" "$rt_json" "$ar_json"
}

cmd_serve_config() {
  local verb="${1:-}"
  shift || true
  case "$verb" in
    show)
      ensure_serve_config || return $?
      cat "$SERVE_CONFIG_FILE"
      ;;
    get)
      local key="${1:-}"
      [ -n "$key" ] || { printf 'usage: %s\n' "$SERVE_CONFIG_USAGE" >&2; return 2; }
      ensure_serve_config || return $?
      serve_config_get "$key" ""
      ;;
    set)
      parse_serve_config_set_opts "$@" || return $?
      serve_config_merge || return $?
      cat "$SERVE_CONFIG_FILE"
      ;;
    *)
      printf 'usage: %s\n' "$SERVE_CONFIG_USAGE" >&2
      return 2
      ;;
  esac
}

# serve/ is 0700 and its log 0600 because the log holds the tokenized URL bun prints at startup.
serve_prepare_home() {
  ensure_serve_config || return $?
  (umask 077 && mkdir -p "$SERVE_HOME" && : >>"$SERVE_LOG_FILE") && return 0
  printf 'serve: cannot prepare %s\n' "$SERVE_HOME" >&2
  return 1
}

serve_pid() { cat "$SERVE_PID_FILE" 2>/dev/null || printf ''; }
serve_port() { cat "$SERVE_PORT_FILE" 2>/dev/null || printf ''; }
serve_host() { cat "$SERVE_HOST_FILE" 2>/dev/null || printf ''; }

serve_pid_alive() {
  is_uint "${1:-}" || return 1
  kill -0 "$1" 2>/dev/null
}

# serve_probe <port> — proves a listener is there without ever putting the token on argv (`ps` is
# world-readable), so 401 counts as alive. curl's 000 means "did not connect"; no curl at all
# degrades to "assume alive" rather than killing a healthy server.
serve_probe() {
  local port="${1:-}" code
  command -v curl >/dev/null 2>&1 || return 0
  is_uint "$port" || return 1
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$port/api/health" 2>/dev/null)
  case "$code" in
    [1-9][0-9][0-9]) return 0 ;;
  esac
  return 1
}

# 0 = a server is answering, 1 = nothing is running (a stale pid marker is truncated, never
# deleted), 3 = the process is alive but nothing answers — a state only the user can resolve.
serve_running() {
  local pid port
  pid=$(serve_pid)
  port=$(serve_port)
  if ! serve_pid_alive "$pid"; then
    [ -z "$pid" ] || : >"$SERVE_PID_FILE"
    return 1
  fi
  [ -n "$port" ] || return 1
  serve_probe "$port" && return 0
  printf 'ui: pid %s is alive but nothing answers on 127.0.0.1:%s; run dispatch.sh ui --stop to reset\n' \
    "$pid" "$port" >&2
  return 3
}

# True when a skill source is newer than the pid marker — i.e. the running server bundled code
# that no longer exists on disk (production mode never re-reads it).
serve_sources_changed() {
  [ -s "$SERVE_PID_FILE" ] || return 1
  # SERVE_SOURCE_DIRS is a space-separated directory list — unquoted on purpose.
  # shellcheck disable=SC2086
  [ -n "$(find $SERVE_SOURCE_DIRS -type f -newer "$SERVE_PID_FILE" 2>/dev/null | head -n 1)" ]
}

# Starts the server detached using serve.json and waits for it to publish its markers.
serve_start_background() {
  local bun_bin bg tick=0
  bun_bin=$(serve_bun) || return $?
  serve_prepare_home || return $?
  serve_config_load_bind || return $?
  # shellcheck disable=SC2046
  set -- "$SERVE_ENTRY" --home "$ORCH_HOME" --host "$SERVE_HOST" --port "$SERVE_PORT" \
    --harnesses "$VALID_HARNESSES" --outcomes "$VALID_OUTCOMES" $(serve_auth_argv)

  nohup "$bun_bin" "$@" >>"$SERVE_LOG_FILE" 2>&1 </dev/null &
  bg=$!
  disown "$bg" 2>/dev/null || true

  while [ "$tick" -lt "$SERVE_START_WAIT_TICKS" ]; do
    if [ "$(serve_pid)" = "$bg" ] && serve_probe "$(serve_port)"; then
      return 0
    fi
    kill -0 "$bg" 2>/dev/null || break
    sleep 0.1
    tick=$((tick + 1))
  done

  printf 'ui: server did not start; last log lines:\n' >&2
  tail -n 5 "$SERVE_LOG_FILE" >&2
  return 1
}

# The URL `ui` opens and prints. It always targets 127.0.0.1, which the server exempts from auth
# unless serve.json sets require_token (or ORCH_REQUIRE_TOKEN overrides in tests).
serve_url() {
  if serve_config_require_token; then
    printf 'http://127.0.0.1:%s/?token=%s\n' "$(serve_port)" "$(cat "$SERVE_TOKEN_FILE" 2>/dev/null)"
    return 0
  fi
  printf 'http://127.0.0.1:%s/\n' "$(serve_port)"
}

# SIGTERM, then SIGKILL after SERVE_STOP_WAIT_TICKS×0.1s. The pid marker is truncated the same way
# the server truncates it on a clean exit.
serve_stop() {
  local pid tick=0
  pid=$(serve_pid)
  if ! serve_pid_alive "$pid"; then
    printf 'serve: not running\n'
    serve_clear_pid
    return 0
  fi

  kill "$pid" 2>/dev/null
  while [ "$tick" -lt "$SERVE_STOP_WAIT_TICKS" ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
    tick=$((tick + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
  fi

  serve_clear_pid
  printf 'serve: stopped (pid %s)\n' "$pid"
}

serve_clear_pid() {
  [ ! -f "$SERVE_PID_FILE" ] || : >"$SERVE_PID_FILE"
}

# serve [--host H] [--port P] | serve --stop — runs bun in the foreground (Ctrl-C hits bun, which
# prints the URLs, writes the markers and empties the pid marker on its way out).
cmd_serve() {
  local bun_bin rc
  parse_serve_opts serve "$@" || return $?
  [ "$SERVE_STOP" -eq 0 ] || { serve_stop; return $?; }
  bun_bin=$(serve_bun) || return $?
  [ -f "$SERVE_ENTRY" ] || { printf 'serve: %s missing\n' "$SERVE_ENTRY" >&2; return 1; }

  serve_running
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'serve: already running on %s:%s (pid %s); use dispatch.sh serve --stop first\n' \
      "$(serve_host)" "$(serve_port)" "$(serve_pid)" >&2
    return 1
  fi
  [ "$rc" -ne 3 ] || return 1

  serve_prepare_home || return 1
  # shellcheck disable=SC2046
  set -- "$SERVE_ENTRY" --home "$ORCH_HOME" --host "$SERVE_HOST" --port "$SERVE_PORT" \
    --harnesses "$VALID_HARNESSES" --outcomes "$VALID_OUTCOMES" $(serve_auth_argv)
  exec "$bun_bin" "$@"
}

# ui [--stop] — reuse, restart or start the shared server, then open the tokenized URL.
# ORCH_NO_OPEN=1 prints the URL only (tests, CI, remote shells).
cmd_ui() {
  local rc url expected_host expected_port
  parse_serve_opts ui "$@" || return $?
  [ "$SERVE_STOP" -eq 0 ] || { serve_stop; return $?; }

  expected_host="$SERVE_HOST"
  expected_port="$SERVE_PORT"

  serve_running
  rc=$?
  [ "$rc" -ne 3 ] || return 1
  if [ "$rc" -eq 0 ] && serve_sources_changed; then
    printf 'ui: skill sources changed since the server started — restarting it\n' >&2
    serve_stop >/dev/null
    rc=1
  fi

  if [ "$rc" -eq 0 ]; then
    if [ "$(serve_host)" != "$expected_host" ] || [ "$(serve_port)" != "$expected_port" ]; then
      printf 'ui: reusing the server running on %s:%s\n' "$(serve_host)" "$(serve_port)" >&2
    fi
  else
    serve_start_background || return $?
  fi

  url=$(serve_url)
  printf '%s\n' "$url"
  [ -z "${ORCH_NO_OPEN:-}" ] || return 0
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}
