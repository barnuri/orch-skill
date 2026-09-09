#!/usr/bin/env bash
# Reverses ./install.sh: uninstalls the `orch` plugin and drops the marketplace registration.
# Leaves this checkout and ~/.harness-orch alone — pass --purge-state to also remove the state
# directory (recoverably, via `trash`).
#
#   ./uninstall.sh                 remove the plugin + marketplace
#   ./uninstall.sh --with-service  also remove the background dashboard service
#   ./uninstall.sh --purge-state   also remove ~/.harness-orch (runs, jobs, profiles, memory)

set -u

REPO_DIR=$(cd "$(dirname "$0")" && pwd -P)
MARKETPLACE_NAME=orch-skill
PLUGIN_NAME=orch
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"
ORCH_HOME="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
ORCH_BIN_DIR="${ORCH_BIN_DIR:-$HOME/.local/bin}"

WITH_SERVICE=0
PURGE_STATE=0

usage() {
  sed -n '2,8p' "$0" | sed 's|^# \{0,1\}||'
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-service) WITH_SERVICE=1 ;;
      --purge-state) PURGE_STATE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) printf 'uninstall: unknown argument %s\n\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done
}

require_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  printf 'uninstall: the `claude` CLI is not on PATH — nothing to unregister\n' >&2
  return 127
}

# remove_path <path>: recoverable delete. `trash` when available, otherwise a timestamped move
# under the state directory's own .trash — never `rm`.
remove_path() {
  local target="$1" graveyard
  [ -e "$target" ] || return 0
  if command -v trash >/dev/null 2>&1; then
    trash "$target"
    return $?
  fi
  graveyard="$ORCH_HOME/.trash/$(date '+%Y%m%d-%H%M%S')"
  mkdir -p "$graveyard" || return 1
  mv "$target" "$graveyard/" || return 1
  printf 'moved %s to %s\n' "$target" "$graveyard"
}

uninstall_plugin() {
  if ! claude plugin list --json 2>/dev/null | grep -q "\"$PLUGIN_ID\""; then
    printf 'plugin %s is not installed\n' "$PLUGIN_ID"
    return 0
  fi
  printf 'uninstalling %s\n' "$PLUGIN_ID"
  claude plugin uninstall "$PLUGIN_ID"
}

remove_marketplace() {
  if ! claude plugin marketplace list --json 2>/dev/null | grep -q "\"$MARKETPLACE_NAME\""; then
    printf 'marketplace %s is not registered\n' "$MARKETPLACE_NAME"
    return 0
  fi
  printf 'removing marketplace %s\n' "$MARKETPLACE_NAME"
  claude plugin marketplace remove "$MARKETPLACE_NAME"
}

installed_cli_bin() {
  local name="$ORCH_BIN_NAME" dir="$ORCH_BIN_DIR" file="$ORCH_HOME/cli.json"
  if [ -f "$file" ] && command -v jq >/dev/null 2>&1; then
    name=$(jq -r '.name // "orch"' "$file" 2>/dev/null)
    dir=$(jq -r --arg d "$dir" '.bin_dir // $d' "$file" 2>/dev/null)
  fi
  printf '%s/%s\n' "$dir" "$name"
}

uninstall_cli() {
  local orch_bin
  orch_bin=$(installed_cli_bin)
  [ -e "$orch_bin" ] || return 0
  printf 'removing %s\n' "$orch_bin"
  remove_path "$orch_bin"
}

main() {
  parse_args "$@" || return $?
  [ "$WITH_SERVICE" -eq 0 ] || bash "$REPO_DIR/scripts/service.sh" uninstall
  uninstall_cli
  require_claude || return $?
  uninstall_plugin || return 1
  remove_marketplace || return 1
  if [ "$PURGE_STATE" -eq 1 ]; then
    printf 'removing state directory %s\n' "$ORCH_HOME"
    remove_path "$ORCH_HOME" || { printf 'uninstall: could not remove %s\n' "$ORCH_HOME" >&2; return 1; }
  fi
  printf '\nDone. Restart Claude Code to drop the skill from the session.\n'
}

main "$@"
