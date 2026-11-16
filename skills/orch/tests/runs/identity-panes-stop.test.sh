#!/usr/bin/env bash
# dispatch.ts tests: worker identity, node selections, herdr panes, run stop
# Run: bash identity-panes-stop.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
export ORCH_NO_ANNOUNCE=1
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# Shared with the routing section in the old single-file suite: a plain home and argv-echo CLI shims.
home=$(new_tmp)
shims=$(new_tmp)
for tool in claude cursor-agent opencode copilot; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$shims/$tool"
  chmod +x "$shims/$tool"
done
with_shims() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" CURSOR_API_KEY=shim "$@"; }
joined() { printf '%s' "$1" | tr '\n' ' '; }

# --- smart-auto worker identity ---------------------------------------------------------------
# A fake claude that prints the custom headers it was given, so the header transport is observable.
# Other harnesses get a plain argv echo, which is enough to show they receive no headers.
hdr_home=$(new_tmp)
hdr_shims=$(new_tmp)
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${ANTHROPIC_CUSTOM_HEADERS-unset}"\n' > "$hdr_shims/claude"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$hdr_shims/copilot"
chmod +x "$hdr_shims/claude" "$hdr_shims/copilot"
horch() { env PATH="$hdr_shims:$PATH" HARNESS_ORCH_HOME="$hdr_home" "$@"; }
horch bun "$SCRIPT" run start "Worker identity" --id wid-1 >/dev/null 2>&1
horch bun "$SCRIPT" node add wid-1 impl "Implement" --role implementation --tier balance >/dev/null 2>&1
hdr_job=$(horch bun "$SCRIPT" node dispatch wid-1 impl claude "do it" 2>/dev/null)
horch bun "$SCRIPT" wait "$hdr_job" --timeout 60 --interval 1 >/dev/null 2>&1
hdr_log=$(cat "$hdr_home/jobs/$hdr_job/log" 2>/dev/null)
expect_match "claude node sends the worker identity as run/node/attempt" \
  'x-llm-hub-smart-auto-worker: wid-1/impl/1' "$hdr_log"
expect_match "claude node sends the parent as the run id" \
  'x-llm-hub-smart-auto-parent: wid-1' "$hdr_log"
expect_match "claude node sends the role" 'x-llm-hub-smart-auto-role: implementation' "$hdr_log"
expect_match "claude node sends the tier" 'x-llm-hub-smart-auto-tier: balance' "$hdr_log"
expect_match "a claude node records the headers transport and its worker" '^headers$' \
  "$(jq -r '.nodes[0].metadata_transport' "$hdr_home/runs/wid-1/state.json")"
expect_match "the recorded worker matches the sent one" '^wid-1/impl/1$' \
  "$(jq -r '.nodes[0].worker_identity' "$hdr_home/runs/wid-1/state.json")"

# Retry gives the next attempt its own worker id, and inherited headers are kept.
horch bun "$SCRIPT" node update wid-1 impl error --error "exit=1" >/dev/null 2>&1
hdr_retry=$(horch bun "$SCRIPT" node retry wid-1 impl 2>/dev/null)
horch bun "$SCRIPT" wait "$hdr_retry" --timeout 60 --interval 1 >/dev/null 2>&1
expect_match "a retried attempt uses attempt 2 in its worker id" \
  'x-llm-hub-smart-auto-worker: wid-1/impl/2' "$(cat "$hdr_home/jobs/$hdr_retry/log" 2>/dev/null)"
# The retry job leaves the node "running" (only the caller marks a node finished), and a node is
# dispatched or retried only from "waiting"/"error", so the node is reset to error before this retry.
horch bun "$SCRIPT" node update wid-1 impl error --error "exit=1" >/dev/null 2>&1
inherit_job=$(env ANTHROPIC_CUSTOM_HEADERS='x-custom-tag: keep' PATH="$hdr_shims:$PATH" \
  HARNESS_ORCH_HOME="$hdr_home" bun "$SCRIPT" node retry wid-1 impl 2>/dev/null)
horch bun "$SCRIPT" wait "$inherit_job" --timeout 60 --interval 1 >/dev/null 2>&1
expect_match "an inherited custom header is kept ahead of the smart-auto headers" \
  '^x-custom-tag: keep$' "$(head -n 1 "$hdr_home/jobs/$inherit_job/log" 2>/dev/null)"

# A harness without header transport gets no identity, and says so in the node.
horch bun "$SCRIPT" run start "Preset only" --id wid-2 >/dev/null 2>&1
horch bun "$SCRIPT" node add wid-2 cop "Copilot node" --role validation >/dev/null 2>&1
cop_job=$(horch bun "$SCRIPT" node dispatch wid-2 cop copilot "check" 2>/dev/null)
horch bun "$SCRIPT" wait "$cop_job" --timeout 60 --interval 1 >/dev/null 2>&1
expect_no_match "a copilot node sends no smart-auto header" 'x-llm-hub-smart-auto' \
  "$(cat "$hdr_home/jobs/$cop_job/log" 2>/dev/null)"
expect_match "a copilot node records the preset-model transport" '^preset-model$' \
  "$(jq -r '.nodes[0].metadata_transport' "$hdr_home/runs/wid-2/state.json")"
expect_match "a copilot node records no worker identity" '^null$' \
  "$(jq -r '.nodes[0].worker_identity | tostring' "$hdr_home/runs/wid-2/state.json")"

# A nested dispatch does not inherit the parent node's Smart Auto headers. The parent's lines arrive
# in the environment, as a parent node process would export them. A plain child gets only the
# non-smart-auto header, and a child with its own options sends its own identity, not the parent's.
horch bun "$SCRIPT" run start "Nested identity" --id wid-3 >/dev/null 2>&1
horch bun "$SCRIPT" node add wid-3 plain "Plain child" >/dev/null 2>&1
horch bun "$SCRIPT" node add wid-3 plain2 "Plain child two" >/dev/null 2>&1
horch bun "$SCRIPT" node add wid-3 opt "Child with options" --tier balance >/dev/null 2>&1
nest_parent=$(printf '%s\n%s\n%s\n%s' 'x-llm-hub-smart-auto-worker: wid-1/impl/1' \
  'x-llm-hub-smart-auto-parent: wid-1' 'x-llm-hub-smart-auto-role: implementation' 'x-custom-tag: keep')
nest_job=$(env ANTHROPIC_CUSTOM_HEADERS="$nest_parent" PATH="$hdr_shims:$PATH" \
  HARNESS_ORCH_HOME="$hdr_home" bun "$SCRIPT" node dispatch wid-3 plain claude "nested" 2>/dev/null)
horch bun "$SCRIPT" wait "$nest_job" --timeout 60 --interval 1 >/dev/null 2>&1
nest_log=$(cat "$hdr_home/jobs/$nest_job/log" 2>/dev/null)
expect_no_match "a nested plain node does not inherit the parent's smart-auto headers" \
  'x-llm-hub-smart-auto' "$nest_log"
expect_match "a nested plain node keeps the inherited non-smart-auto header" \
  '^x-custom-tag: keep$' "$nest_log"
nest_only=$(env ANTHROPIC_CUSTOM_HEADERS="$(printf '%s' 'x-llm-hub-smart-auto-worker: wid-1/impl/1')" \
  PATH="$hdr_shims:$PATH" HARNESS_ORCH_HOME="$hdr_home" bun "$SCRIPT" node dispatch wid-3 plain2 claude "nested" 2>/dev/null)
horch bun "$SCRIPT" wait "$nest_only" --timeout 60 --interval 1 >/dev/null 2>&1
expect_match "a nested plain node with only parent smart-auto headers gets no custom headers" \
  '^unset$' "$(cat "$hdr_home/jobs/$nest_only/log" 2>/dev/null)"
nest_opt=$(env ANTHROPIC_CUSTOM_HEADERS="$nest_parent" PATH="$hdr_shims:$PATH" \
  HARNESS_ORCH_HOME="$hdr_home" bun "$SCRIPT" node dispatch wid-3 opt claude "nested" 2>/dev/null)
horch bun "$SCRIPT" wait "$nest_opt" --timeout 60 --interval 1 >/dev/null 2>&1
nest_opt_log=$(cat "$hdr_home/jobs/$nest_opt/log" 2>/dev/null)
expect_match "a nested node with its own options sends its own worker identity" \
  'x-llm-hub-smart-auto-worker: wid-3/opt/1' "$nest_opt_log"
expect_no_match "a nested node with its own options does not resend the parent's worker" \
  'wid-1/impl/1' "$nest_opt_log"
cleanup_dir "$hdr_home"
cleanup_dir "$hdr_shims"

# --- node selections: a loopback fake hub serves the history API -----------------------------
# The fake answers /api/smart-auto/history with the events stored for the requested worker, and
# only the ones after since_seq, so the test can check both the append and the idempotent re-read.
if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: node selections fixture test (python3 not found)\n' >&2
else
  sel_dir=$(new_tmp)
  cat > "$sel_dir/hub.py" <<'PY'
import http.server, json, sys
from urllib.parse import urlparse, parse_qs

port_file = sys.argv[1]
events = {
    "wsel/nsel/1": [
        {"seq": 1, "worker_key": "k", "attempt_key": "a1", "stage": "solver", "state": "selected",
         "model": "llama_swap/qwen3.6-35b", "requested_selector": "hub/smart-auto-balance", "tier": "balance",
         "role": "implementation", "ts_ms": 1000, "sent_effort": "medium"},
        {"seq": 2, "worker_key": "k", "attempt_key": "a1", "stage": "solver", "state": "completed",
         "model": "llama_swap/qwen3.6-35b", "requested_selector": "hub/smart-auto-balance", "tier": "balance",
         "role": "implementation", "ts_ms": 2000, "selected_effort": "high", "sent_effort": "medium"},
        {"seq": 3, "worker_key": "k", "attempt_key": "a1", "stage": "judge", "state": "started",
         "model": "llama_swap/ornith-1.5-35b", "requested_selector": "hub/smart-auto-balance", "tier": "balance",
         "role": "review", "ts_ms": 3000, "selected_effort": "high"},
    ],
}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path != "/api/smart-auto/history":
            self.send_response(404); self.end_headers(); return
        worker = query.get("worker", [""])[0]
        since = int(query.get("since_seq", ["0"])[0])
        # Like the hub, only a since_ts_ms query reads the stored history; without it the ring is empty.
        rows = [e for e in events.get(worker, []) if e["seq"] > since] if "since_ts_ms" in query else []
        body = json.dumps({"events": rows}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass

httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(httpd.server_address[1]))
for _ in range(4):
    httpd.handle_request()
PY
  sel_port_file="$sel_dir/port"
  python3 "$sel_dir/hub.py" "$sel_port_file" &
  sel_pid=$!
  for _ in $(seq 1 600); do [ -s "$sel_port_file" ] && break; sleep 0.1; done
  sel_port=$(cat "$sel_port_file" 2>/dev/null)
  sel_home=$(new_tmp)
  sorch() { env HARNESS_ORCH_HOME="$sel_home" LLM_HUB_URL="http://127.0.0.1:$sel_port" bun "$SCRIPT" "$@"; }
  sorch run start "Selections" --id wsel >/dev/null 2>&1
  sorch node add wsel nsel "Solve" >/dev/null 2>&1
  out=$(sorch node selections wsel nsel 2>&1); rc=$?
  expect_exit "node selections exits 0 against the fake hub" 0 "$rc"
  expect_match "node selections reports the new events" '^selections: 3 new$' "$out"
  sel_state="$sel_home/runs/wsel/state.json"
  expect_match "node selections stores the events in order" '^1,2,3$' \
    "$(jq -r '.nodes[0].selection_history | map(.seq) | join(",")' "$sel_state")"
  expect_match "node selections keeps the last sequence" '^3$' "$(jq -r '.nodes[0].last_event_sequence' "$sel_state")"
  expect_match "node selections sets the requested selector" '^hub/smart-auto-balance$' \
    "$(jq -r '.nodes[0].requested_selector' "$sel_state")"
  expect_match "node selections takes main_model from the latest solver event" '^llama_swap/qwen3.6-35b$' \
    "$(jq -r '.nodes[0].main_model' "$sel_state")"
  expect_match "node selections lists the judge as an active stage" '^judge$' \
    "$(jq -r '.nodes[0].active_stages | join(",")' "$sel_state")"
  expect_match "node selections sets actual_model from the latest solver event" '^llama_swap/qwen3.6-35b$' \
    "$(jq -r '.nodes[0].actual_model' "$sel_state")"
  expect_match "node selections sets the role from the latest solver event" '^implementation$' \
    "$(jq -r '.nodes[0].role' "$sel_state")"
  expect_match "node selections fills a missing tier" '^balance$' "$(jq -r '.nodes[0].tier' "$sel_state")"
  expect_match "node selections sets effort from selected_effort" '^high$' "$(jq -r '.nodes[0].effort' "$sel_state")"
  expect_match "node selections records each effort change once" '^1:medium,2:high$' \
    "$(jq -r '.nodes[0].effort_history | map("\(.seq):\(.effort)") | join(",")' "$sel_state")"
  out=$(sorch node selections wsel nsel 2>&1)
  expect_match "a repeated node selections adds nothing" '^selections: 0 new$' "$out"
  expect_match "a repeated node selections keeps the history length" '^3$' \
    "$(jq -r '.nodes[0].selection_history | length' "$sel_state")"
  out=$(env HARNESS_ORCH_HOME="$sel_home" LLM_HUB_URL= bun "$SCRIPT" node selections wsel nsel 2>&1); rc=$?
  expect_exit "node selections without a hub url exits 2" 2 "$rc"
  stop_sel_pid="$sel_pid"
  kill "$stop_sel_pid" 2>/dev/null
  wait "$stop_sel_pid" 2>/dev/null
  cleanup_dir "$sel_home"
  cleanup_dir "$sel_dir"
fi

# --- herdr panes ----------------------------------------------------------------
# The pane runner itself is covered by herdr-runner.test.sh; here only the status race and the verbs.
herdr_home=$(new_tmp)
with_herdr() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$herdr_home" "$@"; }
with_herdr bun "$SCRIPT" init >/dev/null 2>&1
# The pane is still booting: the launcher and herdr_pane exist, but the pid file is not written yet.
race_job=herdr-race
mkdir -p "$herdr_home/jobs/$race_job"
printf '#!/usr/bin/env bash\n' > "$herdr_home/jobs/$race_job/herdr-launch.sh"
printf 'w1:p9\n' > "$herdr_home/jobs/$race_job/herdr_pane"
expect_match "a herdr job with no pid yet reports running" '^running$' "$(with_herdr bun "$SCRIPT" status "$race_job")"
out=$(with_herdr bun "$SCRIPT" herdr off 2>&1)
expect_match "herdr off reports the setting" '^herdr: off' "$out"
off_job=$(with_herdr bun "$SCRIPT" start claude "off probe" 2>/dev/null)
with_herdr bun "$SCRIPT" wait "$off_job" --timeout 60 --interval 1 >/dev/null 2>&1
expect_no_match "with herdr off no pane is used" '.' "$(cat "$herdr_home/jobs/$off_job/herdr_pane" 2>/dev/null)"
out=$(with_herdr bun "$SCRIPT" herdr maybe 2>&1); rc=$?
expect_exit "herdr with an unknown verb exits 2" 2 "$rc"
cleanup_dir "$herdr_home"

# --- run stop -------------------------------------------------------------------
stop_home=$(new_tmp)
stop_shims=$(new_tmp)
printf '#!/usr/bin/env bash\nsleep 30\n' > "$stop_shims/claude"
chmod +x "$stop_shims/claude"
with_stop() { env PATH="$stop_shims:$PATH" HARNESS_ORCH_HOME="$stop_home" "$@"; }
with_stop bun "$SCRIPT" init >/dev/null 2>&1
with_stop bun "$SCRIPT" run start "Stop me" --id stop-run >/dev/null
with_stop bun "$SCRIPT" node add stop-run a "a" >/dev/null
with_stop bun "$SCRIPT" node add stop-run b "b" --after a >/dev/null
stop_job=$(with_stop bun "$SCRIPT" node dispatch stop-run a claude "sleep" 2>/dev/null)
out=$(with_stop bun "$SCRIPT" run stop stop-run 2>&1); rc=$?
expect_exit "run stop exits 0" 0 "$rc"
expect_match "run stop reports the killed job" 'killed 1 job' "$out"
with_stop bun "$SCRIPT" wait "$stop_job" --timeout 60 --interval 1 >/dev/null 2>&1
expect_match "the stopped job records SIGTERM" '^done exit=143$' "$(with_stop bun "$SCRIPT" status "$stop_job")"
stop_state="$stop_home/runs/stop-run/state.json"
expect_match "run stop sets stopped (resumable, not cancelled)" '^true running$' "$(jq -r '"\(.stopped) \(.status)"' "$stop_state")"
expect_match "run stop marks the running node stopped, waiting stays" '^stopped waiting$' "$(jq -r '[.nodes[].status] | join(" ")' "$stop_state")"
with_stop bun "$SCRIPT" run sync stop-run >/dev/null 2>&1
expect_match "run sync does not restart a stopped run" '^stopped$' "$(jq -r '.nodes[0].status' "$stop_state")"
out=$(with_stop bun "$SCRIPT" run stop 2>&1); rc=$?
expect_exit "run stop without a run id exits 2" 2 "$rc"
out=$(with_stop bun "$SCRIPT" run stop no-such-run 2>&1); rc=$?
expect_exit "run stop on an unknown run exits 2" 2 "$rc"
cleanup_dir "$stop_shims"
cleanup_dir "$stop_home"

out=$(env ORCH_BIN_DIRS= PATH="$(path_without claude)" bun "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_match "claude missing is reported" 'claude not found on PATH' "$out"
expect_exit "claude missing exits 127" 127 "$rc"

# A supervisor (launchd/systemd) starts with a minimal PATH. The adapter has to find the CLI in
# the same places `harness list` does, or the dashboard reports "ready" and every dispatch 127s.
out=$(env ORCH_BIN_DIRS="$shims" PATH="$(path_without claude)" HARNESS_ORCH_HOME="$home" \
  bun "$SCRIPT" run claude "off-path" 2>&1); rc=$?
expect_exit "claude off PATH but in ORCH_BIN_DIRS exits 0" 0 "$rc"
expect_match "claude off PATH is resolved from ORCH_BIN_DIRS" '^-p off-path --output-format json$' "$(joined "$out")"

out=$(with_shims bun "$SCRIPT" run --profile claude-default 2>&1); rc=$?
expect_match "run --profile without prompt shows grammar" 'usage: dispatch.ts run \(--profile <name> \| <adapter>\)' "$out"
expect_exit "run --profile without prompt exits 2" 2 "$rc"

out=$(with_shims bun "$SCRIPT" start --profile bogus "hi" 2>&1); rc=$?
expect_exit "start --profile bogus exits 2" 2 "$rc"
job_count=$(find "$home/jobs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
expect_match "start --profile bogus creates no job" '^0$' "$job_count"

job_id=$(with_shims bun "$SCRIPT" start --profile claude-default "bg" 2>/dev/null)
with_shims bun "$SCRIPT" wait "$job_id" --timeout 60 --interval 1 >/dev/null 2>&1
out=$(with_shims bun "$SCRIPT" list 2>&1)
expect_match "list shows the job's profile" "$job_id.done exit=0.claude-default" "$out"
out=$(with_shims bun "$SCRIPT" tail "$job_id" 2>&1)
expect_match "backgrounded profile job used the profile's model" '--model' "$out"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: profile env-ref test (python3 not found)\n' >&2
elif start_fixture 0; then
  out=$(env HARNESS_ORCH_HOME="$home" LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" \
    bun "$SCRIPT" run --profile local-llm-fast "ping" 2>&1)
  expect_match "profile env ref resolves and model reaches the endpoint" 'echo:ping.model=llama_swap/ornith-1.5-9b' "$out"
  stop_fixture
fi
cleanup_dir "$shims"
cleanup_dir "$home"


finish
