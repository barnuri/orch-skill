#!/usr/bin/env bash
# check-api.sh [base-url] - service build, watchdog and run summary. Exit 1 on any FAIL.
set -u
base="${1:-http://127.0.0.1:6724}"; fail=0
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fail=1; }
b=$(curl -s -m 10 "$base/api/build") || { bad "service not reachable at $base"; exit 1; }
[ "$(jq -r .stale <<<"$b")" = false ] && ok "build stale:false (head $(jq -r '.head[0:7]' <<<"$b"))" || bad "build stale:true: $(jq -c '.reasons' <<<"$b")"
w=$(curl -s -m 10 "$base/api/watchdog")
[ "$(jq -r .state <<<"$w" 2>/dev/null)" = on ] && ok "watchdog on, last action: $(jq -r '.last_actions[0].action // "none"' <<<"$w")" || bad "watchdog not on: $w"
r=$(curl -s -m 10 "$base/api/runs") && ok "runs api answers ($(jq 'length' <<<"$r" 2>/dev/null || echo '?') runs)" || bad "runs api"
exit $fail
