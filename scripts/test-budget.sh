#!/usr/bin/env bash
# The TypeScript suite under a time budget, in chunks of test files (bun run test:budget / test:resume).
#
#   bash scripts/test-budget.sh [--budget SECS] [--chunk N]   run every src/**/*.test.ts(x), N files per
#                                                             `bun test` call (default 25)
#   bash scripts/test-budget.sh --resume                      run only the files that have not passed
#
# --budget SECS (default 300): no chunk starts after SECS; a running chunk gets 20 s more
# (ORCH_TEST_BUDGET_GRACE), then its process group is killed. Each file's result (passed, failed,
# not_run; a chunk's result applies to all its files) goes to ${TMPDIR}/orch-bun-test-progress.json
# (ORCH_BUN_TEST_PROGRESS). With files left the script prints `PARTIAL: N of M files, run again with
# --resume` and exits 75: run --resume until it exits 0 or 1. Never raise the budget instead.
# A run that has run every file clears the progress file.
# Seams for tests: ORCH_BUN_TEST_ROOT (folder to scan, default src), ORCH_BUN_TEST_CMD (command the
# file paths are appended to, default the `bun test` flags of `bun run test`).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
export ORCH_HERDR=0

budget=300
resume=0
chunk="${ORCH_BUN_TEST_CHUNK:-25}"
while [ $# -gt 0 ]; do
  case "$1" in
    --budget) budget="${2:-x}"; shift ;;
    --budget=*) budget="${1#*=}" ;;
    --chunk) chunk="${2:-x}"; shift ;;
    --chunk=*) chunk="${1#*=}" ;;
    --resume) resume=1 ;;
    -h|--help) sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'test-budget.sh: unknown argument %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
case "$budget" in ''|*[!0-9]*) printf 'test-budget.sh: --budget needs whole seconds\n' >&2; exit 2 ;; esac
case "$chunk" in ''|0|*[!0-9]*) printf 'test-budget.sh: --chunk needs a positive number\n' >&2; exit 2 ;; esac
GRACE="${ORCH_TEST_BUDGET_GRACE:-20}"
PROGRESS="${ORCH_BUN_TEST_PROGRESS:-${TMPDIR:-/tmp}/orch-bun-test-progress.json}"
PROGRESS="${PROGRESS//\/\//\/}"
TEST_ROOT="${ORCH_BUN_TEST_ROOT:-src}"
read -r -a CMD <<< "${ORCH_BUN_TEST_CMD:-bun test --timeout 300000 --parallel=6 --retry=1}"

files=()
prior_passed=()
if [ "$resume" -eq 1 ]; then
  [ -f "$PROGRESS" ] || { printf 'test-budget.sh: no partial run recorded in %s; run without --resume\n' "$PROGRESS" >&2; exit 2; }
  while read -r f st; do
    if [ "$st" = passed ]; then prior_passed+=("$f"); elif [ -f "$f" ]; then files+=("$f"); fi
  done < <(sed -nE 's/^ *"([^"]+)": "(passed|failed|not_run)",?$/\1 \2/p' "$PROGRESS")
else
  while IFS= read -r f; do files+=("./${f#./}"); done < <(
    find "$TEST_ROOT" \( -name node_modules -prune \) -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -type f -print | sort)
  [ ${#files[@]} -gt 0 ] || { printf 'test-budget.sh: no test files under %s\n' "$TEST_ROOT" >&2; exit 1; }
fi

. "$ROOT/scripts/heavy-test-lock.sh"
HEAVY_LOCK_CMD="scripts/test-budget.sh (bun suite)" heavy_lock_acquire

out=$(mktemp -d)
: > "$out/status"
for f in ${prior_passed[@]+"${prior_passed[@]}"}; do printf '%s passed\n' "$f" >> "$out/status"; done
deadline=$(( $(date +%s) + budget ))
kill_at=$(( deadline + GRACE ))
printf 'budget: %ss (+%ss grace), progress: %s\n' "$budget" "$GRACE" "$PROGRESS" >&2
started=$SECONDS
left=0
failed_chunks=0
i=0
n=${#files[@]}
while [ "$i" -lt "$n" ]; do
  part=("${files[@]:i:chunk}")
  i=$((i + chunk))
  if [ "$(date +%s)" -ge "$deadline" ]; then
    for f in "${part[@]}"; do printf '%s not_run\n' "$f" >> "$out/status"; done
    left=$((left + ${#part[@]}))
    continue
  fi
  # Own process group (setpgrp), so a kill at the budget takes bun's workers and servers with it.
  perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' "${CMD[@]}" "${part[@]}" > "$out/chunk.log" 2>&1 9>&- &
  pid=$!
  killed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$kill_at" ]; then
      kill -TERM -"$pid" 2>/dev/null; sleep 2; kill -KILL -"$pid" 2>/dev/null
      killed=1
      break
    fi
    sleep 0.5
  done
  wait "$pid" 2>/dev/null; rc=$?
  if [ "$killed" -eq 1 ]; then st=not_run; left=$((left + ${#part[@]}))
  elif [ "$rc" -eq 0 ]; then st=passed
  else
    st=failed; failed_chunks=$((failed_chunks + 1))
    printf '=== bun chunk FAILED (exit %s): %s\n' "$rc" "${part[*]}"
    tail -60 "$out/chunk.log"
  fi
  for f in "${part[@]}"; do printf '%s %s\n' "$f" "$st" >> "$out/status"; done
  grep -hE '^ *[0-9]+ (pass|fail)$' "$out/chunk.log" | tr -s ' \n' ' ' >&2
  printf '(%s files: %s)\n' "${#part[@]}" "$st" >&2
done

total=$(wc -l < "$out/status" | tr -d ' ')
passed=$(grep -c ' passed$' "$out/status")
failed=$(grep -c ' failed$' "$out/status")
printf '\nbun: %s passed, %s failed, %s not run of %s files (%ss wall)\n' "$passed" "$failed" "$left" "$total" "$((SECONDS - started))"
if [ "$left" -gt 0 ]; then
  {
    printf '{"mode": "bun",\n "files": {\n'
    awk '{ printf "%s  \"%s\": \"%s\"", (NR > 1 ? ",\n" : ""), $1, $2 } END { printf "\n" }' "$out/status"
    printf ' }}\n'
  } > "$PROGRESS.tmp.$$" && mv -f "$PROGRESS.tmp.$$" "$PROGRESS"
  printf 'PARTIAL: %s of %s files, run again with --resume\n' "$((total - left))" "$total"
  trash "$out" 2>/dev/null || true
  exit 75
fi
[ -f "$PROGRESS" ] && { trash "$PROGRESS" 2>/dev/null || mv -f "$PROGRESS" "$PROGRESS.cleared"; }
trash "$out" 2>/dev/null || true
[ "$failed" -eq 0 ] || exit 1
