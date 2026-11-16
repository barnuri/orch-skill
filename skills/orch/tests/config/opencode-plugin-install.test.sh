#!/usr/bin/env bash
# Tests for scripts/install-opencode-plugin.sh: links mods/opencode/orch-nodes.js into a plugin folder,
# backs up a real file it replaces, and is idempotent.
set -u
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"

REPO="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
INSTALL="$REPO/scripts/install-opencode-plugin.sh"
SRC="$REPO/mods/opencode/orch-nodes.js"
dir=$(new_tmp)

out=$(OPENCODE_PLUGIN_DIR="$dir/plugins" bash "$INSTALL" 2>&1)
expect_match "fresh: linked" '^opencode: linked' "$out"
expect_match "fresh: link points at the repo copy" "^$SRC\$" "$(readlink "$dir/plugins/orch-nodes.js")"

out=$(OPENCODE_PLUGIN_DIR="$dir/plugins" bash "$INSTALL" 2>&1)
expect_match "second run: unchanged" 'unchanged' "$out"

trash "$dir/plugins/orch-nodes.js" 2>/dev/null || mv "$dir/plugins/orch-nodes.js" "$dir/gone.js"
printf 'old plugin\n' > "$dir/plugins/orch-nodes.js"
out=$(OPENCODE_PLUGIN_DIR="$dir/plugins" bash "$INSTALL" 2>&1)
expect_match "real file: backed up" 'backed up' "$out"
expect_match "real file: backup keeps the old text" "^old plugin\$" "$(cat "$dir"/plugins/orch-nodes.js.orch-backup-* 2>/dev/null)"
expect_match "real file: replaced by the link" "^$SRC\$" "$(readlink "$dir/plugins/orch-nodes.js")"

cleanup_dir "$dir"
finish
