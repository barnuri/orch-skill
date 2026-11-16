#!/usr/bin/env bash
# bench.sh <dispatch args...>: median wall time of 10 runs of `dispatch.sh <args>` on the bash path
# (ORCH_BASH=1), on a seeded home with one run "bench-run" of 30 nodes. Every node is held, so
# `run sync` starts nothing. Then one traced run prints the external-command count (ORCH_TRACE_SPAWN=1).
#   BENCH_STDIN=<file>   fed to stdin of every run (e.g. the ops file for `node batch bench-run`)
#   BENCH_RUNS=N         timed runs (default 10)
# Example: bash tests/parity/bench.sh run status bench-run
set -u

PARITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_SKILL="$(cd "$PARITY_DIR/../.." && pwd)"
DISPATCH="$ORCH_SKILL/scripts/dispatch.sh"
RUNS="${BENCH_RUNS:-10}"
[ $# -gt 0 ] || { printf 'usage: bench.sh <dispatch args...>\n' >&2; exit 2; }

. "$ORCH_SKILL/tests/test-home.sh"
export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0

work=$(mktemp -d "${TMPDIR:-/tmp}/orch-bench.XXXXXX") || exit 1
home="$work/home"
seed_home "$home" || exit 1
export HARNESS_ORCH_HOME="$home" ORCH_BASH=1

# Fixture: run bench-run with 30 nodes, each held (not ready), in one batch process.
bash "$DISPATCH" run start "bench" --id bench-run >/dev/null 2>&1 || { printf 'bench: run start failed\n' >&2; exit 1; }
fixture="$work/fixture.jsonl"
for i in $(seq 1 30); do
  printf '{"op":"add","id":"n%s","goal":"bench node %s"}\n' "$i" "$i"
done >"$fixture"
for i in $(seq 1 30); do
  printf '{"op":"update","id":"n%s","hold":"bench"}\n' "$i"
done >>"$fixture"
bash "$DISPATCH" node batch bench-run --file "$fixture" >/dev/null 2>&1 || { printf 'bench: fixture batch failed\n' >&2; exit 1; }

run_once() {
  if [ -n "${BENCH_STDIN:-}" ]; then
    bash "$DISPATCH" "$@" <"$BENCH_STDIN"
  else
    bash "$DISPATCH" "$@" </dev/null
  fi
}

times=()
for _ in $(seq 1 "$RUNS"); do
  t=$( { TIMEFORMAT='%3R'; time run_once "$@" >/dev/null 2>&1; } 2>&1 )
  times+=("$t")
done
median=$(printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END{ if (NR%2) print a[(NR+1)/2]; else printf "%.3f\n", (a[NR/2]+a[NR/2+1])/2 }')

trace="$work/spawn-trace"
: >"$trace"
ORCH_TRACE_SPAWN=1 ORCH_TRACE_SPAWN_FILE="$trace" run_once "$@" >/dev/null 2>&1
spawns=$(wc -l <"$trace" | tr -d ' ')

printf 'bench: dispatch.sh %s\n' "$*"
printf '  median %ss of %s runs, spawns %s (external commands, lower bound)\n' "$median" "$RUNS" "$spawns"
trash "$work" 2>/dev/null || mv "$work" "${TMPDIR:-/tmp}/orch-bench-trash-$$" 2>/dev/null
