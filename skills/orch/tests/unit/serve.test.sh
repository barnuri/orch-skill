#!/usr/bin/env bash
# Fast-tier unit tests for lib/dashboard/serve.sh: serve.json config, option parsing, auth flags and
# the pid-marker readers, called in-process. No server, bun or curl is started.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch
unset ORCH_REQUIRE_TOKEN ORCH_ALLOW_REMOTE

expect_match "config get reads the seeded port" '^6724$' "$(cmd_serve_config get port)"
out=$(cmd_serve_config set --host 127.0.0.1 --port 7000 --require-token)
expect_match "config set writes the given keys" '^127.0.0.1 7000 true false$' \
  "$(jq -r '"\(.host) \(.port) \(.require_token) \(.allow_remote)"' "$SERVE_CONFIG_FILE")"
out=$(cmd_serve_config set --no-require-token --allow-remote)
expect_match "config set keeps the keys it was not given" '^127.0.0.1 7000 false true$' \
  "$(jq -r '"\(.host) \(.port) \(.require_token) \(.allow_remote)"' "$SERVE_CONFIG_FILE")"
for bad in '--port 70000' '--port abc' '--bogus'; do
  # shellcheck disable=SC2086
  out=$(cmd_serve_config set $bad 2>&1); rc=$?
  expect_exit "config set $bad is refused" 2 "$rc"
done
expect_match "  ... and leaves the file as it was" '^7000$' "$(jq -r .port "$SERVE_CONFIG_FILE")"
out=$(cmd_serve_config get 2>&1); rc=$?
expect_exit "config get without a key is a usage error" 2 "$rc"

out=$(parse_serve_opts ui --host x 2>&1); rc=$?
expect_exit "ui takes no --host" 2 "$rc"
parse_serve_opts serve --host 10.0.0.1 --port 8080; rc=$?
expect_match "serve --host/--port override serve.json" '^0 10.0.0.1 8080 0$' "$rc $SERVE_HOST $SERVE_PORT $SERVE_STOP"

expect_match "auth argv follows serve.json" '^--allow-remote$' "$(serve_auth_argv)"
expect_match "ORCH_REQUIRE_TOKEN adds --require-token" '^--require-token --allow-remote$' "$(ORCH_REQUIRE_TOKEN=1 serve_auth_argv)"

mkdir -p "$SERVE_HOME"
printf '7123' > "$SERVE_PORT_FILE"
printf 'tok' > "$SERVE_TOKEN_FILE"
expect_match "url has no token when none is required" '^http://127.0.0.1:7123/$' "$(serve_url)"
expect_match "url carries the token when one is required" '^http://127.0.0.1:7123/\?token=tok$' "$(ORCH_REQUIRE_TOKEN=1 serve_url)"

true & dead=$!
wait "$dead"
printf '%s' "$dead" > "$SERVE_PID_FILE"
serve_running; rc=$?
expect_exit "a dead pid marker reads as not running" 1 "$rc"
expect_file "  ... and the marker is kept" "$SERVE_PID_FILE"
expect_empty "  ... but truncated" "$(cat "$SERVE_PID_FILE")"
serve_sources_changed; rc=$?
expect_exit "an empty pid marker never reads as stale sources" 1 "$rc"
expect_match "stop when nothing runs says so" '^serve: not running$' "$(serve_stop)"

out=$(ORCH_BUN=/nonexistent/bun serve_diagnose 2>&1); rc=$?
expect_exit "diagnose without bun returns 2" 2 "$rc"
expect_match "  ... with reason bun_missing" '^bun_missing$' "$(serve_diag_field "$out" reason)"
expect_match "diag_field picks one key" '^42$' "$(serve_diag_field "$(printf 'reason=x\npid=42\n')" pid)"

cleanup_dir "$(dirname "$H")"
finish
