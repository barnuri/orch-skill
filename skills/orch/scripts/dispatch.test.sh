#!/usr/bin/env bash
# Tests for dispatch.sh — classification rules, budget-check thresholds, and job bookkeeping.
#
# No real harness CLI is invoked and no real network is touched:
#  - cursor-agent/opencode "not found" paths are exercised by stripping their real bin dirs from
#    PATH for that one invocation (both happen to be installed on this machine).
#  - Timing-sensitive job bookkeeping (running -> done, wait timeout) uses a tiny self-hosted
#    Python HTTP fixture bound to 127.0.0.1 on an ephemeral port — a controlled local stand-in
#    for the local-llm adapter's endpoint, not a real network call. claude-native (the built-in
#    instant, no-subprocess adapter) covers everything that doesn't need a "running" window.
#
# Run: bash dispatch.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"

failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}

expect_no_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then
    printf 'FAIL: %s\n  expected NOT to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
    failures=$((failures + 1))
    return
  fi
  pass_count=$((pass_count + 1))
}

expect_file() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected file: %s\n' "$label" "$path" >&2
  failures=$((failures + 1))
}

expect_missing() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected to be gone: %s\n' "$label" "$path" >&2
  failures=$((failures + 1))
}

expect_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass_count=$((pass_count + 1))
    return
  fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$expected" "$actual" >&2
  failures=$((failures + 1))
}

new_tmp() { mktemp -d; }

# Scratch dirs go to the Trash rather than rm -rf (repo rule: deletions stay recoverable). If
# `trash` is unavailable the dir is simply left under $TMPDIR for the OS to reap.
cleanup_dir() { trash "$1" 2>/dev/null || true; }

write_snapshot() { printf '%s' "$2" > "$1"; }

# edit_json <file> <jq-filter>: rewrite a JSON file in place through jq.
edit_json() { jq "$2" "$1" > "$1.tmp" && mv "$1.tmp" "$1"; }

# PATH with each named binary's own directory removed, so `command -v <name>` reports "not
# found" without disturbing any other tool dispatch.sh itself needs (date, jq, curl, stat, ...).
# A name that isn't on PATH to begin with is skipped.
path_without() {
  local result="$PATH" bin resolved dir
  for bin in "$@"; do
    while resolved=$(PATH="$result" command -v "$bin" 2>/dev/null); do
      dir=$(dirname "$resolved")
      result=$(printf '%s' "$result" | tr ':' '\n' | grep -vxF "$dir" | paste -sd: -)
      [ -n "$result" ] || break
    done
  done
  printf '%s' "$result"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Builds a fresh subscription snapshot JSON with the given rate_limits object.
subscription_snapshot() {
  printf '{"api":{"type":"subscription"},"captured_at":"%s","rate_limits":%s}' "$(now_iso)" "$1"
}

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

filtered_path=$(path_without cursor-agent opencode)
out=$(env CLAUDE_USAGE_SNAPSHOT="$snapshot" PATH="$filtered_path" LLM_HUB_URL=http://127.0.0.1:1 \
  bash "$SCRIPT" classify "anything" --complexity trivial 2>/dev/null)
expect_match "no cursor-agent/opencode, LLM_HUB_URL set -> local-llm" '^local-llm$' "$out"

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

out=$(env LLM_HUB_URL= bash "$SCRIPT" run local-llm "hi" 2>&1); rc=$?
expect_match "local-llm with no LLM_HUB_URL is reported" 'LLM_HUB_URL not set' "$out"
expect_exit "local-llm with no LLM_HUB_URL exits 1" 1 "$rc"

# --- claude-native: run + fast job bookkeeping ------------------------------
home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run claude-native "hi" 2>&1); rc=$?
expect_match "run claude-native prints the sentinel notice" 'no subprocess spawned' "$out"
expect_exit "run claude-native exits 0" 0 "$rc"

job_id=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" start claude-native "hi" 2>/dev/null)
env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 5 --interval 1 >/dev/null 2>&1
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

httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(httpd.server_address[1]))
httpd.handle_request()
PY

# start_fixture <delay-secs>: one-shot server on FIXTURE_PORT; records a FAIL and returns 1 if it
# never comes up. Always pair with stop_fixture so a stuck server can't hang the suite.
start_fixture() {
  local port_file="$fixture_dir/port.$$.$RANDOM"
  python3 "$fixture_dir/fixture_server.py" "$port_file" "$1" &
  FIXTURE_PID=$!
  for _ in $(seq 1 50); do [ -s "$port_file" ] && break; sleep 0.1; done
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
  if start_fixture 2; then
    promptfile="$fixture_dir/prompt.txt"
    printf 'hello from a file' > "$promptfile"

    job_id=$(env HARNESS_ORCH_HOME="$home" LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" \
      bash "$SCRIPT" start local-llm "@$promptfile" 2>/dev/null)

    sleep 0.5
    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" status "$job_id" 2>&1)
    expect_match "job is running mid-flight" '^running$' "$out"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 1 --interval 1 2>&1); rc=$?
    expect_exit "wait times out before the fixture responds" 124 "$rc"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$job_id" --timeout 10 --interval 1 2>&1); rc=$?
    expect_match "wait reports done once the fixture responds" '^done exit=0$' "$out"
    expect_exit "wait exits 0 once finished" 0 "$rc"

    out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" tail "$job_id" 2>&1)
    expect_match "@file content was read and echoed back" 'echo:hello from a file' "$out"
    stop_fixture
  fi
  cleanup_dir "$home"
fi

# --- init / profiles / memory -----------------------------------------------
home=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init 2>&1); rc=$?
expect_exit "init exits 0" 0 "$rc"
expect_match "init prints the config home" "$home" "$out"
expect_file "init copies profiles.json" "$home/profiles.json"
expect_file "init copies serve.json" "$home/serve.json"
expect_file "init creates memory.json" "$home/memory.json"
# The file:// dashboard is gone: the server renders from state.json directly.
expect_missing "init installs no index.html" "$home/index.html"
expect_missing "init creates no data dir" "$home/data"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile list 2>&1)
expect_match "profile list marks the default" '^\*claude-sub' "$out"
expect_match "profile list shows harness and model id" 'claude-llm-hub	claude	local-lfm-8b' "$out"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show cursor-default 2>&1)
expect_match "cursor-default is pinned to the Auto model" '"model": "cursor-auto"' "$out"
expect_match "cursor-default allows only Auto" '"cursor-auto"' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" model list --profile cursor-default 2>&1)
expect_match "cursor Auto resolves to the auto slug" 'cursor-auto\tauto' "$out"
expect_no_match "cursor-default whitelist excludes composer" 'composer-1' "$out"

# A profiles.json still on the old composer default is retargeted; a deliberate choice is not.
mig=$(new_tmp)
jq -n '{settings:{default_profile:"cursor-default",retention_days:7,budget_threshold:85},
        models:{"cursor-composer":{slug:"composer-1",harnesses:["cursor-agent"],description:""}},
        profiles:{"cursor-default":{harness:"cursor-agent",model:"cursor-composer",flags:[],env:{},auth:[]},
                  "cursor-pinned":{harness:"cursor-agent",model:"cursor-composer",flags:[],env:{},auth:[]}}}' \
  > "$mig/profiles.json"
env HARNESS_ORCH_HOME="$mig" bash "$SCRIPT" init >/dev/null 2>&1
migrated=$(jq -r '.profiles["cursor-default"].model' "$mig/profiles.json")
expect_match "migration retargets cursor-default to Auto" '^cursor-auto$' "$migrated"
migrated=$(jq -r '.profiles["cursor-default"].allowed_models | join(",")' "$mig/profiles.json")
expect_match "migration pins the Auto whitelist" '^cursor-auto$' "$migrated"
migrated=$(jq -r '.models["cursor-auto"].slug' "$mig/profiles.json")
expect_match "migration seeds the Auto catalog entry" '^auto$' "$migrated"
migrated=$(jq -r '.profiles["cursor-pinned"].model' "$mig/profiles.json")
expect_match "migration leaves other cursor profiles alone" '^cursor-composer$' "$migrated"
cleanup_dir "$mig"

# --- demo seeding -----------------------------------------------------------------------------
# The demo exists so a reader can see the dashboard populated without spending a token, so the
# thing worth guarding is that it never reaches a harness and that reset removes exactly what
# seed created.
demo=$(new_tmp)
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo 2>&1); rc=$?
expect_exit "demo with no verb exits 2" 2 "$rc"
expect_match "demo with no verb prints its grammar" 'demo seed' "$out"

# The default state dir is the user's real one; seeding fake runs into it takes --force.
out=$(env -u HARNESS_ORCH_HOME bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed refuses the default home" 2 "$rc"
expect_match "demo seed names the scratch-dir escape" 'HARNESS_ORCH_HOME' "$out"

env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" init >/dev/null 2>&1
# No harness CLI on PATH at all: if seeding tried to dispatch, it would fail loudly here.
out=$(env HARNESS_ORCH_HOME="$demo" PATH="$(path_without claude cursor-agent opencode)" \
  bash "$SCRIPT" demo seed 2>&1); rc=$?
expect_exit "demo seed exits 0 with no harness CLI present" 0 "$rc"
expect_match "demo seed reports what it seeded" 'seeded 4 runs' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo seeds a run in flight" 'running.*Ship the payments service' "$out"
expect_match "demo seeds a failed run" 'error.*Migrate the llm-hub profiles' "$out"
expect_match "demo seeds a finished run" 'done.*Nightly benchmark sweep' "$out"

state=$(cat "$demo"/runs/*/state.json | jq -s '.')
statuses=$(printf '%s' "$state" | jq -r '[.[].nodes[].status] | unique | join(",")')
expect_match "demo covers every node status" '^done,error,running,skipped,waiting$' "$statuses"
adapters=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select(.adapter != null) | .adapter] | unique | join(",")')
expect_match "demo covers more than one harness" 'claude,cursor-agent' "$adapters"
tails=$(printf '%s' "$state" | jq -r '[.[].nodes[] | select((.log_tail | length) > 0)] | length')
expect_match "demo nodes carry a log tail" '^[1-9]' "$tails"

# Every job dir a real dispatch would write, so the transcript view and `tail` work on demo data.
job_dir=$(ls -d "$demo"/jobs/demo-*/ 2>/dev/null | head -1)
expect_file "demo job has a full log" "$job_dir/log"
expect_file "demo job records its adapter" "$job_dir/adapter"
expect_file "demo job records a session id" "$job_dir/session"
session=$(cat "$job_dir/session" 2>/dev/null)
expect_match "demo session id is a uuid" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$session"

# A run the demo did not create must survive reset.
env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run start "a real run" --id 20260101-000000-keep >/dev/null 2>&1
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo advance 2>&1); rc=$?
expect_exit "demo advance exits 0" 0 "$rc"
expect_match "demo advance reports the node it moved" '	(done|running)$' "$out"

out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset removes the seeded runs" 'removed 4 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" demo reset 2>&1)
expect_match "demo reset is idempotent" 'removed 0 seeded run' "$out"
out=$(env HARNESS_ORCH_HOME="$demo" bash "$SCRIPT" run list 2>&1)
expect_match "demo reset leaves a non-demo run alone" '20260101-000000-keep' "$out"
expect_missing "demo reset clears the demo job dirs" "$job_dir"
cleanup_dir "$demo"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" harness list --json 2>&1)
expect_match "harness list json includes claude" '"id": "claude"' "$out"
expect_match "harness list json includes local-llm" '"id": "local-llm"' "$out"
wired=$(printf '%s' "$out" | jq -r '.harnesses[] | select(.id=="claude") | .wired')
expect_match "harness list json marks adapters wired" '^true$' "$wired"
expect_match "harness list json includes detected pi" '"id": "pi"' "$out"
edit_json "$home/profiles.json" '.settings.disabled_harnesses = ["opencode"]'
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" harness list --json 2>&1)
enabled=$(printf '%s' "$out" | jq -r '.harnesses[] | select(.id=="opencode") | .enabled')
expect_match "disabled harness shows enabled false" '^false$' "$enabled"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show claude-llm-hub 2>&1)
expect_match "profile show keeps env refs unresolved" '\$\{LLM_HUB_URL\}' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile show nope 2>&1); rc=$?
expect_match "unknown profile lists the available ones" 'claude-llm-hub' "$out"
expect_exit "unknown profile exits 2" 2 "$rc"

# init is idempotent: a user-edited profiles.json is never overwritten.
edit_json "$home/profiles.json" '.settings.default_profile = "custom"'
env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init >/dev/null 2>&1
out=$(jq -r '.settings.default_profile' "$home/profiles.json")
expect_match "second init keeps user edits" '^custom$' "$out"

# Leftovers from the retired file:// dashboard are recoverably removed on init.
mkdir -p "$home/data"
: > "$home/index.html"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" init 2>&1 >/dev/null)
expect_match "init reports legacy index.html cleanup" 'moved legacy dashboard leftover index.html' "$out"
expect_match "init reports legacy data cleanup" 'moved legacy dashboard leftover data' "$out"
expect_missing "init removes legacy index.html" "$home/index.html"
expect_missing "init removes legacy data dir" "$home/data"

# profile_load failure modes, driven by sourcing the script as a library.
load_profile() {
  env -u LLM_HUB_URL -u LLM_HUB_KEY -u CURSOR_API_KEY HARNESS_ORCH_HOME="$home" \
    bash -c ". '$SCRIPT'; profile_load '$1'" 2>&1
}
out=$(load_profile claude-llm-hub); rc=$?
expect_match "unset env ref is named" 'env ANTHROPIC_BASE_URL references unset \$\{LLM_HUB_URL\}' "$out"
expect_exit "unset env ref exits 3 (not configured, not broken)" 3 "$rc"

# cursor-agent authenticates through its own login, so the shipped cursor profile declares no
# auth. Asserting the auth path needs a profile that actually requires something.
edit_json "$home/profiles.json" '.profiles["needs-auth"] = {harness: "cursor-agent", model: "cursor-auto", flags: [], env: {}, auth: ["CURSOR_API_KEY"]}'
out=$(load_profile needs-auth); rc=$?
expect_match "missing auth var is named" 'required auth env var CURSOR_API_KEY is not set' "$out"
expect_exit "missing auth var exits 3 (not configured, not broken)" 3 "$rc"
out=$(load_profile cursor-default); rc=$?
expect_exit "the shipped cursor profile needs no auth env var" 0 "$rc"
edit_json "$home/profiles.json" 'del(.profiles["needs-auth"])' 
out=$(load_profile bogus); rc=$?
expect_exit "unknown profile in profile_load exits 2" 2 "$rc"
out=$(load_profile claude-sub); rc=$?
expect_exit "profile with no env/auth loads cleanly" 0 "$rc"

# budget threshold: settings value is honoured, env still wins.
snapshot="$home/over80.json"
write_snapshot "$snapshot" "$(subscription_snapshot '{"day":{"used_percentage":82}}')"
edit_json "$home/profiles.json" '.settings.budget_threshold = 80'
out=$(env HARNESS_ORCH_HOME="$home" CLAUDE_USAGE_SNAPSHOT="$snapshot" bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_exit "settings.budget_threshold=80 trips at 82%" 1 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" CLAUDE_USAGE_SNAPSHOT="$snapshot" HARNESS_ORCH_BUDGET_THRESHOLD=90 bash "$SCRIPT" budget-check 2>&1); rc=$?
expect_exit "env threshold overrides settings" 0 "$rc"

out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile claude-sub --outcome success --kind refactor --note "fast and clean" 2>&1); rc=$?
expect_exit "memory add exits 0" 0 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory list 2>&1)
expect_match "memory list round-trips the entry" 'claude-sub.success.refactor.fast and clean' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory list --profile nope 2>&1)
expect_no_match "memory list filters by profile" 'claude-sub' "$out"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile nope --outcome success 2>&1); rc=$?
expect_exit "memory add rejects unknown profile" 2 "$rc"
out=$(env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" memory add --profile claude-sub --outcome meh 2>&1); rc=$?
expect_match "memory add rejects bad outcome" 'outcome must be one of' "$out"
expect_exit "memory add bad outcome exits 2" 2 "$rc"
cleanup_dir "$home"

# --- routing + learning -------------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
orch init >/dev/null
out=$(orch profile pick "fix a typo" --complexity trivial 2>&1)
expect_match "profile pick prints profile" '^profile=' "$out"
expect_match "profile pick prints model id" '^model=' "$out"
out=$(orch model list --profile claude-sub 2>&1)
expect_match "model list includes catalog id" 'claude-sonnet' "$out"
edit_json "$home/profiles.json" '
  .models["local-lfm-8b"] = {
    "slug": "llama_swap/lfm2.5-8b-a1b",
    "harnesses": ["local-llm", "claude"],
    "description": "bench winner"
  }
  | .models["local-qwen3-4b"] = {
    "slug": "llama_swap/qwen3-4b-2507",
    "harnesses": ["local-llm", "claude"],
    "description": "backup"
  }
  | .profiles["claude-llm-hub"] = {
    "harness": "claude",
    "model": "local-lfm-8b",
    "allowed_models": ["llama_swap*"],
    "flags": [],
    "env": {},
    "auth": []
  }'
out=$(orch model list --profile claude-llm-hub 2>&1)
expect_match "model list expands llama_swap pattern" 'local-lfm-8b' "$out"
expect_match "model list includes second llama_swap model" 'local-qwen3-4b' "$out"
expect_no_match "model list excludes non-llama_swap" 'claude-sonnet' "$out"
edit_json "$home/profiles.json" '.profiles["opencode-default"].description = ""'
out=$(orch suggest scan 2>&1); rc=$?
expect_match "suggest scan completes" 'scanned' "$out"
expect_exit "suggest scan exits 0" 0 "$rc"
out=$(orch suggest list --pending 2>&1)
expect_match "suggest list finds empty description" 'profile_description' "$out"
desc_id=$(orch suggest list --pending 2>&1 | awk -F'\t' '$3 == "profile_description" && $4 ~ /opencode-default/ {print $1; exit}')
out=$(orch suggest apply "$desc_id" 2>&1); rc=$?
expect_exit "suggest apply profile_description exits 0" 0 "$rc"
out=$(jq -r '.profiles["opencode-default"].description // ""' "$home/profiles.json")
expect_match "suggest apply profile_description writes description" '.' "$out"
edit_json "$home/suggestions.json" '.suggestions += [{
  "id": "sug-test", "status": "pending", "created": "2026-01-01T00:00:00Z",
  "confidence": "medium", "kind": "memory_record",
  "title": "Record memory", "reason": "test",
  "evidence": [], "fingerprint": "memory_record:claude-sub:test",
  "action": {"type": "memory_record", "memory": {"profile": "claude-sub", "outcome": "success", "task_kind": "test", "note": "from test"}}
}]'
out=$(orch suggest apply sug-test 2>&1); rc=$?
expect_exit "suggest apply memory_record exits 0" 0 "$rc"
out=$(orch memory list --profile claude-sub 2>&1)
expect_match "suggest apply memory_record writes memory" 'from test' "$out"
out=$(orch suggest apply --json --id sug-test 2>&1); rc=$?
expect_match "suggest apply batch json reports failure for applied id" '"ok":false' "$out"
edit_json "$home/profiles.json" '.models["claude-haiku"].description = ""'
orch suggest scan >/dev/null
out=$(orch suggest apply --json --all 2>&1); rc=$?
expect_exit "suggest apply all exits 0" 0 "$rc"
expect_match "suggest apply all returns json" '"results":' "$out"
out=$(orch profile sanity --profile nope 2>&1); rc=$?
expect_exit "profile sanity unknown profile exits 0" 0 "$rc"
expect_match "profile sanity unknown profile ok false" '"ok":false' "$out"
expect_match "profile sanity unknown profile error" 'unknown profile' "$out"
edit_json "$home/profiles.json" '.profiles["claude-sub"].enabled = false'
out=$(orch profile sanity --profile claude-sub 2>&1); rc=$?
expect_exit "profile sanity disabled exits 0" 0 "$rc"
expect_match "profile sanity disabled ok false" '"ok":false' "$out"
expect_match "profile sanity disabled error" 'profile disabled' "$out"
cleanup_dir "$home"

# --- claude adapter + --profile grammar --------------------------------------
# Fake CLI shims print their argv one per line, so the exact argument shape can be asserted
# without running a real harness.
home=$(new_tmp)
shims=$(new_tmp)
for tool in claude cursor-agent opencode; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$shims/$tool"
  chmod +x "$shims/$tool"
done
with_shims() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" CURSOR_API_KEY=shim "$@"; }
joined() { printf '%s' "$1" | tr '\n' ' '; }

out=$(with_shims bash "$SCRIPT" run --profile claude-sub "hi there" --extra 2>&1)
expect_match "claude profile: argv order is model, profile flags, pass-through" \
  '^-p hi there --output-format text --model sonnet --dangerously-skip-permissions --extra$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" profile sanity --profile claude-sub 2>&1); rc=$?
expect_exit "profile sanity exits 0" 0 "$rc"
expect_match "profile sanity ok with shims" '"ok":true' "$out"
expect_match "profile sanity includes profile name" '"profile":"claude-sub"' "$out"
expect_match "profile sanity includes ms" '"ms":' "$out"
expect_match "profile sanity includes harness" '"harness":"claude"' "$out"

edit_json "$home/profiles.json" '.profiles["cursor-default"].model = "gpt-5"'
out=$(with_shims bash "$SCRIPT" run --profile cursor-default "x" 2>&1)
expect_match "cursor profile: model flag, no forced permission bypass" \
  '^-p x --output-format text --model gpt-5$' "$(joined "$out")"
expect_no_match "the cursor adapter never forces --force" '\-\-force' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run --profile opencode-default "x" 2>&1)
expect_match "opencode profile with empty model: no model flag" '^run x --auto$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run claude "plain" 2>&1)
expect_match "plain claude adapter: no model flag" '^-p plain --output-format text$' "$(joined "$out")"

# A dispatched job is only resumable if orch chose the session id and wrote it down, so both
# halves are asserted: the flag the harness saw, and the id left behind in the job dir.
session_home=$(new_tmp)
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" bash "$SCRIPT" init >/dev/null 2>&1
session_job=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" \
  bash "$SCRIPT" start claude "session probe" 2>/dev/null)
expect_match "start prints a job id" '^[0-9]{14}-' "$session_job"
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" \
  bash "$SCRIPT" wait "$session_job" --timeout 5 --interval 1 >/dev/null 2>&1
expect_file "start records the job's session id" "$session_home/jobs/$session_job/session"
session=$(cat "$session_home/jobs/$session_job/session" 2>/dev/null)
expect_match "the recorded session id is a uuid" \
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$session"
expect_match "the claude adapter is told which session to use" \
  "--session-id $session" "$(joined "$(cat "$session_home/jobs/$session_job/log" 2>/dev/null)")"
cleanup_dir "$session_home"

out=$(env ORCH_BIN_DIRS= PATH="$(path_without claude)" bash "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_match "claude missing is reported" 'claude not found on PATH' "$out"
expect_exit "claude missing exits 127" 127 "$rc"

# A supervisor (launchd/systemd) starts with a minimal PATH. The adapter has to find the CLI in
# the same places `harness list` does, or the dashboard reports "ready" and every dispatch 127s.
out=$(env ORCH_BIN_DIRS="$shims" PATH="$(path_without claude)" HARNESS_ORCH_HOME="$home" \
  bash "$SCRIPT" run claude "off-path" 2>&1); rc=$?
expect_exit "claude off PATH but in ORCH_BIN_DIRS exits 0" 0 "$rc"
expect_match "claude off PATH is resolved from ORCH_BIN_DIRS" '^-p off-path --output-format text$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run --profile claude-sub 2>&1); rc=$?
expect_match "run --profile without prompt shows grammar" 'usage: dispatch.sh run \(--profile <name> \| <adapter>\)' "$out"
expect_exit "run --profile without prompt exits 2" 2 "$rc"

out=$(with_shims bash "$SCRIPT" start --profile bogus "hi" 2>&1); rc=$?
expect_exit "start --profile bogus exits 2" 2 "$rc"
job_count=$(find "$home/jobs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
expect_match "start --profile bogus creates no job" '^0$' "$job_count"

job_id=$(with_shims bash "$SCRIPT" start --profile claude-sub "bg" 2>/dev/null)
with_shims bash "$SCRIPT" wait "$job_id" --timeout 5 --interval 1 >/dev/null 2>&1
out=$(with_shims bash "$SCRIPT" list 2>&1)
expect_match "list shows the job's profile" "$job_id.done exit=0.claude-sub" "$out"
out=$(with_shims bash "$SCRIPT" tail "$job_id" 2>&1)
expect_match "backgrounded profile job used the profile's model" '--model' "$out"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: profile env-ref test (python3 not found)\n' >&2
elif start_fixture 0; then
  out=$(env HARNESS_ORCH_HOME="$home" LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" \
    bash "$SCRIPT" run --profile local-qwen "ping" 2>&1)
  expect_match "profile env ref resolves and model reaches the endpoint" 'echo:ping.model=llama_swap/lfm2.5-8b-a1b' "$out"
  stop_fixture
fi
cleanup_dir "$shims"
cleanup_dir "$home"

# --- run / node lifecycle -----------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
state_get() { jq -r "$@" "$state"; }
state="$home/runs/life-1/state.json"

out=$(orch run start "Lifecycle test" --id life-1 2>&1); rc=$?
expect_exit "run start exits 0" 0 "$rc"
expect_match "run start echoes the id" '^life-1$' "$out"
expect_file "run start writes state.json" "$state"
out=$(orch run start "dup" --id life-1 2>&1); rc=$?
expect_exit "duplicate run id exits 2" 2 "$rc"
out=$(orch run start "bad" --id 'bad id' 2>&1); rc=$?
expect_exit "invalid run id exits 2" 2 "$rc"

orch node add life-1 n1 "Plan" >/dev/null 2>&1
orch node add life-1 n2 "Implement" --after n1 --profile claude-sub >/dev/null 2>&1
orch node add life-1 n3 "Review" --after n1,n2 >/dev/null 2>&1
out=$(orch node add life-1 n1 "again" 2>&1); rc=$?
expect_exit "duplicate node id exits 2" 2 "$rc"
out=$(orch node add life-1 n4 "x" --after nope 2>&1); rc=$?
expect_match "unknown dep is named" 'node nope: not in this run' "$out"
expect_exit "unknown dep exits 2" 2 "$rc"
out=$(orch node add life-1 n4 "x" --after n4 2>&1); rc=$?
expect_exit "self-dependency exits 2" 2 "$rc"
expect_match "edges recorded from --after" '^\[\["n1","n2"\],\["n1","n3"\],\["n2","n3"\]\]$' "$(state_get -c '.edges')"
expect_match "node profile recorded" '^claude-sub$' "$(state_get '.nodes[1].profile')"

out=$(orch run sync life-1 2>&1)
expect_match "only the root is ready initially" '^ready: n1$' "$out"
expect_match "nothing running initially" '^running: 0$' "$out"
orch node update life-1 n1 running >/dev/null 2>&1
expect_no_match "started stamped on running" '^null$' "$(state_get '.nodes[0].started')"
orch node update life-1 n1 "done" >/dev/null 2>&1
expect_no_match "finished stamped on done" '^null$' "$(state_get '.nodes[0].finished')"
out=$(orch run sync life-1 2>&1)
expect_match "n2 becomes ready once n1 is done" '^ready: n2$' "$out"
out=$(orch node update life-1 n2 bogus 2>&1); rc=$?
expect_match "invalid status is rejected" 'status must be one of' "$out"
expect_exit "invalid status exits 2" 2 "$rc"
orch node update life-1 n2 error --error "boom" >/dev/null 2>&1
expect_match "error message recorded" '^boom$' "$(state_get '.nodes[1].error')"
out=$(orch run finish life-1 2>&1)
expect_match "finish infers error from an errored node" '^error$' "$out"
expect_no_match "finish stamps finished" '^null$' "$(state_get '.finished')"
out=$(orch run list 2>&1)
expect_match "run list shows status, title and done/total" 'life-1.error.Lifecycle test.1/3' "$out"

# node dispatch: claude-native flips to done on sync; a profile node against the fixture is
# observably running, then done.
state="$home/runs/disp-1/state.json"
orch run start "Dispatch test" --id disp-1 >/dev/null 2>&1
orch node add disp-1 a "native" >/dev/null 2>&1
orch node add disp-1 b "hub" --profile local-qwen >/dev/null 2>&1
out=$(orch node dispatch disp-1 a claude-native "hello" 2>/dev/null); rc=$?
expect_exit "node dispatch exits 0" 0 "$rc"
orch wait "$out" --timeout 5 --interval 1 >/dev/null 2>&1
out=$(orch run sync disp-1 2>&1)
expect_match "dispatched claude-native node flips to done" '^a.done$' "$out"
expect_match "adapter recorded on the node" '^claude-native$' "$(state_get '.nodes[0].adapter')"
expect_match "log_tail captured on sync" 'no subprocess spawned' "$(state_get '.nodes[0].log_tail[0]')"
out=$(orch node dispatch disp-1 a claude-native "again" 2>&1); rc=$?
expect_match "re-dispatching a finished node is refused" 'is done, not waiting' "$out"
expect_exit "re-dispatch exits 2" 2 "$rc"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: node dispatch fixture test (python3 not found)\n' >&2
elif start_fixture 2; then
  job=$(LLM_HUB_URL="http://127.0.0.1:$FIXTURE_PORT" orch node dispatch disp-1 b "ping" 2>/dev/null); rc=$?
  expect_exit "node dispatch with the node's own profile exits 0" 0 "$rc"
  out=$(orch run sync disp-1 2>&1)
  expect_match "profile node is running mid-flight" '^b.running$' "$out"
  orch wait "$job" --timeout 10 --interval 1 >/dev/null 2>&1
  out=$(orch run sync disp-1 2>&1)
  expect_match "profile node is done after its job finishes" '^b.done$' "$out"
  expect_match "profile recorded on the dispatched node" '^local-qwen$' "$(state_get '.nodes[1].profile')"
  expect_match "harness recorded as the node adapter" '^local-llm$' "$(state_get '.nodes[1].adapter')"
  stop_fixture
fi
cleanup_dir "$home"

# --- prune / auto-prune ------------------------------------------------------
# A failing `trash` shim forces the .trash/ fallback so the test is deterministic on every machine.
home=$(new_tmp)
shims=$(new_tmp)
printf '#!/usr/bin/env bash\nexit 1\n' > "$shims/trash"
chmod +x "$shims/trash"
no_trash() { PATH="$shims:$PATH" orch "$@"; }

orch run start "live" --id live-1 >/dev/null 2>&1
orch run start "old" --id old-1 >/dev/null 2>&1
orch node add old-1 x "x" >/dev/null 2>&1
old_job=$(orch node dispatch old-1 x claude-native "hi" 2>/dev/null)
sleep 1
orch run sync old-1 >/dev/null 2>&1
orch run finish old-1 >/dev/null 2>&1
edit_json "$home/runs/old-1/state.json" '.finished = "2020-01-01T00:00:00Z"'

out=$(no_trash prune --dry-run 2>&1); rc=$?
expect_exit "prune --dry-run exits 0" 0 "$rc"
expect_match "dry-run lists the expired run" 'would prune: .*runs/old-1' "$out"
expect_match "dry-run lists the run's job" "would prune: .*jobs/$old_job" "$out"
expect_no_match "dry-run never touches the running run" 'live-1' "$out"
expect_file "dry-run leaves the state in place" "$home/runs/old-1/state.json"

out=$(no_trash prune 2>&1); rc=$?
expect_exit "prune exits 0" 0 "$rc"
expect_match "prune reports the run" 'pruned: .*runs/old-1' "$out"
expect_match "prune reports the count" '^pruned 1 run\(s\)' "$out"
expect_missing "run dir is gone" "$home/runs/old-1"
expect_missing "job dir is gone" "$home/jobs/$old_job"
expect_match "fallback moved the run under .trash" 'old-1' "$(find "$home/.trash" -maxdepth 2 -name 'old-1' 2>/dev/null)"
expect_match "fallback moved the job under .trash" "$old_job" "$(find "$home/.trash" -maxdepth 2 -name "$old_job" 2>/dev/null)"
expect_file "running run survives prune" "$home/runs/live-1/state.json"

out=$(orch prune --older-than xyz 2>&1); rc=$?
expect_match "bad --older-than is rejected" 'expects <N>d, <N>h or <N>' "$out"
expect_exit "bad --older-than exits 2" 2 "$rc"

orch run start "old2" --id old-2 >/dev/null 2>&1
orch run finish old-2 >/dev/null 2>&1
edit_json "$home/runs/old-2/state.json" '.finished = "2020-01-01T00:00:00Z"'
edit_json "$home/profiles.json" '.settings.retention_days = 1'
no_trash run start "trigger" --id trig-1 >/dev/null 2>&1
expect_missing "run start auto-prunes per settings.retention_days" "$home/runs/old-2"
expect_file "the new run itself is untouched" "$home/runs/trig-1/state.json"
cleanup_dir "$shims"
cleanup_dir "$home"
cleanup_dir "$fixture_dir"


# --- serve / ui ---------------------------------------------------------------
# No real bun is ever launched: a fake `bun` records its argv, writes the serve/ markers the
# lifecycle polls for, and then sleeps, so start/reuse/restart/stop are all observable.
home=$(new_tmp)
shims=$(new_tmp)

cat > "$shims/bun" <<'SHIM'
#!/usr/bin/env bash
serve_dir=""
for arg in "$@"; do
  [ -n "${want_home:-}" ] && { serve_dir="$arg/serve"; want_home=; }
  [ "$arg" = "--home" ] && want_home=1
done
mkdir -p "$serve_dir"
printf '%s\n' "$@" > "$serve_dir/argv"
printf '0.0.0.0' > "$serve_dir/host"
printf '12345' > "$serve_dir/port"
printf '%s' "$$" > "$serve_dir/pid"
exec sleep 30
SHIM
chmod +x "$shims/bun"

# The lifecycle probes /api/health before declaring the server up; the shim never binds a port.
printf '#!/usr/bin/env bash\nprintf 200\n' > "$shims/curl"
chmod +x "$shims/curl"

orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
fake_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" ORCH_BUN="$shims/bun" ORCH_NO_OPEN=1 \
  bash "$SCRIPT" "$@"; }
# Same shims, but with the opt-back-in to token auth on loopback.
fake_orch_token() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" ORCH_BUN="$shims/bun" \
  ORCH_NO_OPEN=1 ORCH_REQUIRE_TOKEN=1 bash "$SCRIPT" "$@"; }
orch init >/dev/null 2>&1
printf 'testtoken' > "$home/serve.token"
chmod 600 "$home/serve.token"

# Argument validation happens before bun is ever needed.
out=$(orch serve --bogus 2>&1); rc=$?
expect_exit "serve --bogus exits 2" 2 "$rc"
expect_match "serve --bogus prints usage" 'usage:' "$out"
out=$(orch serve --port abc 2>&1); rc=$?
expect_exit "serve --port abc exits 2" 2 "$rc"
out=$(orch serve --port 70000 2>&1); rc=$?
expect_exit "serve --port 70000 exits 2" 2 "$rc"
out=$(orch ui --bogus 2>&1); rc=$?
expect_exit "ui --bogus exits 2" 2 "$rc"
# `ui` reuses whatever server is already up, so it cannot choose the bind address.
out=$(orch ui --host 127.0.0.1 2>&1); rc=$?
expect_exit "ui --host exits 2" 2 "$rc"
out=$(orch ui --port 6725 2>&1); rc=$?
expect_exit "ui --port exits 2" 2 "$rc"

out=$(orch serve --stop 2>&1); rc=$?
expect_exit "serve --stop with no server exits 0" 0 "$rc"
expect_match "serve --stop says nothing is running" 'not running' "$out"

# A missing bun is a hard stop with an actionable message, never a silent no-op.
out=$(env HARNESS_ORCH_HOME="$home" ORCH_BUN=/nonexistent/bun bash "$SCRIPT" serve 2>&1); rc=$?
expect_exit "serve without bun exits 127" 127 "$rc"
expect_match "serve without bun names the binary" 'not found on PATH' "$out"
out=$(env HARNESS_ORCH_HOME="$home" ORCH_BUN=/nonexistent/bun bash "$SCRIPT" ui 2>&1); rc=$?
expect_exit "ui without bun exits 127" 127 "$rc"

out=$(fake_orch ui 2>&1); rc=$?
expect_exit "ui starts the server and exits 0" 0 "$rc"
expect_match "ui prints a tokenless loopback URL" '^http://127\.0\.0\.1:12345/$' "$out"
expect_file "ui recorded the server argv" "$home/serve/argv"
argv=$(cat "$home/serve/argv")
expect_match "argv carries --home" "^--home$" "$argv"
expect_match "argv carries the home path" "^$home$" "$argv"
expect_match "argv carries the default host" '^0\.0\.0\.0$' "$argv"
expect_match "argv carries the default port" '^6724$' "$argv"
expect_match "argv passes the harness enum" '^claude cursor-agent opencode local-llm$' "$argv"
expect_match "argv passes the outcome enum" '^success failure partial$' "$argv"
expect_match "serve dir is private" '^700$' "$(stat -f '%Lp' "$home/serve" 2>/dev/null || stat -c '%a' "$home/serve")"
expect_match "serve log is private" '^600$' "$(stat -f '%Lp' "$home/serve/log" 2>/dev/null || stat -c '%a' "$home/serve/log")"

# A second `ui` must attach to the running server, not spawn a duplicate.
first_pid=$(cat "$home/serve/pid")
out=$(fake_orch ui 2>&1); rc=$?
expect_exit "a second ui exits 0" 0 "$rc"
expect_match "a second ui prints the same URL" '^http://127\.0\.0\.1:12345/$' "$out"
expect_match "a second ui reuses the same process" "^$first_pid$" "$(cat "$home/serve/pid")"

# ORCH_REQUIRE_TOKEN restores the pre-bypass behaviour: the flag reaches the server and the
# printed URL carries the token again.
expect_no_match "argv omits --require-token by default" '^--require-token$' "$(cat "$home/serve/argv")"
fake_orch ui --stop >/dev/null 2>&1
out=$(fake_orch_token ui 2>&1); rc=$?
expect_exit "ui with ORCH_REQUIRE_TOKEN exits 0" 0 "$rc"
expect_match "ui with ORCH_REQUIRE_TOKEN prints the tokenized URL" \
  '^http://127\.0\.0\.1:12345/\?token=testtoken$' "$out"
expect_match "argv carries --require-token" '^--require-token$' "$(cat "$home/serve/argv")"
fake_orch ui --stop >/dev/null 2>&1

# serve.json allow_remote drops the remote token requirement; the flag reaches the server.
orch serve config set --allow-remote >/dev/null
fake_orch ui >/dev/null 2>&1
expect_match "argv carries --allow-remote from serve.json" '^--allow-remote$' "$(cat "$home/serve/argv")"
fake_orch ui --stop >/dev/null 2>&1
orch serve config set --no-allow-remote >/dev/null

out=$(orch serve config show 2>&1); rc=$?
expect_exit "serve config show exits 0" 0 "$rc"
expect_match "serve config show includes host" '"host"' "$out"
out=$(orch serve config get port 2>&1); rc=$?
expect_exit "serve config get port exits 0" 0 "$rc"
expect_match "serve config get port is 6724" '^6724$' "$out"
out=$(orch serve config set --host 127.0.0.1 --port 8080 2>&1); rc=$?
expect_exit "serve config set exits 0" 0 "$rc"
expect_match "serve config set writes host" '"host": "127.0.0.1"' "$out"
out=$(orch serve config get host 2>&1)
expect_match "serve config get host reflects set" '^127\.0\.0\.1$' "$out"
orch serve config set --host 0.0.0.0 --port 6724 >/dev/null
fake_orch ui >/dev/null 2>&1
first_pid=$(cat "$home/serve/pid")

out=$(fake_orch serve 2>&1); rc=$?
expect_exit "serve refuses while one is running" 1 "$rc"
expect_match "serve names the running address" 'already running on 0\.0\.0\.0:12345' "$out"

# An old pid marker means the sources changed after the server booted: restart, don't reuse.
touch -t 200001010000 "$home/serve/pid"
out=$(fake_orch ui 2>&1); rc=$?
expect_exit "ui restarts on changed sources" 0 "$rc"
expect_match "ui says it is restarting" 'restarting' "$out"
expect_no_match "the restarted server is a new process" "^$first_pid$" "$(cat "$home/serve/pid")"

running_pid=$(cat "$home/serve/pid")
out=$(fake_orch ui --stop 2>&1); rc=$?
expect_exit "ui --stop exits 0" 0 "$rc"
expect_match "ui --stop names the pid it killed" "stopped .pid $running_pid" "$out"
kill -0 "$running_pid" 2>/dev/null; rc=$?
expect_exit "the server process is gone" 1 "$rc"
expect_file "the pid marker is truncated, not deleted" "$home/serve/pid"
expect_match "the pid marker is empty" '^0$' "$(wc -c < "$home/serve/pid" | tr -d ' ')"

# A marker naming a dead process must not block the next start.
printf '999999' > "$home/serve/pid"
out=$(fake_orch ui 2>&1); rc=$?
expect_exit "ui starts cleanly past a stale marker" 0 "$rc"
expect_no_match "the stale pid was replaced" '^999999$' "$(cat "$home/serve/pid")"
fake_orch ui --stop >/dev/null 2>&1

out=$(fake_orch serve status 2>&1); rc=$?
expect_exit "serve status when down exits 1" 1 "$rc"
expect_match "serve status reports down" 'state=down' "$out"
out=$(fake_orch serve recover 2>&1); rc=$?
expect_exit "serve recover starts server" 0 "$rc"
expect_match "serve recover prints url" '^http://127\.0\.0\.1:12345/' "$out"
out=$(fake_orch serve status 2>&1); rc=$?
expect_exit "serve status when running exits 0" 0 "$rc"
expect_match "serve status reports running" 'state=running listener=answering' "$out"
fake_orch ui --stop >/dev/null 2>&1
printf '999999' > "$home/serve/pid"
out=$(fake_orch serve status 2>&1); rc=$?
expect_exit "serve status with stale pid exits 1" 1 "$rc"
expect_match "serve status names stale pid" 'stale_pid=999999' "$out"
out=$(fake_orch serve recover 2>&1); rc=$?
expect_exit "serve recover clears stale pid" 0 "$rc"
fake_orch ui --stop >/dev/null 2>&1

out=$(orch sync --no-serve 2>&1); rc=$?
expect_exit "sync --no-serve exits 0" 0 "$rc"
expect_match "sync completes" '^synced$' "$out"

# Foreground `serve` execs bun in place, so the shim's argv is recorded but the caller blocks.
log_before=$(wc -c < "$home/serve/log" | tr -d ' ')
( fake_orch serve >/dev/null 2>&1 ) &
serve_job=$!
sleep 2
expect_match "foreground serve recorded its argv" '^6724$' "$(cat "$home/serve/argv")"
expect_match "foreground serve does not append to the log" "^$log_before$" "$(wc -c < "$home/serve/log" | tr -d ' ')"
fake_orch serve --stop >/dev/null 2>&1
wait "$serve_job" 2>/dev/null || true

cleanup_dir "$shims"
cleanup_dir "$home"

# --- typescript gates ---------------------------------------------------------
# The server and dashboard are TypeScript; their own suites are the authority on them, so this
# file just makes sure a bash-only run cannot report green while they are broken.
if command -v bun >/dev/null 2>&1; then
  ( cd "$SCRIPT_DIR/.." && bun test >/dev/null 2>&1 ); rc=$?
  expect_exit "bun test is green" 0 "$rc"
  bash "$SCRIPT_DIR/typecheck.sh" >/dev/null 2>&1; rc=$?
  expect_exit "typecheck is clean" 0 "$rc"
else
  printf 'SKIP: bun test + typecheck (bun not found)\n' >&2
fi

printf '\n%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ] || exit 1
