#!/usr/bin/env bash
# Registers this checkout with Claude Code and installs the global `orch` CLI.
# Idempotent and non-destructive: re-run after `git pull` to update links and refresh only
# what changed. Never overwrites profiles.json, serve.json, runs/, jobs/ or memory.json.
#
#   ./install.sh                  install or update (default)
#   ./install.sh --cli-only       global `orch` CLI + ./config only; skip Claude plugin
#   ./install.sh --with-service   install/refresh the background service (serve.json unchanged)
#   ./install.sh --scope local    plugin scope (first install only)
#   ./install.sh --restart        restart the dashboard service even when sources are unchanged
#   ./install.sh --no-restart     never restart the dashboard service
#   ./install.sh --bin-name NAME  CLI command name (default: orch; saved in <home>/cli.json)

set -u

REPO_DIR=$(cd "$(dirname "$0")" && pwd -P)
DISPATCH="$REPO_DIR/skills/orch/scripts/dispatch.sh"
SKILL_SOURCE_DIRS="$REPO_DIR/skills/orch/server $REPO_DIR/skills/orch/dashboard $REPO_DIR/skills/orch/shared"
MARKETPLACE_NAME=orch-skill
PLUGIN_NAME=orch
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"
DEFAULT_BIN_NAME=orch

SCOPE=user
WITH_SERVICE=0
CLI_ONLY=0
FORCE_SERVICE_RESTART=0
SKIP_SERVICE_RESTART=0
ORCH_BIN_DIR="${ORCH_BIN_DIR:-$HOME/.local/bin}"
if [ -n "${ORCH_BIN_NAME+x}" ]; then
  ORCH_BIN_NAME_EXPLICIT=1
else
  ORCH_BIN_NAME="$DEFAULT_BIN_NAME"
  ORCH_BIN_NAME_EXPLICIT=0
fi
STATE_DIR="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
CLI_CONFIG_FILE="$STATE_DIR/cli.json"

usage() {
  sed -n '2,12p' "$0" | sed 's|^# \{0,1\}||'
}

valid_bin_name() {
  case "${1:-}" in
    ''|*/*|*' '*|*'..'|*'\\'*) return 1 ;;
  esac
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-service) WITH_SERVICE=1 ;;
      --cli-only) CLI_ONLY=1 ;;
      --restart) FORCE_SERVICE_RESTART=1 ;;
      --no-restart) SKIP_SERVICE_RESTART=1 ;;
      --bin-name)
        shift
        ORCH_BIN_NAME="${1:-}"
        [ -n "$ORCH_BIN_NAME" ] || { printf 'install: --bin-name expects a name\n' >&2; return 2; }
        valid_bin_name "$ORCH_BIN_NAME" || {
          printf 'install: --bin-name must match [A-Za-z0-9._-] and cannot contain /\n' >&2
          return 2
        }
        ORCH_BIN_NAME_EXPLICIT=1
        ;;
      --scope)
        shift
        SCOPE="${1:-}"
        [ -n "$SCOPE" ] || { printf 'install: --scope expects user|project|local\n' >&2; return 2; }
        ;;
      -h|--help|help) usage; exit 0 ;;
      *) printf 'install: unknown argument %s\n\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done
}

# Reads a prior install's command name/dir unless this run passed --bin-name or ORCH_BIN_NAME.
adopt_cli_config() {
  local saved_name saved_dir
  valid_bin_name "$ORCH_BIN_NAME" || {
    printf 'install: invalid ORCH_BIN_NAME %s\n' "$ORCH_BIN_NAME" >&2
    return 2
  }
  [ -f "$CLI_CONFIG_FILE" ] || return 0
  if ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  saved_name=$(jq -r '.name // empty' "$CLI_CONFIG_FILE" 2>/dev/null)
  saved_dir=$(jq -r --arg d "$ORCH_BIN_DIR" '.bin_dir // $d' "$CLI_CONFIG_FILE" 2>/dev/null)
  if [ "$ORCH_BIN_NAME_EXPLICIT" -eq 0 ] && [ -n "$saved_name" ]; then
    ORCH_BIN_NAME="$saved_name"
  fi
  [ -n "$saved_dir" ] && ORCH_BIN_DIR="$saved_dir"
  valid_bin_name "$ORCH_BIN_NAME" || ORCH_BIN_NAME="$DEFAULT_BIN_NAME"
}

save_cli_config() {
  local tmp
  mkdir -p "$STATE_DIR" || return 1
  tmp="${CLI_CONFIG_FILE}.tmp.$$"
  printf '{"name":"%s","bin_dir":"%s"}\n' "$ORCH_BIN_NAME" "$ORCH_BIN_DIR" >"$tmp" \
    || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$CLI_CONFIG_FILE"
}

recoverable_remove() {
  local target="$1" graveyard
  [ -e "$target" ] || return 0
  if command -v trash >/dev/null 2>&1 && trash "$target" 2>/dev/null; then
    return 0
  fi
  graveyard="$STATE_DIR/.trash/$(date '+%Y%m%d-%H%M%S')"
  mkdir -p "$graveyard" || return 1
  mv "$target" "$graveyard/"
}

remove_previous_cli_symlink() {
  local old_name old_dir old_path want target
  [ -f "$CLI_CONFIG_FILE" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  old_name=$(jq -r '.name // empty' "$CLI_CONFIG_FILE" 2>/dev/null)
  old_dir=$(jq -r '.bin_dir // empty' "$CLI_CONFIG_FILE" 2>/dev/null)
  [ -n "$old_name" ] && [ "$old_name" != "$ORCH_BIN_NAME" ] || return 0
  [ -n "$old_dir" ] || return 0
  old_path="$old_dir/$old_name"
  want="$REPO_DIR/bin/orch"
  [ -L "$old_path" ] || return 0
  target=$(orch_bin_target "$old_path" 2>/dev/null || readlink "$old_path")
  [ "$target" = "$want" ] || return 0
  printf 'cli: removing previous command %s\n' "$old_path"
  recoverable_remove "$old_path"
}

# Drop any other symlink in the bin dir that still points at this checkout's wrapper.
remove_superseded_cli_symlinks() {
  local want="$REPO_DIR/bin/orch" path target name
  for path in "$ORCH_BIN_DIR"/*; do
    [ -L "$path" ] || continue
    name=$(basename "$path")
    [ "$name" = "$ORCH_BIN_NAME" ] && continue
    target=$(orch_bin_target "$path" 2>/dev/null || readlink "$path")
    [ "$target" = "$want" ] || continue
    printf 'cli: removing superseded command %s\n' "$path"
    recoverable_remove "$path"
  done
}

claude_available() {
  command -v claude >/dev/null 2>&1
}

require_claude() {
  claude_available && return 0
  cat >&2 <<'EOF'
install: the `claude` CLI is not on PATH.
  Install Claude Code first: https://docs.claude.com/en/docs/claude-code
  Or pass --cli-only to install just the global `orch` command and ./config link.
EOF
  return 127
}

marketplace_registered() {
  claude plugin marketplace list --json 2>/dev/null | grep -q "\"$MARKETPLACE_NAME\""
}

marketplace_points_here() {
  marketplace_registered || return 1
  claude plugin marketplace list --json 2>/dev/null | grep -q "\"$MARKETPLACE_NAME\"" \
    && claude plugin marketplace list --json 2>/dev/null | grep -q "$REPO_DIR"
}

plugin_installed() {
  claude plugin list --json 2>/dev/null | grep -q "\"$PLUGIN_ID\""
}

add_marketplace() {
  if marketplace_points_here; then
    printf 'marketplace %s: already points at this checkout\n' "$MARKETPLACE_NAME"
    return 0
  fi
  if marketplace_registered; then
    printf 'marketplace %s: updating registration -> %s\n' "$MARKETPLACE_NAME" "$REPO_DIR"
    claude plugin marketplace update "$MARKETPLACE_NAME" || return 1
    return 0
  fi
  printf 'marketplace %s: registering -> %s\n' "$MARKETPLACE_NAME" "$REPO_DIR"
  claude plugin marketplace add "$REPO_DIR"
}

install_plugin() {
  if plugin_installed; then
    printf 'plugin %s: already installed (restart Claude Code to load skill changes)\n' "$PLUGIN_ID"
    return 0
  fi
  printf 'plugin %s: installing (scope: %s)\n' "$PLUGIN_ID" "$SCOPE"
  claude plugin install "$PLUGIN_ID" --scope "$SCOPE" --yes
}

install_claude_plugin() {
  require_claude || return $?
  add_marketplace || return 1
  install_plugin || return 1
}

# Creates missing bootstrap files and prunes legacy dashboard leftovers — never overwrites state.
bootstrap_state() {
  local profiles="$STATE_DIR/profiles.json" serve_cfg="$STATE_DIR/serve.json" had_state=1
  [ -f "$profiles" ] && [ -f "$serve_cfg" ] || had_state=0
  env ORCH_INSTALL_QUIET=1 HARNESS_ORCH_HOME="$STATE_DIR" bash "$DISPATCH" init >/dev/null \
    || { printf 'install: could not bootstrap %s\n' "$STATE_DIR" >&2; return 1; }
  if [ "$had_state" -eq 1 ]; then
    printf 'state: %s ok (existing data left unchanged)\n' "$STATE_DIR"
  else
    printf 'state: bootstrapped missing files under %s\n' "$STATE_DIR"
  fi
}

link_config() {
  local current
  current=$(readlink "$REPO_DIR/config" 2>/dev/null || printf '')
  if [ "$current" = "$STATE_DIR" ] && [ -L "$REPO_DIR/config" ]; then
    printf 'config: ./config -> %s (unchanged)\n' "$STATE_DIR"
  else
    ln -sfn "$STATE_DIR" "$REPO_DIR/config" || {
      printf 'install: could not link %s/config -> %s\n' "$REPO_DIR" "$STATE_DIR" >&2
      return 1
    }
    printf 'config: linked ./config -> %s\n' "$STATE_DIR"
  fi
  bootstrap_state || return 1
}

orch_bin_target() {
  local path="$1" hops=0 target dir
  while [ -L "$path" ] && [ "$hops" -lt 8 ]; do
    hops=$((hops + 1))
    target=$(readlink "$path" 2>/dev/null) || break
    case "$target" in
      /*) path="$target" ;;
      *) path="$(dirname "$path")/$target" ;;
    esac
  done
  dir=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$dir" "${path##*/}"
}

install_cli() {
  local cli_bin="$ORCH_BIN_DIR/$ORCH_BIN_NAME" want="$REPO_DIR/bin/orch" target
  [ -f "$want" ] || {
    printf 'install: %s missing — broken checkout?\n' "$want" >&2
    return 1
  }
  chmod +x "$want" || return 1
  mkdir -p "$ORCH_BIN_DIR" || return 1
  remove_previous_cli_symlink
  remove_superseded_cli_symlinks

  if [ -e "$cli_bin" ] && [ ! -L "$cli_bin" ]; then
    printf 'install: %s exists and is not a symlink — move it aside and re-run\n' "$cli_bin" >&2
    return 1
  fi

  if [ -L "$cli_bin" ]; then
    target=$(orch_bin_target "$cli_bin" 2>/dev/null || readlink "$cli_bin")
    if [ "$target" = "$want" ]; then
      printf 'cli: %s already points at this checkout\n' "$cli_bin"
      save_cli_config || return 1
      return 0
    fi
    printf 'cli: updating %s (was %s)\n' "$cli_bin" "$(readlink "$cli_bin")"
  else
    printf 'cli: installing %s\n' "$cli_bin"
  fi

  ln -sfn "$want" "$cli_bin" || return 1
  save_cli_config || return 1
  printf 'cli: %s -> %s\n' "$cli_bin" "$want"
}

ensure_local_bin_path() {
  local bin_dir="$ORCH_BIN_DIR" rc updated=0 created=0
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bashrc"; do
    [ -f "$rc" ] || continue
    grep -Fq '# orch-skill: global CLI' "$rc" 2>/dev/null && continue
    printf '\n# orch-skill: global CLI\nexport PATH="%s:$PATH"\n' "$bin_dir" >>"$rc"
    updated=1
    printf 'path: added %s to %s\n' "$bin_dir" "$rc"
  done
  if [ "$updated" -eq 0 ] && [ ! -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.zprofile" ]; then
    printf '# orch-skill: global CLI\nexport PATH="%s:$PATH"\n' "$bin_dir" >"$HOME/.zshrc"
    created=1
    printf 'path: created ~/.zshrc with %s\n' "$bin_dir"
  fi
  if [ "$updated" -eq 0 ] && [ "$created" -eq 0 ]; then
    printf 'path: %s already configured\n' "$bin_dir"
  fi
}

service_unit_path() {
  case "$(uname -s)" in
    Darwin) printf '%s/Library/LaunchAgents/io.github.barnuri.orch.plist\n' "$HOME" ;;
    Linux) printf '%s/systemd/user/orch-dashboard.service\n' "${XDG_CONFIG_HOME:-$HOME/.config}" ;;
    *) printf '\n' ;;
  esac
}

service_installed() {
  [ -f "$(service_unit_path)" ]
}

service_unit_matches_checkout() {
  local unit
  unit=$(service_unit_path)
  [ -f "$unit" ] || return 1
  grep -Fq "$DISPATCH" "$unit" && grep -Fq "$STATE_DIR" "$unit"
}

skill_sources_changed() {
  local pid_file="$STATE_DIR/serve/pid"
  [ -s "$pid_file" ] || return 1
  # SKILL_SOURCE_DIRS is a space-separated directory list — unquoted on purpose.
  # shellcheck disable=SC2086
  [ -n "$(find $SKILL_SOURCE_DIRS -type f -newer "$pid_file" 2>/dev/null | head -n 1)" ]
}

refresh_service() {
  local unit
  unit=$(service_unit_path)
  service_installed || return 0

  if [ "$SKIP_SERVICE_RESTART" -eq 1 ]; then
    printf 'service: left running (--no-restart)\n'
    return 0
  fi

  if [ "$WITH_SERVICE" -eq 1 ]; then
    printf '\n--- dashboard service ---\n'
    bash "$REPO_DIR/scripts/service.sh" install
    return $?
  fi

  if ! service_unit_matches_checkout; then
    printf '\n--- dashboard service ---\n'
    printf 'service: supervisor unit is stale — refreshing\n'
    bash "$REPO_DIR/scripts/service.sh" install
    return $?
  fi

  if [ "$FORCE_SERVICE_RESTART" -eq 1 ]; then
    printf '\n--- dashboard service ---\n'
    printf 'service: restarting (--restart)\n'
    bash "$REPO_DIR/scripts/service.sh" restart
    return $?
  fi

  if skill_sources_changed; then
    printf '\n--- dashboard service ---\n'
    printf 'service: skill sources changed — restarting\n'
    bash "$REPO_DIR/scripts/service.sh" restart
    return $?
  fi

  printf 'service: unchanged (running skill matches this checkout)\n'
}

print_summary() {
  cat <<EOF

Done. $( [ "$CLI_ONLY" -eq 1 ] && printf 'CLI + config ready.' || printf 'Ready.' )

  • Global CLI: $ORCH_BIN_DIR/$ORCH_BIN_NAME
  • State dir:  $STATE_DIR  (./config — your data is never overwritten by install)
  • Config:     $ORCH_BIN_NAME serve config show
EOF
  if [ "$CLI_ONLY" -eq 0 ] && claude_available; then
    cat <<EOF
  • Claude:     restart Claude Code after skill changes
EOF
  elif [ "$CLI_ONLY" -eq 0 ]; then
    cat <<EOF
  • Claude:     skipped (claude not on PATH) — re-run without --cli-only to add the plugin
EOF
  fi
  cat <<EOF
  • Dashboard:  $ORCH_BIN_NAME ui
EOF
  if service_installed; then
    cat <<EOF
  • Service:    bash $REPO_DIR/scripts/service.sh status
EOF
  elif [ "$WITH_SERVICE" -eq 0 ]; then
    cat <<EOF
  • Service:    bash $REPO_DIR/scripts/service.sh install   # optional always-on dashboard
EOF
  fi
  printf '\nRe-run ./install.sh after git pull; use --restart to bounce the service anyway.\n'
}

main() {
  parse_args "$@" || return $?
  adopt_cli_config || return $?

  printf 'orch-skill install/update (%s)\n\n' "$REPO_DIR"

  link_config || return 1
  install_cli || return 1
  ensure_local_bin_path

  if [ "$CLI_ONLY" -eq 0 ]; then
    install_claude_plugin || return 1
  else
    printf 'claude: skipped (--cli-only)\n'
  fi

  refresh_service || return 1
  print_summary
}

main "$@"
