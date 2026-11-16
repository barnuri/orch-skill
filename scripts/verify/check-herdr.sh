#!/usr/bin/env bash
# check-herdr.sh - orch herdr instance panes and tabs per workspace (read only). Never touches the user's own herdr.
set -u
H="${ORCH_HERDR_HOME:-$HOME/.harness-orch/herdr/home}"
herdr_orch() { env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID HOME="$H" herdr "$@" 2>/dev/null; }
out=$(herdr_orch pane list) || { echo "FAIL orch herdr instance not answering ($H)"; exit 1; }
n=$(jq '.result.panes|length' <<<"$out")
echo "PASS orch herdr answers, $n panes"
jq -r '.result.panes[]|"  \(.pane_id) \(.agent // "-") \(.agent_status) \(.cwd|split("/")|last)"' <<<"$out"
ws=$(herdr_orch workspace list | jq -c '.result.workspaces[]')
echo "workspaces: $(printf '%s\n' "$ws" | grep -c .)"
while IFS= read -r w; do
  [ -n "$w" ] || continue
  id=$(jq -r .workspace_id <<<"$w"); label=$(jq -r .label <<<"$w")
  tabs=$(herdr_orch tab list --workspace "$id" | jq -c '.result.tabs[]')
  echo "  workspace $id ${label}: $(printf '%s\n' "$tabs" | grep -c .) tabs"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    tid=$(jq -r .tab_id <<<"$t")
    np=$(jq --arg t "$tid" '[.result.panes[] | select(.tab_id == $t)] | length' <<<"$out")
    echo "    tab $tid $(jq -r .label <<<"$t") panes=$np"
  done <<<"$tabs"
done <<<"$ws"
