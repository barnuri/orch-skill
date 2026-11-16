#!/usr/bin/env bash
# check-herdr-bridge.sh - sends one test ask to the live coordinator and checks it was delivered (typed into the
# coordinator pane). Usage: check-herdr-bridge.sh <run-id> [node-id]. The node must exist in the run; the default
# is its first node. Run it in the coordinator pane (HERDR_PANE_ID, HERDR_SOCKET_PATH set) after `run set coordinator`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DISPATCH="$ROOT/skills/orch/scripts/dispatch.sh"
HOME_DIR="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
run="${1:-}"
[ -n "$run" ] || { echo "usage: check-herdr-bridge.sh <run-id> [node-id]"; exit 2; }
state="$HOME_DIR/runs/$run/state.json"
[ -f "$state" ] || { echo "FAIL no run $run under $HOME_DIR"; exit 2; }
node="${2:-$(jq -r '.nodes[0].id // empty' "$state")}"
[ -n "$node" ] || { echo "FAIL run $run has no node to ask from"; exit 2; }
[ "$(jq -r '.coordinator.pane_id // empty' "$state")" != "" ] || { echo "FAIL no coordinator recorded; run: dispatch.sh run set $run coordinator"; exit 1; }

id=$("$DISPATCH" node ask "$run" "$node" "bridge check $(date -u +%H:%M:%S)" | awk '{print $1}')
[ -n "$id" ] || { echo "FAIL node ask did not store a message"; exit 1; }

deadline=$(( $(date -u +%s) + 30 ))
while :; do
  delivered=$("$DISPATCH" run messages "$run" --json | jq -r --arg id "$id" '.[] | select(.id == $id) | .delivered_at // empty')
  if [ -n "$delivered" ]; then
    echo "PASS ask $id from $node delivered at $delivered"
    exit 0
  fi
  [ "$(date -u +%s)" -lt "$deadline" ] || break
  sleep 2
done
reason=$(jq -r '.coordinator.unreachable.reason // "none"' "$state")
echo "FAIL ask $id not delivered in 30s (coordinator unreachable: $reason)"
exit 1
