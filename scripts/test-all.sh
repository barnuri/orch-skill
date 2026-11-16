#!/usr/bin/env bash
# The full gate: bash suite, TypeScript suite, typecheck and lint, run concurrently.
#
#   bash scripts/test-all.sh            run all four; both suites run under their 300 s budget
#   bash scripts/test-all.sh --resume   rerun only the suites that stopped at their budget, with --resume
#
# Exit 0 = all passed, 1 = a failure, 75 = a suite stopped at its budget: it prints
# `PARTIAL: ... run again with --resume`; run --resume until it exits 0 or 1. Never raise the budget.
# The suite results between runs live in ${TMPDIR}/orch-test-all-progress (ORCH_TEST_ALL_PROGRESS).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
resume=0
case "${1:-}" in
  --resume) resume=1 ;;
  '') ;;
  *) printf 'test-all.sh: unknown argument %s (see the header)\n' "$1" >&2; exit 2 ;;
esac
STATE="${ORCH_TEST_ALL_PROGRESS:-${TMPDIR:-/tmp}/orch-test-all-progress}"
STATE="${STATE//\/\//\/}"
if [ "$resume" -eq 1 ] && [ ! -f "$STATE" ]; then
  printf 'test-all.sh: no partial run recorded in %s; run without --resume\n' "$STATE" >&2
  exit 2
fi
prev() { awk -v k="$1" '$1 == k { print $2 }' "$STATE" 2>/dev/null; }
# One machine-wide heavy-test slot covers every job below (they see ORCH_TEST_LOCK_HELD and do not ask again).
. "$ROOT/scripts/heavy-test-lock.sh"
HEAVY_LOCK_CMD="test-all.sh (full gate)" heavy_lock_acquire
out=$(mktemp -d)
p1="" p2="" p3="" p4=""
if [ "$resume" -eq 0 ]; then
  bash skills/orch/tests/run.sh --full > "$out/bash.log" 2>&1 9>&- & p1=$!
  bash scripts/test-budget.sh > "$out/bun.log" 2>&1 9>&- & p2=$!
  bash scripts/typecheck.sh > "$out/types.log" 2>&1 9>&- & p3=$!
  bash scripts/lint-optional.sh > "$out/lint.log" 2>&1 9>&- & p4=$!
else
  [ "$(prev bash)" = 75 ] && { bash skills/orch/tests/run.sh --resume > "$out/bash.log" 2>&1 9>&- & p1=$!; }
  [ "$(prev bun)" = 75 ] && { bash scripts/test-budget.sh --resume > "$out/bun.log" 2>&1 9>&- & p2=$!; }
fi
# A suite not rerun on --resume keeps its earlier result. `wait` runs in this shell: a $(...) subshell
# cannot wait for this shell's jobs.
r1="" r2="" r3="" r4=""
if [ -n "$p1" ]; then wait "$p1"; r1=$?; else r1=$(prev bash); fi
if [ -n "$p2" ]; then wait "$p2"; r2=$?; else r2=$(prev bun); fi
if [ -n "$p3" ]; then wait "$p3"; r3=$?; else r3=$(prev types); fi
if [ -n "$p4" ]; then wait "$p4"; r4=$?; else r4=$(prev lint); fi
report() { # report <name> <rc> <log> <lines> <label>
  [ -f "$3" ] || return 0
  case "$2" in
    0) ;;
    75) printf '== %s stopped at its budget\n' "$5"; grep -E '^PARTIAL:' "$3" ;;
    *) printf '== %s FAILED\n' "$5"; tail -"$4" "$3" ;;
  esac
}
report bash "${r1:-0}" "$out/bash.log" 40 "bash suite"
report bun "${r2:-0}" "$out/bun.log" 40 "bun test"
report types "${r3:-0}" "$out/types.log" 20 "typecheck"
report lint "${r4:-0}" "$out/lint.log" 30 "lint (real errors)"
[ -f "$out/lint.log" ] && cat "$out/lint.log"
for f in bash bun; do [ -f "$out/$f.log" ] && grep -vE '^PARTIAL:' "$out/$f.log" | grep -E 'passed, [0-9]+ failed|^bun: ' | tail -1; done
[ -f "$out/types.log" ] && tail -1 "$out/types.log"
trash "$out" 2>/dev/null || true

rc=0
partial=""
for pair in "bash ${r1:-0}" "bun ${r2:-0}" "types ${r3:-0}" "lint ${r4:-0}"; do
  set -- $pair
  if [ "$2" = 75 ]; then partial="$partial $1"; elif [ "$2" != 0 ]; then rc=1; fi
done
if [ -n "$partial" ]; then
  printf 'bash %s\nbun %s\ntypes %s\nlint %s\n' "${r1:-0}" "${r2:-0}" "${r3:-0}" "${r4:-0}" > "$STATE"
  printf 'PARTIAL: suites left:%s, run again with --resume\n' "$partial"
  exit 75
fi
[ -f "$STATE" ] && { trash "$STATE" 2>/dev/null || mv -f "$STATE" "$STATE.cleared"; }
exit $rc
