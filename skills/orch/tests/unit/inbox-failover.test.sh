#!/usr/bin/env bash
# Failover tests for the coordinator bridge in lib/runs/inbox.sh: repoint by session id, two candidates stay
# unreachable, a failed send keeps the ask, ordered redelivery with the backlog notice, late answers, heartbeat.
# Split from inbox-bridge.test.sh so each file runs inside the 5 minute cap. A fake herdr binary logs every call.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

FAKE="$H/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/herdr" <<'FAKE_HERDR'
#!/usr/bin/env bash
printf '%s %s\n' "${HERDR_SOCKET_PATH:-}" "$*" >> "$FAKE_LOG"
case "$*" in
  "pane get "*) [ -z "${FAKE_GONE:-}" ] || exit 1
                [ "$3" != "${FAKE_GONE_PANE:-}" ] || exit 1
                if [ -f "$FAKE_GETS/$3.json" ]; then cat "$FAKE_GETS/$3.json"; exit 0; fi
                if [ -n "${FAKE_WORKING:-}" ]; then echo '{"agent_status": "working"}'; else echo '{"agent_status": "idle"}'; fi ;;
  "pane list"*) [ ! -f "$FAKE_LIST" ] || cat "$FAKE_LIST" ;;
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
last_orch() { inbox_files r1 orch | tail -n1; }

# ---- Coordinator failover: repoint, unreachable with candidates, kept asks, backlog order, late answers. ----
export HOME="$H/home"; mkdir -p "$HOME/.config/herdr"
touch "$H/coord.sock"
export FAKE_GETS="$H/gets" FAKE_LIST="$H/list.json"; mkdir -p "$FAKE_GETS" "$H/repo"
set_get() { printf '%s\n' "$2" > "$FAKE_GETS/$1.json"; }
set_list() { printf '%s\n' "$1" > "$FAKE_LIST"; }
row() { printf '{"pane_id":"%s","workspace_id":"ws-1","cwd":"%s/repo"}' "$1" "$H"; }
# set_coord <pane> <session>: the run coordinator record as `run set coordinator` leaves it, harness opencode.
set_coord() {
  jq --arg p "$1" --arg s "$2" --arg sock "$H/coord.sock" --arg repo "$H/repo" \
    '.coordinator = {pane_id: $p, socket_path: $sock, workspace_id: "ws-1", session_id: $s, repo: $repo,
      harness: "opencode", at: "t0", unreachable: null, candidates: null, backlog_pending: false}' \
    "$H/runs/r1/state.json" > "$H/state.tmp" && mv "$H/state.tmp" "$H/runs/r1/state.json"
}
state_of() { jq -r "$1" "$H/runs/r1/state.json"; }

reset_fake
set_get p-old '{"agent_status":"idle","agent_session":{"value":"ses_A"}}'
set_get p-new '{"agent_status":"idle","agent_session":{"value":"ses_A"}}'
set_list "{\"result\":{\"panes\":[$(row p-new)]}}"
set_coord p-old ses_A
export FAKE_GONE_PANE=p-old
expect_match "a gone coordinator with the same session id repoints and delivers" '^m[0-9]+ asked$' "$(cmd_node_ask r1 a "failover q1")"
expect_match "the coordinator moves to the same-session pane" '^p-new$' "$(state_of .coordinator.pane_id)"
expect_match "the repoint records its reason" '^same session$' "$(state_of .coordinator.last_repoint.reason)"
expect_match "the question reaches the new pane" '^herdr-coordinator$' "$(jq -r .via "$(last_orch)")"
unset FAKE_GONE_PANE

reset_fake
set_get p-x '{"agent":"opencode","agent_status":"idle"}'
set_get p-y '{"agent":"opencode","agent_status":"idle"}'
set_list "{\"result\":{\"panes\":[$(row p-x),$(row p-y)]}}"
set_coord p-new ses_A
export FAKE_GONE_PANE=p-new
expect_match "two candidates keep the question pending" '^m[0-9]+ asked$' "$(cmd_node_ask r1 a "failover q2")"
expect_match "two candidates leave the coordinator unreachable" '^pane or socket gone$' "$(state_of .coordinator.unreachable.reason)"
expect_match "both candidates are listed, none is chosen" '^2$' "$(state_of '.coordinator.candidates | length')"
expect_match "the coordinator pane is not changed on a guess" '^p-new$' "$(state_of .coordinator.pane_id)"
unset FAKE_GONE_PANE

reset_fake
set_get p-keep '{"agent_status":"idle","agent_session":{"value":"ses_A"}}'
set_list '{"result":{"panes":[]}}'
set_coord p-keep ses_A
export FAKE_SEND_FAIL=1
expect_match "a failed send keeps the question" '^m[0-9]+ asked$' "$(cmd_node_ask r1 a "kept q3")"
expect_match "the kept question has no delivered_at" '^null$' "$(jq -c .delivered_at "$(last_orch)")"
expect_match "a failed send marks the coordinator unreachable with the reason" '^send failed: ' "$(state_of .coordinator.unreachable.reason)"
unset FAKE_SEND_FAIL
expect_match "the next sweep delivers the kept questions in order" '^swept 2$' "$(coord_sweep r1 | tail -n1)"
expect_match "the reachable coordinator clears unreachable" '^null$' "$(state_of .coordinator.unreachable)"

reset_fake
set_coord p-keep ses_A
export FAKE_GONE_PANE=p-keep
cmd_node_ask r1 a "gone q4" >/dev/null
cmd_node_ask r1 a "gone q5" >/dev/null
pending_ids=$(for f in $(inbox_files r1 orch); do jq -r 'select(.kind == "ask" and .delivered_at == null) | "#\(.id)"' "$f"; done | tr '\n' ' ')
set_get p-back '{"agent_status":"idle","agent_session":{"value":"ses_A"}}'
set_list "{\"result\":{\"panes\":[$(row p-back)]}}"
unset FAKE_GONE_PANE
expect_match "a sweep repoints to the back pane by session id" '^p-back$' "$(coord_sweep r1 >/dev/null; state_of .coordinator.pane_id)"
expect_match "the backlog notice is one line with the count" '^2 pending node questions$' "$(sed -n 1p "$FAKE_TEXT")"
expect_match "the pending questions follow in order, one line each" "^$(printf '%s' "$pending_ids")\$" "$(grep -o '#m[0-9]*' "$FAKE_TEXT" | tail -n2 | tr '\n' ' ')"
expect_match "the backlog flag is cleared after the notice" '^false$' "$(state_of .coordinator.backlog_pending)"

reset_fake
set_coord p-back ses_A
expect_match "a late question times out with exit 4" '^4$' "$(cmd_node_ask r1 a "late q" --wait --timeout 0 >/dev/null 2>&1; echo $?)"
late_id=$(jq -r .id "$(last_orch)")
expect_match "the timed-out ask records a late answer expectation" '^true$' "$(jq -r .answered_late_expected "$(last_orch)")"
cmd_node_answer --ask "$late_id" r1 a "use postgres" >/dev/null
expect_match "a late answer reaches the node flagged late" 'late, your ask had timed out' "$(jq -r .text "$(inbox_files r1 a | tail -n1)")"

reset_fake
set_get p-back '{"agent_status":"idle","agent_session":{"value":"ses_A"}}'
set_coord p-back ""
coord_touch r1
expect_match "a heartbeat stores the stable session id" '^ses_A$' "$(state_of .coordinator.session_id)"

cleanup_dir "$(dirname "$H")"
finish
