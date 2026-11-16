#!/usr/bin/env bash
# dispatch.sh tests: serve and ui
# Run: bash serve-ui.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

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

# The "sources changed" check compares src/ mtimes to the pid marker. Against the live checkout, any
# edit under src/ during the run (another session, a build) turns a healthy fake server "stale", so
# the tests watch a private fixture dir whose file predates every marker the shim writes.
srcfix=$(new_tmp)
printf 'x\n' > "$srcfix/main.ts"
touch -t 201001010000 "$srcfix/main.ts"
export ORCH_SERVE_SOURCE_DIRS="$srcfix"
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
fake_orch() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" ORCH_BUN="$shims/bun" ORCH_NO_OPEN=1 \
  bash "$SCRIPT" "$@"; }
# Same shims, but with the opt-back-in to token auth on loopback.
fake_orch_token() { env HARNESS_ORCH_HOME="$home" PATH="$shims:$PATH" ORCH_BUN="$shims/bun" \
  ORCH_NO_OPEN=1 ORCH_REQUIRE_TOKEN=1 bash "$SCRIPT" "$@"; }
seed_home "$home"
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
expect_match "argv passes the harness enum" '^claude cursor-agent opencode local-llm copilot pi$' "$argv"
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


finish
