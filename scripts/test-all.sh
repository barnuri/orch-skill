#!/usr/bin/env bash
# The full gate: bash suite, TypeScript suite and typecheck, run concurrently. Exits non-zero if any fails.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
# One machine-wide heavy-test slot covers all four jobs below (they see ORCH_TEST_LOCK_HELD and do not ask again).
. "$ROOT/scripts/heavy-test-lock.sh"
HEAVY_LOCK_CMD="test-all.sh (full gate)" heavy_lock_acquire
out=$(mktemp -d)
bash skills/orch/tests/run.sh --full > "$out/bash.log" 2>&1 9>&- & p1=$!
ORCH_HERDR=0 bun test --timeout 300000 --parallel=6 --retry=1 --timings="${TMPDIR:-/tmp}/orch-bun-test-timings.json" --update-timings src > "$out/bun.log" 2>&1 9>&- & p2=$!
bash scripts/typecheck.sh > "$out/types.log" 2>&1 9>&- & p3=$!
bash scripts/lint-optional.sh > "$out/lint.log" 2>&1 9>&- & p4=$!
rc=0
wait $p1 || { rc=1; printf '== bash suite FAILED\n'; tail -40 "$out/bash.log"; }
wait $p2 || { rc=1; printf '== bun test FAILED\n'; tail -40 "$out/bun.log"; }
wait $p3 || { rc=1; printf '== typecheck FAILED\n'; tail -20 "$out/types.log"; }
wait $p4 || { rc=1; printf '== lint FAILED (real errors)\n'; tail -30 "$out/lint.log"; }
cat "$out/lint.log"
tail -1 "$out/bash.log"; grep -E "^ *[0-9]+ (pass|fail)$" "$out/bun.log" | tr '\n' ' '; echo; tail -1 "$out/types.log"
trash "$out" 2>/dev/null || true
exit $rc
