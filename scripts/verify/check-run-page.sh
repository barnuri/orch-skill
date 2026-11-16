#!/usr/bin/env bash
# check-run-page.sh <run-id> [text ...] - open the run page headless, require every text, save a screenshot.
set -u
run="${1:?run id}"; shift
base="${ORCH_URL:-http://127.0.0.1:6724}"; s=verify; out="${TMPDIR:-/tmp}/verify-run-$run.png"; fail=0
playwright-cli -s=$s open "$base/#/run/$run" >/dev/null 2>&1 || { echo "FAIL cannot open $base"; exit 1; }
sleep 4
text=$(playwright-cli -s=$s eval "() => document.body.innerText" 2>/dev/null)
[ -n "$text" ] && echo "PASS page rendered (${#text} chars)" || { echo "FAIL empty page"; fail=1; }
for t in "$@"; do grep -qF -- "$t" <<<"$text" && echo "PASS text: $t" || { echo "FAIL missing text: $t"; fail=1; }; done
playwright-cli -s=$s screenshot --filename="$out" >/dev/null 2>&1 && echo "shot $out"
playwright-cli -s=$s close >/dev/null 2>&1
exit $fail
