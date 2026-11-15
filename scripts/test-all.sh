#!/usr/bin/env bash
# The full gate: bash suite, TypeScript suite and typecheck, run concurrently. Exits non-zero if any fails.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
out=$(mktemp -d)
bash skills/orch/scripts/dispatch.test.sh > "$out/bash.log" 2>&1 & p1=$!
ORCH_HERDR=0 bun test --timeout 300000 --parallel=6 src > "$out/bun.log" 2>&1 & p2=$!
bash scripts/typecheck.sh > "$out/types.log" 2>&1 & p3=$!
rc=0
wait $p1 || { rc=1; printf '== bash suite FAILED\n'; tail -40 "$out/bash.log"; }
wait $p2 || { rc=1; printf '== bun test FAILED\n'; tail -40 "$out/bun.log"; }
wait $p3 || { rc=1; printf '== typecheck FAILED\n'; tail -20 "$out/types.log"; }
tail -1 "$out/bash.log"; grep -E "^ *[0-9]+ (pass|fail)$" "$out/bun.log" | tr '\n' ' '; echo; tail -1 "$out/types.log"
trash "$out" 2>/dev/null || true
exit $rc
