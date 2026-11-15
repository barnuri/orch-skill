#!/usr/bin/env bash
# Runner for the bash suite: every *.test.sh in this directory runs as its own background job (each
# test file builds its own temp homes, so they do not share state) and the tallies are merged. The
# work is dominated by process start latency, not CPU, so running all files at once is the fast path.
#
# Run:  bash dispatch.test.sh            all files in parallel
#       bash dispatch.test.sh record     only files whose name contains "record"
#       ORCH_TEST_JOBS=1 bash dispatch.test.sh   serial (clearer output when debugging)
# The TypeScript suite and the typecheck are separate: scripts/test-all.sh runs everything.

set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$(basename "${BASH_SOURCE[0]}")"
JOBS="${ORCH_TEST_JOBS:-0}"
out_dir=$(mktemp -d)

files=()
for f in "$SCRIPT_DIR"/*.test.sh; do
  name=$(basename "$f")
  [ "$name" = "$SELF" ] && continue
  if [ $# -gt 0 ]; then
    keep=0
    for pat in "$@"; do case "$name" in *"$pat"*) keep=1 ;; esac; done
    [ "$keep" -eq 1 ] || continue
  fi
  files+=("$f")
done
[ ${#files[@]} -gt 0 ] || { printf 'no test files match\n' >&2; exit 1; }

pids=()
names=()
running=0
started=$SECONDS
for f in "${files[@]}"; do
  name=$(basename "$f" .test.sh)
  names+=("$name")
  ( s=$SECONDS; bash "$f" > "$out_dir/$name.out" 2>&1; rc=$?; printf '%s %s\n' "$rc" "$((SECONDS - s))" > "$out_dir/$name.rc" ) &
  pids+=($!)
  running=$((running + 1))
  if [ "$JOBS" -gt 0 ] && [ "$running" -ge "$JOBS" ]; then
    wait "${pids[$((${#pids[@]} - 1))]}" 2>/dev/null
    for p in "${pids[@]}"; do wait "$p" 2>/dev/null; done
    running=0
  fi
done
for p in "${pids[@]}"; do wait "$p" 2>/dev/null; done

total_pass=0
total_fail=0
bad=0
for name in "${names[@]}"; do
  read -r rc secs < "$out_dir/$name.rc" 2>/dev/null || { rc=1; secs=0; }
  tally=$(grep -oE '[0-9]+ passed, [0-9]+ failed$' "$out_dir/$name.out" | tail -1)
  p=$(printf '%s' "$tally" | awk '{print $1}')
  fl=$(printf '%s' "$tally" | awk '{print $3}')
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${fl:-0}))
  if [ "$rc" -ne 0 ] || [ -z "$tally" ]; then
    bad=1
    printf '=== %s FAILED (exit %s) ===\n' "$name" "$rc"
    cat "$out_dir/$name.out"
  fi
  printf '%-24s %4s passed, %s failed  (%ss)\n' "$name" "${p:-0}" "${fl:-?}" "$secs" >&2
done

printf '\n%s passed, %s failed (%ss wall)\n' "$total_pass" "$total_fail" "$((SECONDS - started))"
trash "$out_dir" 2>/dev/null || true
[ "$bad" -eq 0 ] && [ "$total_fail" -eq 0 ] || exit 1
