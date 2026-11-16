#!/usr/bin/env bash
# check-herdr.sh - orch herdr instance panes (read only). Never touches the user's own herdr.
set -u
H="${ORCH_HERDR_HOME:-$HOME/.harness-orch/herdr/home}"
out=$(env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID HOME="$H" herdr pane list 2>/dev/null) || { echo "FAIL orch herdr instance not answering ($H)"; exit 1; }
n=$(jq '.result.panes|length' <<<"$out")
echo "PASS orch herdr answers, $n panes"
jq -r '.result.panes[]|"  \(.pane_id) \(.agent // "-") \(.agent_status) \(.cwd|split("/")|last)"' <<<"$out"
