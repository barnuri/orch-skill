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

# A full run takes one of the machine-wide heavy-test slots; a fragment run (`dispatch.test.sh record`) does not.
if [ $# -eq 0 ]; then
  . "$SCRIPT_DIR/../../../scripts/heavy-test-lock.sh"
  HEAVY_LOCK_CMD="dispatch.test.sh (full bash suite)" heavy_lock_acquire
fi
# One initialised home for the whole suite: each file copies it (test-home.sh seed_home) instead of
# paying the 2-4 s first-run migrations per temp home.
. "$SCRIPT_DIR/test-home.sh"
ORCH_TEST_HOME_TEMPLATE="$out_dir/home-template"
seed_home_template "$ORCH_TEST_HOME_TEMPLATE" || { printf 'could not build the template home\n' >&2; exit 1; }
export ORCH_TEST_HOME_TEMPLATE

# Longest first: the per-file seconds of the last full run (kept outside the repo) order this run, so
# with a job limit the slow files never start last. Files with no record go first (unknown = slow).
TIMINGS="${ORCH_TEST_TIMINGS:-${TMPDIR:-/tmp}/orch-bash-test-timings}"
ordered=()
while IFS= read -r line; do ordered+=("${line#* }"); done < <(
  for f in "${files[@]}"; do
    n=$(basename "$f" .test.sh)
    s=$(awk -v n="$n" '$1 == n {print $2}' "$TIMINGS" 2>/dev/null)
    printf '%s %s\n' "${s:-99999}" "$f"
  done | sort -rn
)
files=("${ordered[@]}")

# Job pool: at most JOBS files at once (0 = all at once); a finished file frees its slot at once.
pids=()
names=()
started=$SECONDS
running_count() {
  local p n=0
  # ${a[@]+...}: bash 3.2 (macOS) treats "${a[@]}" of an empty array as unbound under set -u, and
  # the first call runs before any job has started.
  for p in ${pids[@]+"${pids[@]}"}; do kill -0 "$p" 2>/dev/null && n=$((n + 1)); done
  printf '%s' "$n"
}
for f in "${files[@]}"; do
  name=$(basename "$f" .test.sh)
  if [ "$JOBS" -gt 0 ]; then
    while [ "$(running_count)" -ge "$JOBS" ]; do sleep 0.2; done
  fi
  names+=("$name")
  ( s=$SECONDS; bash "$f" > "$out_dir/$name.out" 2>&1 9>&-; rc=$?; printf '%s %s\n' "$rc" "$((SECONDS - s))" > "$out_dir/$name.rc" ) 9>&- &
  pids+=($!)
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
# Remember each file's seconds for the next run's longest-first order (only from a full run).
if [ $# -eq 0 ]; then
  for name in "${names[@]}"; do
    read -r _ secs < "$out_dir/$name.rc" 2>/dev/null && printf '%s %s\n' "$name" "$secs"
  done > "$TIMINGS.tmp.$$" && mv -f "$TIMINGS.tmp.$$" "$TIMINGS"
fi
trash "$out_dir" 2>/dev/null || true
[ "$bad" -eq 0 ] && [ "$total_fail" -eq 0 ] || exit 1
