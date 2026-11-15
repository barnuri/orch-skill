#!/usr/bin/env bash
# Machine-wide limit on heavy test runs (the full bash suite, the full bun suite, test-all.sh).
# Several agents ran full suites at once at load 17-50, and each run slowed every other one.
#
#   bash scripts/heavy-test-lock.sh run -- <command...>   take a slot, run the command, free the slot
#   . scripts/heavy-test-lock.sh; heavy_lock_acquire       take a slot for the rest of this shell
#
# Slots are files ${TMPDIR}/orch-test-heavy.<N> (N = 1..ORCH_TEST_SLOTS, default 2) locked with
# flock(2) through perl, on fd 9 of the holding shell. The kernel drops the lock when that shell
# exits, so a dead holder never keeps a slot (no stale-pid cleanup to get wrong). Children run with
# fd 9 closed, so a leaked background process cannot hold a slot. ORCH_TEST_LOCK=0 skips the lock
# (for nested calls: test-all.sh holds one slot for all its suites).

HEAVY_LOCK_DIR="${TMPDIR:-/tmp}"
HEAVY_LOCK_DIR="${HEAVY_LOCK_DIR%/}"

heavy_lock_try() {
  perl -e 'use Fcntl ":flock"; open(my $f, ">&=", 9) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)'
}

heavy_lock_acquire() {
  [ "${ORCH_TEST_LOCK:-1}" = 0 ] && return 0
  [ -n "${ORCH_TEST_LOCK_HELD:-}" ] && return 0
  local slots="${ORCH_TEST_SLOTS:-2}" n f said=0 who
  while :; do
    for n in $(seq 1 "$slots"); do
      f="$HEAVY_LOCK_DIR/orch-test-heavy.$n"
      exec 9>>"$f" || continue
      if heavy_lock_try; then
        printf '%s %s\n' "$$" "${HEAVY_LOCK_CMD:-$0 $*}" > "$f"
        export ORCH_TEST_LOCK_HELD="$f"
        return 0
      fi
      exec 9>&-
    done
    if [ "$said" -eq 0 ]; then
      who=""
      for n in $(seq 1 "$slots"); do
        who="$who; held by pid $(cut -d' ' -f1 "$HEAVY_LOCK_DIR/orch-test-heavy.$n" 2>/dev/null): $(cut -d' ' -f2- "$HEAVY_LOCK_DIR/orch-test-heavy.$n" 2>/dev/null)"
      done
      printf 'waiting for a heavy-test slot (%s busy%s)\n' "$slots" "$who" >&2
      said=1
    fi
    sleep 2
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "${1:-}" = run ] && shift
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || { printf 'usage: heavy-test-lock.sh run -- <command...>\n' >&2; exit 2; }
  HEAVY_LOCK_CMD="$*" heavy_lock_acquire
  "$@" 9>&-
fi
