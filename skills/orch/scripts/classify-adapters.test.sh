#!/usr/bin/env bash
# dispatch.sh tests: classify, budget-check, argument validation, adapters, jobs
# Run: bash classify-adapters.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
export ORCH_NO_ANNOUNCE=1
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

# --- classify: fixed policy branches ----------------------------------------
# CLAUDE_USAGE_SNAPSHOT points at a file that doesn't exist, so budget_check takes its
# "no snapshot" pass-through path deterministically in every case below.
home=$(new_tmp)
out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL= bash "$SCRIPT" classify "fix a typo" 2>/dev/null)
expect_match "short prompt, budget ok -> claude-native" '^claude-native$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL= bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "explicit trivial, budget ok -> claude-native" '^claude-native$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL= bash "$SCRIPT" classify "anything" --complexity large 2>/dev/null)
expect_match "large complexity, no local pref -> claude-native" '^claude-native$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL=http://127.0.0.1:1 bash "$SCRIPT" classify "anything" --complexity medium 2>/dev/null)
expect_match "medium complexity + LLM_HUB_URL set -> local-llm" '^local-llm$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL=http://127.0.0.1:1 bash "$SCRIPT" classify "anything" --complexity large --prefer-local 2>/dev/null)
expect_match "--prefer-local overrides complexity -> local-llm" '^local-llm$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/no-such-file.json" LLM_HUB_URL= bash "$SCRIPT" classify "anything" --complexity medium 2>/dev/null)
expect_match "medium complexity, no LLM_HUB_URL -> claude-native" '^claude-native$' "$out"
cleanup_dir "$home"

# --- classify: budget-fail fallback chain -----------------------------------
home=$(new_tmp)
snapshot="$home/busy.json"
write_snapshot "$snapshot" "$(subscription_snapshot '{"five_hour":{"used_percentage":99}}')"

out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "budget over threshold, cursor-agent on PATH -> cursor-agent" '^cursor-agent$' "$out"

out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" PATH="$(path_without cursor-agent)" bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "cursor-agent absent, opencode on PATH -> opencode" '^opencode$' "$out"

filtered_path2=$(path_without cursor-agent opencode copilot)
copilot_shim=$(new_tmp)
printf '#!/usr/bin/env bash\n' > "$copilot_shim/copilot"
chmod +x "$copilot_shim/copilot"
out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" PATH="$copilot_shim:$filtered_path2" bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "cursor-agent/opencode absent, copilot on PATH -> copilot" '^copilot$' "$out"

filtered_path=$(path_without cursor-agent opencode copilot)
out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" PATH="$filtered_path" LLM_HUB_URL=http://127.0.0.1:1 \
  bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "no cursor-agent/opencode/copilot, LLM_HUB_URL set -> local-llm" '^local-llm$' "$out"

full_out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" PATH="$filtered_path" LLM_HUB_URL= bash "$SCRIPT" classify "anything" --complexity trivial 2>&1)
expect_match "nothing available -> claude-native fallback" 'claude-native' "$full_out"
expect_match "fallback warns about the compromise" 'no alternate harness available' "$full_out"
cleanup_dir "$home"

# --- budget-check subcommand: fresh/stale/missing/non-subscription ---------
home=$(new_tmp)

out=$(env CLAUDE_USAGE_SNAPSHOT="$home/missing.json" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_match "missing snapshot reports itself" 'no snapshot at' "$out"
expect_exit "missing snapshot defaults to safe (exit 0)" 0 "$rc"

nonsub="$home/nonsub.json"
write_snapshot "$nonsub" '{"api":{"type":"api_key"}}'
out=$(env CLAUDE_USAGE_SNAPSHOT="$nonsub" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_match "non-subscription account reported" 'not subscription' "$out"
expect_exit "non-subscription account is not gated (exit 0)" 0 "$rc"

fresh_under="$home/fresh_under.json"
write_snapshot "$fresh_under" "$(subscription_snapshot '{"five_hour":{"used_percentage":10},"day":{"used_percentage":20}}')"
out=$(env CLAUDE_USAGE_SNAPSHOT="$fresh_under" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_match "fresh snapshot under threshold reports safe" 'all windows below' "$out"
expect_exit "fresh snapshot under threshold exits 0" 0 "$rc"

fresh_over="$home/fresh_over.json"
write_snapshot "$fresh_over" "$(subscription_snapshot '{"five_hour":{"used_percentage":10},"week":{"used_percentage":91}}')"
out=$(env CLAUDE_USAGE_SNAPSHOT="$fresh_over" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_match "fresh snapshot over threshold names the window" 'week window at 91' "$out"
expect_exit "fresh snapshot over threshold exits 1" 1 "$rc"

stale="$home/stale.json"
write_snapshot "$stale" '{"api":{"type":"subscription"},"captured_at":"2020-01-01T00:00:00Z","rate_limits":{"five_hour":{"used_percentage":99}}}'
out=$(env CLAUDE_USAGE_SNAPSHOT="$stale" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_match "stale snapshot reports its age" 'old' "$out"
expect_exit "stale snapshot defaults to safe despite high usage (exit 0)" 0 "$rc"
cleanup_dir "$home"

# --- run/start argument validation ------------------------------------------
out=$(bash "$SCRIPT" run 2>&1); rc=$?
expect_match "run with no args shows usage" 'usage: dispatch.sh run' "$out"
expect_exit "run with no args exits 2" 2 "$rc"

out=$(bash "$SCRIPT" start claude-native 2>&1); rc=$?
expect_match "start missing prompt shows usage" 'usage: dispatch.sh start' "$out"
expect_exit "start missing prompt exits 2" 2 "$rc"

out=$(bash "$SCRIPT" run claude-native '@/no/such/promptfile' 2>&1); rc=$?
expect_match "missing @file reports itself" 'prompt file not found' "$out"
expect_exit "missing @file exits 1" 1 "$rc"

# --- adapter "not found" degradation ----------------------------------------
out=$(env ORCH_BIN_DIRS= PATH="$(path_without cursor-agent)" bash "$SCRIPT" run cursor-agent "hi" 2>&1); rc=$?
expect_match "cursor-agent missing is reported" 'cursor-agent not found on PATH' "$out"
expect_exit "cursor-agent missing exits 127" 127 "$rc"

out=$(env ORCH_BIN_DIRS= PATH="$(path_without opencode)" bash "$SCRIPT" run opencode "hi" 2>&1); rc=$?
expect_match "opencode missing is reported" 'opencode not found on PATH' "$out"
expect_exit "opencode missing exits 127" 127 "$rc"

out=$(env ORCH_BIN_DIRS= PATH="$(path_without copilot)" bash "$SCRIPT" run copilot "hi" 2>&1); rc=$?
expect_match "copilot missing is reported" 'copilot not found on PATH' "$out"
expect_exit "copilot missing exits 127" 127 "$rc"

hub_home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$hub_home" LLM_HUB_URL= -u LLM_HUB_V1_URL bash "$SCRIPT" run local-llm "hi" 2>&1); rc=$?
expect_match "local-llm with no LLM_HUB_URL is reported" 'LLM_HUB_URL not set' "$out"
expect_exit "local-llm with no LLM_HUB_URL exits 1" 1 "$rc"

# The env file must not resurrect a value the caller explicitly cleared.
printf 'LLM_HUB_URL=http://127.0.0.1:9\n' > "$hub_home/env"
out=$(env HARNESS_ORCH_HOME="$hub_home" LLM_HUB_URL= -u LLM_HUB_V1_URL bash "$SCRIPT" run local-llm "hi" 2>&1); rc=$?
expect_match "an explicitly cleared var is not refilled from the env file" 'LLM_HUB_URL not set' "$out"
# Unset entirely, the file is what supplies it — that is the point of the file.
out=$(env HARNESS_ORCH_HOME="$hub_home" -u LLM_HUB_URL -u LLM_HUB_V1_URL bash "$SCRIPT" run local-llm "hi" 2>&1); rc=$?
expect_no_match "an unset var is supplied by the env file" 'LLM_HUB_URL not set' "$out"

# LLM_HUB_V1_URL derivation: exactly one trailing /v1, whatever shape LLM_HUB_URL has. Sourced as
# a library so the exported value itself is observable.
derive_v1() {
  env -u LLM_HUB_URL -u LLM_HUB_V1_URL HARNESS_ORCH_HOME="$hub_home" "$@" \
    bash -c ". '$SCRIPT'; llm_hub_derive_v1_url; printf '%s' \"\${LLM_HUB_V1_URL-<unset>}\"" 2>&1
}
out=$(derive_v1 LLM_HUB_URL=http://h:1)
expect_match "v1 url is appended to a bare hub url" '^http://h:1/v1$' "$out"
out=$(derive_v1 LLM_HUB_URL=http://h:1/)
expect_match "v1 url drops a trailing slash" '^http://h:1/v1$' "$out"
out=$(derive_v1 LLM_HUB_URL=http://h:1/v1)
expect_match "v1 url is not doubled when the hub url already ends in /v1" '^http://h:1/v1$' "$out"
out=$(derive_v1 LLM_HUB_URL=http://h:1/v1/)
expect_match "v1 url handles /v1 plus a trailing slash" '^http://h:1/v1$' "$out"
out=$(derive_v1 LLM_HUB_URL=http://h:1 LLM_HUB_V1_URL=http://other:2/custom/v1)
expect_match "an explicit LLM_HUB_V1_URL wins" '^http://other:2/custom/v1$' "$out"
out=$(derive_v1)
expect_match "no LLM_HUB_URL exports no v1 url" '^<unset>$' "$out"

# The local-llm adapter posts to the derived /v1 base. curl is stubbed as a shell function that
# reports the URL it was handed, so no network is touched.
adapter_url() {
  env -u LLM_HUB_URL -u LLM_HUB_V1_URL HARNESS_ORCH_HOME="$hub_home" "$@" \
    bash -c ". '$SCRIPT'
      curl() { local url; for url; do :; done; jq -n --arg u \"\$url\" '{choices: [{message: {content: \$u}}]}'; }
      adapter_local_llm hi" 2>&1
}
out=$(adapter_url LLM_HUB_URL=http://h:1)
expect_match "local-llm posts under /v1" '^http://h:1/v1/chat/completions$' "$out"
out=$(adapter_url LLM_HUB_URL=http://h:1/v1)
expect_match "local-llm does not double /v1" '^http://h:1/v1/chat/completions$' "$out"
out=$(adapter_url LLM_HUB_URL=http://h:1 LLM_HUB_V1_URL=http://other:2/v1)
expect_match "local-llm honors an explicit LLM_HUB_V1_URL" '^http://other:2/v1/chat/completions$' "$out"
cleanup_dir "$hub_home"

# --- claude-native: run + fast job bookkeeping ------------------------------
home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run claude-native "hi" 2>&1); rc=$?
expect_match "run claude-native prints the sentinel notice" 'no subprocess spawned' "$out"
expect_exit "run claude-native exits 0" 0 "$rc"

job_id=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" start claude-native "hi" 2>/dev/null)
env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 60 --interval 1 >/dev/null 2>&1
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" status "$job_id" 2>&1)
expect_match "claude-native job finishes as done exit=0" '^done exit=0$' "$out"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" tail "$job_id" 2>&1)
expect_match "tail shows the sentinel notice" 'no subprocess spawned' "$out"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" list 2>&1)
expect_match "list includes the finished job" "$job_id.*done exit=0" "$out"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" status "no-such-job" 2>&1); rc=$?
expect_match "unknown job-id reported" 'unknown job' "$out"
expect_exit "unknown job-id exits 2" 2 "$rc"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" tail "no-such-job" 2>&1); rc=$?
expect_match "tail of unknown job-id reported" 'no log for job' "$out"
expect_exit "tail of unknown job-id exits 2" 2 "$rc"
cleanup_dir "$home"

# --- local-llm: running -> done transition, wait timeout, @file, echo-back --
# Fixture: a one-shot local HTTP server that sleeps before responding, so a job is observably
# "running" for a controlled window, then "done". It echoes the prompt it received back in the
# response so @file resolution can be verified without any real endpoint.
fixture_dir=$(new_tmp)
cat > "$fixture_dir/fixture_server.py" <<'PY'
import http.server, json, sys, time

port_file, delay = sys.argv[1], float(sys.argv[2])
forever = len(sys.argv) > 3 and sys.argv[3] == "forever"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw)
            received = parsed.get("messages", [{}])[0].get("content", "")
            model = parsed.get("model", "")
        except (ValueError, IndexError):
            received, model = "", ""
        time.sleep(delay)
        content = "echo:" + received + "|model=" + model
        body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass

server_class = http.server.ThreadingHTTPServer if forever else http.server.HTTPServer
httpd = server_class(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(httpd.server_address[1]))
if forever:
    httpd.serve_forever()
else:
    httpd.handle_request()
PY

# start_fixture <delay-secs> [forever]: one-shot server (or a multi-request one with `forever`) on FIXTURE_PORT; records a FAIL and returns 1 if it
# never comes up. Always pair with stop_fixture so a stuck server can't hang the suite.
start_fixture() {
  local port_file="$fixture_dir/port.$$.$RANDOM"
  python3 "$fixture_dir/fixture_server.py" "$port_file" "$1" ${2:+"$2"} &
  FIXTURE_PID=$!
  for _ in $(seq 1 600); do [ -s "$port_file" ] && break; sleep 0.1; done
  FIXTURE_PORT=$(cat "$port_file" 2>/dev/null)
  [ -n "$FIXTURE_PORT" ] && return 0
  printf 'FAIL: fixture HTTP server never reported a port\n' >&2
  failures=$((failures + 1))
  stop_fixture
  return 1
}

stop_fixture() {
  kill "$FIXTURE_PID" 2>/dev/null
  wait "$FIXTURE_PID" 2>/dev/null
}

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: local-llm timing tests (python3 not found)\n' >&2
else
  home=$(new_tmp)
  if start_fixture 8; then
    promptfile="$fixture_dir/prompt.txt"
    printf 'hello from a file' > "$promptfile"

    job_id=$(env HARNESS_ORCH_HOME="$home" LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" -u LLM_HUB_V1_URL \
      bash "$SCRIPT" start local-llm "@$promptfile" 2>/dev/null)

    sleep 0.5
    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" status "$job_id" 2>&1)
    expect_match "job is running mid-flight" '^running$' "$out"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 1 --interval 1 2>&1); rc=$?
    expect_exit "wait times out before the fixture responds" 124 "$rc"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 60 --interval 1 2>&1); rc=$?
    expect_match "wait reports done once the fixture responds" '^done exit=0$' "$out"
    expect_exit "wait exits 0 once finished" 0 "$rc"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" tail "$job_id" 2>&1)
    expect_match "@file content was read and echoed back" 'echo:hello from a file' "$out"
    stop_fixture
  fi
  cleanup_dir "$home"
fi


finish
