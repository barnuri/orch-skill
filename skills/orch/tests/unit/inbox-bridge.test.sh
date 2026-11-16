#!/usr/bin/env bash
# Fast-tier unit tests for the coordinator bridge in lib/runs/inbox.sh: record the coordinator, deliver an ask
# or a tell into the coordinator pane, retry while the pane works, mark it unreachable when gone, one-line format.
# A fake herdr binary first on PATH logs every call; no real herdr is touched.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

FAKE="$H/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/herdr" <<'FAKE_HERDR'
#!/usr/bin/env bash
printf '%s %s\n' "${HERDR_SOCKET_PATH:-}" "$*" >> "$FAKE_LOG"
case "$*" in
  "pane get "*) [ -z "${FAKE_GONE:-}" ] || exit 1
                if [ -n "${FAKE_WORKING:-}" ]; then echo '{"agent_status": "working"}'; else echo '{"agent_status": "idle"}'; fi ;;
  "pane read "*) [ -z "${FAKE_READ_FAIL:-}" ] || exit 1
                 if [ -n "${FAKE_CHANGING:-}" ]; then date +%N; fi
                 if [ -n "${FAKE_TYPING:-}" ]; then echo "output"; echo "❯ half a draft"; else echo "output"; echo "❯"; fi ;;
  "pane send-text "*) [ -z "${FAKE_SEND_FAIL:-}" ] || exit 1; printf '%s\n' "$4" >> "$FAKE_TEXT" ;;
  "pane send-keys "*) ;;
esac
FAKE_HERDR
chmod +x "$FAKE/herdr"
export PATH="$FAKE:$PATH" FAKE_LOG="$H/fake.log" FAKE_TEXT="$H/fake.text"

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'EOF2'
{"run_id":"r1","title":"t","status":"running","edges":[],
 "nodes":[{"id":"a","status":"running"},{"id":"b","status":"waiting"}]}
EOF2
reset_fake() { : > "$FAKE_LOG"; : > "$FAKE_TEXT"; unset FAKE_GONE FAKE_WORKING FAKE_SEND_FAIL FAKE_TYPING FAKE_CHANGING FAKE_READ_FAIL; }
export ORCH_COORD_SETTLE_SECS=0
# last_orch: path of the newest message in inbox/orch (the one the last call stored).
last_orch() { inbox_files r1 orch | tail -n1; }

(unset HERDR_PANE_ID HERDR_SOCKET_PATH; coordinator_record r1) >/dev/null 2>&1; rc=$?
expect_exit "run set coordinator without the coordinator env is refused" 2 "$rc"

export HERDR_PANE_ID=p-coord HERDR_SOCKET_PATH="$H/coord.sock" HERDR_WORKSPACE_ID=ws-1
expect_match "run set coordinator records the pane" '^coordinator: r1 p-coord$' "$(coordinator_record r1)"
expect_match "the stored coordinator has pane, socket and workspace" "^p-coord $H/coord.sock ws-1$" "$(jq -r '.coordinator | "\(.pane_id) \(.socket_path) \(.workspace_id)"' "$H/runs/r1/state.json")"

reset_fake
expect_match "an ask is typed into an idle coordinator pane" '^m1 asked$' "$(cmd_node_ask r1 a "which db?")"
expect_match "the ask records delivered_at and via herdr-coordinator" '^herdr-coordinator$' "$(jq -r 'select(.delivered_at != null) | .via' "$(last_orch)")"
expect_match "the line has the single-line ask format" '^\[orch ask #m1 from a\] which db\? \| answer: dispatch.sh node answer r1 a m1 "<text>"$' "$(cat "$FAKE_TEXT")"
expect_match "the pane gets Enter after the text" 'pane send-keys p-coord Enter' "$(cat "$FAKE_LOG")"
expect_match "the calls use the stored socket" "^$H/coord.sock pane send-text" "$(grep 'send-text' "$FAKE_LOG")"

reset_fake
cmd_node_ask r1 a 'say "hi" \ x' >/dev/null
expect_match "quotes and backslashes are escaped" '^\[orch ask #m2 from a\] say \\"hi\\" \\\\ x \| answer' "$(cat "$FAKE_TEXT")"

reset_fake
cmd_node_ask r1 a "$(printf 'line one\nline two')" >/dev/null
expect_match "a newline in the question becomes one line" '^1$' "$(wc -l < "$FAKE_TEXT" | tr -d ' ')"

reset_fake
export FAKE_WORKING=1; cmd_node_ask r1 a "busy?" >/dev/null; unset FAKE_WORKING
expect_match "a working pane is not typed into" '^pending 1$' "$(jq -r '"\(.status) \(.tries)"' "$(last_orch)")"
expect_empty "no text is typed while the pane works" "$(cat "$FAKE_TEXT")"
export FAKE_WORKING=1; for _ in $(seq 1 9); do coord_sweep r1 >/dev/null; done; unset FAKE_WORKING
expect_match "after 10 tries the ask is failed" '^failed 10$' "$(jq -r '"\(.status) \(.tries)"' "$(last_orch)")"

reset_fake
export FAKE_WORKING=1; cmd_node_ask r1 a "later" >/dev/null; unset FAKE_WORKING
expect_match "the sweep delivers once the pane is idle" '^herdr-coordinator$' "$(coord_sweep r1 >/dev/null; jq -r '.via' "$(last_orch)")"

reset_fake
export FAKE_TYPING=1; cmd_node_ask r1 a "typed over?" >/dev/null; unset FAKE_TYPING
expect_match "typed input in the coordinator box defers the ask" '^pending 1$' "$(jq -r '"\(.status) \(.tries)"' "$(last_orch)")"
expect_empty "no text is typed over the user's draft" "$(cat "$FAKE_TEXT")"

reset_fake
export FAKE_CHANGING=1; cmd_node_ask r1 a "moving screen?" >/dev/null; unset FAKE_CHANGING
expect_match "a changing screen defers the ask" '^pending 1$' "$(jq -r '"\(.status) \(.tries)"' "$(last_orch)")"
expect_empty "no text is typed into a changing screen" "$(cat "$FAKE_TEXT")"

reset_fake
export FAKE_READ_FAIL=1; cmd_node_ask r1 a "unreadable?" >/dev/null; unset FAKE_READ_FAIL
expect_match "an unreadable screen counts as busy and defers" '^pending 1$' "$(jq -r '"\(.status) \(.tries)"' "$(last_orch)")"
expect_empty "nothing is typed when the screen cannot be read" "$(cat "$FAKE_TEXT")"

reset_fake
expect_match "an empty input on a quiet screen sends" '^herdr-coordinator$' "$(cmd_node_ask r1 a "quiet" >/dev/null; jq -r '.via' "$(last_orch)")"

reset_fake
export FAKE_GONE=1; cmd_node_ask r1 a "gone?" >/dev/null; unset FAKE_GONE
expect_match "a gone pane is reported unreachable" '^unreachable$' "$(export FAKE_GONE=1; coord_deliver r1 "$(last_orch)")"
expect_match "the coordinator records the reason" '^pane or socket gone$' "$(jq -r '.coordinator.unreachable.reason' "$H/runs/r1/state.json")"
expect_match "the unreachable ask keeps its inbox file, pending" '^pending$' "$(jq -r .status "$(last_orch)")"
expect_match "the event log notes the unreachable coordinator" 'coordinator unreachable' "$(tail -n1 "$H/runs/r1/events.jsonl" | jq -r .note)"

reset_fake
expect_match "the kept ask is delivered when the pane is back" '^herdr-coordinator$' "$(coord_sweep r1 >/dev/null; jq -r '.via' "$(last_orch)")"
expect_match "the unreachable state is cleared" '^null$' "$(jq -c '.coordinator.unreachable' "$H/runs/r1/state.json")"

reset_fake
expect_match "an urgent tell to the coordinator is typed in" '^coordinator delivered$' "$(cmd_node_tell r1 coordinator "need a call" --from a | awk '{print $2, $3}')"
expect_match "the tell line has the tell format" '^\[orch tell #m[0-9]+ from a\] need a call$' "$(cat "$FAKE_TEXT")"

reset_fake
unset HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_WORKSPACE_ID
mkdir -p "$H/runs/r2"; jq '(.run_id = "r2") | del(.coordinator)' "$H/runs/r1/state.json" > "$H/runs/r2/state.json"
expect_match "an ask in a run with no coordinator stays pending" '^m1 asked$' "$(cmd_node_ask r2 b "no coordinator")"
expect_match "no coordinator is reported as none" '^none$' "$(coord_deliver r2 "$(inbox_files r2 orch | tail -n1)")"

cleanup_dir "$(dirname "$H")"
finish
