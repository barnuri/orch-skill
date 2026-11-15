#!/usr/bin/env bash
# Shared helpers for the *.test.sh files in this directory — sourced, never executed.
# Each test file sources this, runs its sections, then calls `finish`.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
. "$SCRIPT_DIR/test-home.sh"

export ORCH_NO_ANNOUNCE=1
# Never let a test start the orch skill's herdr instance; herdr-runner.test.sh opts back in.
export ORCH_HERDR=0

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

# wait_until "<shell condition>" [seconds]: polls twice a second until the condition holds, so a
# test waits as long as a loaded machine needs instead of a fixed sleep that is right only when idle.
wait_until() {
  local cond="$1" limit="${2:-60}" waited=0
  while ! eval "$cond" >/dev/null 2>&1; do
    [ "$waited" -lt $((limit * 2)) ] || return 1
    sleep 0.5
    waited=$((waited + 1))
  done
}

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

# Loopback HTTP fixture shared by several files (start_fixture / stop_fixture).
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

# Prints the per-file tally the runner (dispatch.test.sh) parses, and exits non-zero on a failure.
finish() {
  printf '\n%s passed, %s failed\n' "$pass_count" "$failures"
  [ "$failures" -eq 0 ] || exit 1
  exit 0
}
