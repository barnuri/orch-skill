#!/usr/bin/env bash
# Links the orch opencode plugin (mods/opencode/orch-nodes.js) into opencode's global plugin folder.
# Idempotent. A real file already there is copied to <name>.orch-backup-<epoch> and replaced by the link.
# Skips when opencode is not installed (no config folder and no `opencode` on PATH).
#   OPENCODE_PLUGIN_DIR  target folder (default: ${XDG_CONFIG_HOME:-~/.config}/opencode/plugins)
set -u

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
SOURCE="$REPO_DIR/mods/opencode/orch-nodes.js"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="${OPENCODE_PLUGIN_DIR:-$CONFIG_DIR/plugins}"
TARGET="$PLUGIN_DIR/orch-nodes.js"

[ -f "$SOURCE" ] || { printf 'opencode: plugin source missing: %s\n' "$SOURCE" >&2; exit 1; }
if [ -z "${OPENCODE_PLUGIN_DIR:-}" ] && [ ! -d "$CONFIG_DIR" ] && ! command -v opencode >/dev/null 2>&1; then
  printf 'opencode: plugin skipped (opencode not installed)\n'
  exit 0
fi
if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$SOURCE" ]; then
  printf 'opencode: orch-nodes plugin -> %s (unchanged)\n' "$SOURCE"
  exit 0
fi
mkdir -p "$PLUGIN_DIR" || exit 1
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  backup="$TARGET.orch-backup-$(date +%s)"
  cp -p "$TARGET" "$backup" || exit 1
  printf 'opencode: backed up the old plugin to %s\n' "$backup"
fi
ln -sfn "$SOURCE" "$TARGET" || { printf 'opencode: could not link %s\n' "$TARGET" >&2; exit 1; }
printf 'opencode: linked orch-nodes plugin %s -> %s (loads on the next opencode start)\n' "$TARGET" "$SOURCE"
