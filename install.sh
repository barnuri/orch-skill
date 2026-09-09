#!/usr/bin/env bash
# Registers this checkout with Claude Code as a local directory-source plugin marketplace and
# installs the `orch` plugin from it. Idempotent: safe to re-run after `git pull`, which is also
# how you upgrade — a directory marketplace is read live from this folder.
#
#   ./install.sh                  install the plugin
#   ./install.sh --with-service   also install the always-on dashboard service (see scripts/service.sh)
#   ./install.sh --scope local    install for this project only instead of the user scope

set -u

REPO_DIR=$(cd "$(dirname "$0")" && pwd -P)
MARKETPLACE_NAME=orch-skill
PLUGIN_NAME=orch
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"

SCOPE=user
WITH_SERVICE=0

usage() {
  sed -n '2,9p' "$0" | sed 's|^# \{0,1\}||'
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-service) WITH_SERVICE=1 ;;
      --scope)
        shift
        SCOPE="${1:-}"
        [ -n "$SCOPE" ] || { printf 'install: --scope expects user|project|local\n' >&2; return 2; }
        ;;
      -h|--help) usage; exit 0 ;;
      *) printf 'install: unknown argument %s\n\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done
}

require_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  cat >&2 <<'EOF'
install: the `claude` CLI is not on PATH.
  Install Claude Code first: https://docs.claude.com/en/docs/claude-code
  Then re-run ./install.sh
EOF
  return 127
}

# Both helpers read the CLI's own --json output, so they stay correct if the human-readable
# format changes. A marketplace/plugin name is a JSON string, hence the quoted match.
marketplace_registered() {
  claude plugin marketplace list --json 2>/dev/null | grep -q "\"$MARKETPLACE_NAME\""
}

plugin_installed() {
  claude plugin list --json 2>/dev/null | grep -q "\"$PLUGIN_ID\""
}

add_marketplace() {
  if marketplace_registered; then
    printf 'marketplace %s already registered — refreshing it\n' "$MARKETPLACE_NAME"
    claude plugin marketplace update "$MARKETPLACE_NAME" || return 1
    return 0
  fi
  printf 'registering marketplace %s -> %s\n' "$MARKETPLACE_NAME" "$REPO_DIR"
  claude plugin marketplace add "$REPO_DIR"
}

install_plugin() {
  if plugin_installed; then
    printf 'plugin %s already installed\n' "$PLUGIN_ID"
    return 0
  fi
  printf 'installing %s (scope: %s)\n' "$PLUGIN_ID" "$SCOPE"
  claude plugin install "$PLUGIN_ID" --scope "$SCOPE" --yes
}

# A convenience symlink to the live state directory so profiles.json/memory.json are reachable
# from the checkout. Absolute and per-machine, hence gitignored — see .gitignore.
link_config() {
  local state_dir="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
  ln -sfn "$state_dir" "$REPO_DIR/config" || {
    printf 'install: could not link %s/config -> %s\n' "$REPO_DIR" "$state_dir" >&2
    return 1
  }
  printf 'linked ./config -> %s\n' "$state_dir"
}

install_service() {
  printf '\n--- optional dashboard service ---\n'
  bash "$REPO_DIR/scripts/service.sh" install
}

print_next_steps() {
  cat <<EOF

Installed. Next:

  1. Restart Claude Code (or start a new session) so the skill loads.
  2. Bootstrap the state directory once:
       bash $REPO_DIR/skills/orch/scripts/dispatch.sh init
  3. Use it: ask your agent to "orchestrate this", or invoke /$PLUGIN_NAME:orch directly.
  4. Live dashboard on demand:
       bash $REPO_DIR/skills/orch/scripts/dispatch.sh ui
EOF
  service_installed || cat <<EOF
  5. Want the dashboard always running in the background?
       bash $REPO_DIR/scripts/service.sh install
EOF
}

# True when a supervisor unit for the dashboard already exists, so the tip above is only shown
# to someone who has not set it up.
service_installed() {
  [ -f "$HOME/Library/LaunchAgents/io.github.barnuri.orch.plist" ] && return 0
  [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/orch-dashboard.service" ]
}

main() {
  parse_args "$@" || return $?
  require_claude || return $?
  add_marketplace || { printf 'install: marketplace registration failed\n' >&2; return 1; }
  install_plugin || { printf 'install: plugin install failed\n' >&2; return 1; }
  link_config || return 1
  [ "$WITH_SERVICE" -eq 0 ] || install_service || return 1
  print_next_steps
}

main "$@"
