#!/usr/bin/env bash
# Optional: run the orch dashboard server as an always-on background service, so the UI is up
# whenever you want it without starting anything by hand. Entirely opt-in — `orch ui` works fine
# without it, starting the same server on demand.
#
#   service.sh install [--host H] [--port P] [--home DIR]   register + start (macOS launchd / Linux systemd --user)
#   service.sh uninstall                                    stop + deregister
#   service.sh restart                                      stop + start
#   service.sh status                                       supervisor state, listener probe, dashboard URL
#   service.sh logs [-n N]                                  tail the service log
#
# The service runs `dispatch.sh serve`, which is the same foreground server `orch ui` starts.
# It binds 127.0.0.1 by default — a permanently-listening service is a bigger exposure than an
# on-demand one, so LAN access (`--host 0.0.0.0`) is opt-in.

set -u

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
SKILL_DIR="$REPO_DIR/skills/orch"
DISPATCH="$SKILL_DIR/scripts/dispatch.sh"

SERVICE_LABEL=io.github.barnuri.orch
SYSTEMD_UNIT_NAME=orch-dashboard.service
DEFAULT_HOST=127.0.0.1
DEFAULT_PORT=6724
THROTTLE_SECS=10

ORCH_HOME="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
SERVICE_HOST="$DEFAULT_HOST"
SERVICE_PORT="$DEFAULT_PORT"

usage() {
  sed -n '2,15p' "$0" | sed 's|^# \{0,1\}||'
}

# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------

# platform: prints `launchd` or `systemd`, or explains why neither applies.
platform() {
  case "$(uname -s)" in
    Darwin) printf 'launchd\n' ;;
    Linux)
      if ! command -v systemctl >/dev/null 2>&1; then
        printf 'service: systemctl not found — this script supports macOS launchd and Linux systemd --user\n' >&2
        return 1
      fi
      printf 'systemd\n'
      ;;
    *)
      printf 'service: unsupported platform %s — run `%s serve` under your own supervisor instead\n' \
        "$(uname -s)" "$DISPATCH" >&2
      return 1
      ;;
  esac
}

is_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

parse_install_opts() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)
        shift
        SERVICE_HOST="${1:-}"
        [ -n "$SERVICE_HOST" ] || { printf 'service: --host expects a host\n' >&2; return 2; }
        ;;
      --port)
        shift
        SERVICE_PORT="${1:-}"
        if ! is_uint "$SERVICE_PORT" || [ "$SERVICE_PORT" -gt 65535 ]; then
          printf 'service: --port expects 0-65535\n' >&2
          return 2
        fi
        ;;
      --home)
        shift
        ORCH_HOME="${1:-}"
        [ -n "$ORCH_HOME" ] || { printf 'service: --home expects a directory\n' >&2; return 2; }
        ;;
      *) printf 'service: unknown argument %s\n\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done
}

# bun_path: absolute path to the bun binary. A supervisor starts with a minimal PATH, so the
# generated unit must name the interpreter outright rather than hope `bun` resolves.
bun_path() {
  local resolved
  if [ -n "${ORCH_BUN:-}" ]; then
    resolved=$(command -v "$ORCH_BUN" 2>/dev/null) || resolved="$ORCH_BUN"
  else
    resolved=$(command -v bun 2>/dev/null)
  fi
  if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then
    printf 'service: bun not found — install Bun 1.3+ (https://bun.sh) or set ORCH_BUN to its path\n' >&2
    return 127
  fi
  printf '%s\n' "$resolved"
}

preflight() {
  [ -f "$DISPATCH" ] || { printf 'service: %s missing — run this from the repo checkout\n' "$DISPATCH" >&2; return 1; }
  bun_path >/dev/null || return $?
  (umask 077 && mkdir -p "$ORCH_HOME/serve") || { printf 'service: cannot create %s\n' "$ORCH_HOME/serve" >&2; return 1; }
}

log_file() { printf '%s/serve/service.log\n' "$ORCH_HOME"; }

dashboard_url() {
  local token
  token=$(cat "$ORCH_HOME/serve.token" 2>/dev/null) || token=""
  if [ -z "$token" ]; then
    printf 'http://127.0.0.1:%s/  (token not minted yet — it appears on first start)\n' "$SERVICE_PORT"
    return 0
  fi
  printf 'http://127.0.0.1:%s/?token=%s\n' "$SERVICE_PORT" "$token"
}

# listening: 0 when something answers the health endpoint. Absent curl is "unknown", not "down".
listening() {
  local code
  command -v curl >/dev/null 2>&1 || return 2
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$SERVICE_PORT/api/health" 2>/dev/null)
  case "$code" in
    [1-9][0-9][0-9]) return 0 ;;
  esac
  return 1
}

# remove_file <path>: recoverable delete via `trash`, else a timestamped move. Never `rm`.
remove_file() {
  local target="$1" graveyard
  [ -e "$target" ] || return 0
  if command -v trash >/dev/null 2>&1; then
    trash "$target"
    return $?
  fi
  graveyard="$ORCH_HOME/.trash/$(date '+%Y%m%d-%H%M%S')"
  mkdir -p "$graveyard" || return 1
  mv "$target" "$graveyard/"
}

# Reads back the host/port a previous install baked into the unit, so `status`, `logs` and
# `uninstall` describe the running service instead of the defaults.
adopt_installed_settings() {
  local unit host port
  unit=$(unit_path)
  [ -f "$unit" ] || return 0
  host=$(grep -o -- '--host[^a-zA-Z0-9]*[0-9A-Za-z.:]*' "$unit" 2>/dev/null | tail -n 1 | grep -oE '[0-9A-Za-z.:]+$')
  port=$(grep -o -- '--port[^0-9]*[0-9]*' "$unit" 2>/dev/null | tail -n 1 | grep -oE '[0-9]+$')
  [ -z "$host" ] || SERVICE_HOST="$host"
  [ -z "$port" ] || SERVICE_PORT="$port"
}

# ---------------------------------------------------------------------------
# launchd backend (macOS)
# ---------------------------------------------------------------------------

launchd_plist() { printf '%s/Library/LaunchAgents/%s.plist\n' "$HOME" "$SERVICE_LABEL"; }

launchd_write_plist() {
  local bun log plist
  bun=$(bun_path) || return $?
  log=$(log_file)
  plist=$(launchd_plist)
  mkdir -p "$(dirname "$plist")" || return 1
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$DISPATCH</string>
        <string>serve</string>
        <string>--host</string>
        <string>$SERVICE_HOST</string>
        <string>--port</string>
        <string>$SERVICE_PORT</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$bun"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HARNESS_ORCH_HOME</key>
        <string>$ORCH_HOME</string>
        <key>ORCH_BUN</key>
        <string>$bun</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$SKILL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>$THROTTLE_SECS</integer>
    <key>StandardOutPath</key>
    <string>$log</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST
  printf '%s\n' "$plist"
}

# bootstrap/bootout are the modern verbs; load/unload is the fallback for older macOS.
launchd_load() {
  local plist="$1"
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && return 0
  launchctl load -w "$plist"
}

launchd_unload() {
  local plist="$1"
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null && return 0
  [ ! -f "$plist" ] || launchctl unload -w "$plist" 2>/dev/null
  return 0
}

launchd_install() {
  local plist
  plist=$(launchd_write_plist) || return $?
  launchd_unload "$plist"
  launchd_load "$plist" || { printf 'service: launchctl could not load %s\n' "$plist" >&2; return 1; }
  printf 'installed launchd agent %s\n  plist: %s\n' "$SERVICE_LABEL" "$plist"
}

launchd_uninstall() {
  local plist
  plist=$(launchd_plist)
  launchd_unload "$plist"
  if [ -f "$plist" ]; then
    remove_file "$plist" || { printf 'service: could not remove %s\n' "$plist" >&2; return 1; }
    printf 'removed %s\n' "$plist"
  else
    printf 'service: no launchd agent installed\n'
  fi
}

# `launchctl print` repeats `state =` inside nested sections, so keep only the first hit per key.
launchd_supervisor_state() {
  local dump
  dump=$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null) || {
    printf '  not loaded\n'
    return 0
  }
  printf '%s\n' "$dump" | awk '
    /^[[:space:]]*state = / && !state_seen { sub(/^[[:space:]]+/, ""); print "  " $0; state_seen = 1 }
    /^[[:space:]]*pid = /   && !pid_seen   { sub(/^[[:space:]]+/, ""); print "  " $0; pid_seen = 1 }
  '
}

# ---------------------------------------------------------------------------
# systemd --user backend (Linux)
# ---------------------------------------------------------------------------

systemd_unit() { printf '%s/systemd/user/%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}" "$SYSTEMD_UNIT_NAME"; }

systemd_write_unit() {
  local bun log unit
  bun=$(bun_path) || return $?
  log=$(log_file)
  unit=$(systemd_unit)
  mkdir -p "$(dirname "$unit")" || return 1
  cat > "$unit" <<UNIT
[Unit]
Description=orch dashboard server
Documentation=https://github.com/barnuri/orch-skill
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash $DISPATCH serve --host $SERVICE_HOST --port $SERVICE_PORT
Environment=HARNESS_ORCH_HOME=$ORCH_HOME
Environment=ORCH_BUN=$bun
Environment=PATH=$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$SKILL_DIR
Restart=always
RestartSec=$THROTTLE_SECS
StandardOutput=append:$log
StandardError=append:$log

[Install]
WantedBy=default.target
UNIT
  printf '%s\n' "$unit"
}

systemd_install() {
  local unit
  unit=$(systemd_write_unit) || return $?
  systemctl --user daemon-reload || return 1
  systemctl --user enable --now "$SYSTEMD_UNIT_NAME" || {
    printf 'service: systemctl could not enable %s\n' "$SYSTEMD_UNIT_NAME" >&2
    return 1
  }
  printf 'installed systemd --user unit %s\n  unit: %s\n' "$SYSTEMD_UNIT_NAME" "$unit"
  printf '  tip: `loginctl enable-linger %s` keeps it running when you are logged out\n' "$(id -un)"
}

systemd_uninstall() {
  local unit
  unit=$(systemd_unit)
  systemctl --user disable --now "$SYSTEMD_UNIT_NAME" 2>/dev/null
  if [ -f "$unit" ]; then
    remove_file "$unit" || { printf 'service: could not remove %s\n' "$unit" >&2; return 1; }
    systemctl --user daemon-reload 2>/dev/null
    printf 'removed %s\n' "$unit"
  else
    printf 'service: no systemd unit installed\n'
  fi
}

systemd_supervisor_state() {
  systemctl --user is-enabled "$SYSTEMD_UNIT_NAME" 2>/dev/null | sed 's|^|  enabled: |'
  systemctl --user is-active "$SYSTEMD_UNIT_NAME" 2>/dev/null | sed 's|^|  active: |'
}

# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

unit_path() {
  case "$(uname -s)" in
    Darwin) launchd_plist ;;
    Linux) systemd_unit ;;
  esac
}

cmd_install() {
  local backend
  parse_install_opts "$@" || return $?
  backend=$(platform) || return 1
  preflight || return $?

  case "$backend" in
    launchd) launchd_install || return 1 ;;
    systemd) systemd_install || return 1 ;;
  esac

  printf '  serving: %s:%s\n  state:   %s\n  log:     %s\n' \
    "$SERVICE_HOST" "$SERVICE_PORT" "$ORCH_HOME" "$(log_file)"
  [ "$SERVICE_HOST" != 0.0.0.0 ] || printf '  note: bound to 0.0.0.0 — reachable from your LAN with the token\n'
  printf '\nDashboard: %s\n' "$(dashboard_url)"
  printf 'Check it with: bash %s status\n' "$0"
}

cmd_uninstall() {
  local backend
  backend=$(platform) || return 1
  adopt_installed_settings
  case "$backend" in
    launchd) launchd_uninstall ;;
    systemd) systemd_uninstall ;;
  esac
}

cmd_restart() {
  local backend
  backend=$(platform) || return 1
  adopt_installed_settings
  [ -f "$(unit_path)" ] || { printf 'service: nothing installed — run `%s install` first\n' "$0" >&2; return 1; }
  case "$backend" in
    launchd)
      launchd_unload "$(launchd_plist)"
      launchd_load "$(launchd_plist)" || return 1
      ;;
    systemd) systemctl --user restart "$SYSTEMD_UNIT_NAME" || return 1 ;;
  esac
  printf 'service: restarted\n'
}

cmd_status() {
  local backend
  backend=$(platform) || return 1
  adopt_installed_settings

  printf 'unit: %s\n' "$(unit_path)"
  if [ ! -f "$(unit_path)" ]; then
    printf 'service: not installed — run `bash %s install`\n' "$0"
    return 1
  fi

  printf 'supervisor:\n'
  case "$backend" in
    launchd) launchd_supervisor_state ;;
    systemd) systemd_supervisor_state ;;
  esac

  printf 'listener on 127.0.0.1:%s: ' "$SERVICE_PORT"
  listening
  case $? in
    0) printf 'answering\n' ;;
    2) printf 'unknown (curl not installed)\n' ;;
    *) printf 'no answer — see %s\n' "$(log_file)" ;;
  esac
  printf 'dashboard: %s\n' "$(dashboard_url)"
}

cmd_logs() {
  local lines=40 log
  if [ "${1:-}" = "-n" ]; then
    shift
    is_uint "${1:-}" || { printf 'service: -n expects a line count\n' >&2; return 2; }
    lines="$1"
  fi
  log=$(log_file)
  [ -f "$log" ] || { printf 'service: no log at %s yet\n' "$log" >&2; return 1; }
  tail -n "$lines" "$log"
}

main() {
  local sub="${1:-}"
  [ $# -eq 0 ] || shift
  case "$sub" in
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    -h|--help|help|'') usage ;;
    *) printf 'service: unknown subcommand %s\n\n' "$sub" >&2; usage >&2; return 2 ;;
  esac
}

main "$@"
