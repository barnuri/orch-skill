#!/usr/bin/env bash
# Parity runner. Runs self-test.sh and every cases/*.cases file through parity.sh, one file at a time.
#   bash skills/orch/tests/parity/run.sh [fragment...]   only files whose name contains a fragment
#   --budget SECS   stop starting files after SECS (default 300); unfinished files are listed
# Each file is capped at 60 s (ORCH_PARITY_FILE_CAP). A file over its cap counts as TIMEOUT (a failure).
set -u

PARITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAP="${ORCH_PARITY_FILE_CAP:-60}"
budget=300
frags=()
while [ $# -gt 0 ]; do
  case "$1" in
    --budget) budget="${2:-}"; shift ;;
    --budget=*) budget="${1#*=}" ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'run.sh: unknown option %s\n' "$1" >&2; exit 2 ;;
    *) frags+=("$1") ;;
  esac
  shift
done
case "$budget" in ''|*[!0-9]*) printf 'run.sh: --budget needs whole seconds\n' >&2; exit 2 ;; esac

TMO=""
command -v timeout >/dev/null 2>&1 && TMO="timeout"
command -v gtimeout >/dev/null 2>&1 && TMO="gtimeout"

items=("$PARITY_DIR/self-test.sh")
for f in "$PARITY_DIR"/cases/*.cases; do [ -f "$f" ] && items+=("$f"); done

start=$(date +%s)
ran=0; failed=0; left=()
for item in "${items[@]}"; do
  name="$(basename "$item")"
  if [ ${#frags[@]} -gt 0 ]; then
    hit=0
    for g in "${frags[@]}"; do case "$name" in *"$g"*) hit=1 ;; esac; done
    [ "$hit" = 1 ] || continue
  fi
  if [ $(( $(date +%s) - start )) -ge "$budget" ]; then left+=("$name"); continue; fi
  ran=$((ran + 1))
  case "$item" in
    *.cases) runner=("$PARITY_DIR/parity.sh" "$item") ;;
    *) runner=("$item") ;;
  esac
  if [ -n "$TMO" ]; then
    "$TMO" "$CAP" bash "${runner[@]}" 2>&1; rc=$?
  else
    bash "${runner[@]}" 2>&1; rc=$?
  fi
  if [ "$rc" -eq 124 ]; then
    printf 'TIMEOUT %s (cap %ss)\n' "$name" "$CAP"
  fi
  [ "$rc" -eq 0 ] || failed=$((failed + 1))
done

printf 'parity run: %s files, %s failed, %ss elapsed\n' "$ran" "$failed" "$(( $(date +%s) - start ))"
if [ ${#left[@]} -gt 0 ]; then
  printf 'budget reached, not run: %s\n' "${left[*]}"
  exit 3
fi
[ "$failed" -eq 0 ]
