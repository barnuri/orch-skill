#!/usr/bin/env bash
# Happy path for node tell / ask / inbox on a seeded run (the parity cases only cover errors).
# Runs the same sequence on a bash home and a Bun home, and diffs stdout, stderr and exit codes.
set -u
ORCH_SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ORCH_SKILL/tests/test-home.sh"
DISPATCH="$ORCH_SKILL/scripts/dispatch.sh"
BIN="$ORCH_SKILL/bin/orch"
BUN="${ORCH_BUN:-bun}"
export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0
work=$(mktemp -d "${TMPDIR:-/tmp}/orch-inbox-core.XXXXXX") || exit 1

mk() {
  seed_home "$1" || exit 1
  mkdir -p "$1/runs/r1"
  printf '{"id":"r1","status":"running","nodes":[{"id":"n1","status":"running"}]}\n' > "$1/runs/r1/state.json"
}

# seq <path-kind> <home> <out> : the sequence, one command per line.
seq_run() {
  local kind="$1" home="$2" out="$3"
  local cmds=(
    "node tell r1 n1 first --from orch"
    "node tell r1 n1 second"
    "node inbox r1 n1 --peek"
    "node inbox r1 n1 --json"
    "node inbox r1 n1"
    "node inbox r1 n1"
    "node inbox r1 n1 --ack m1"
    "node inbox r1 n1 --ack m9"
    "node ask r1 n1 question? --timeout 0 --wait"
  )
  local c rc
  : > "$out.err"
  for c in "${cmds[@]}"; do
    if [ "$kind" = bash ]; then
      env HARNESS_ORCH_HOME="$home" ORCH_BASH=1 bash "$DISPATCH" $c >>"$out" 2>>"$out.err"; rc=$?
    else
      env HARNESS_ORCH_HOME="$home" ORCH_DIRECT=1 "$BUN" "$BIN" $c >>"$out" 2>>"$out.err"; rc=$?
    fi
    printf 'exit %s\n' "$rc" >>"$out"
  done
}

mk "$work/a/home"; mk "$work/b/home"
seq_run bash "$work/a/home" "$work/a.out"
seq_run bun "$work/b/home" "$work/b.out"

fail=0
ts='s/[0-9]\{4\}-[0-9-]*T[0-9:]*Z/<TS>/g'
sed "$ts" "$work/a.out" > "$work/a.out.n"
sed "$ts" "$work/b.out" > "$work/b.out.n"
cmp -s "$work/a.out.n" "$work/b.out.n" || { fail=1; diff -u "$work/a.out.n" "$work/b.out.n" | head -40; }
sed "s#$work/a/home#<HOME>#g" "$work/a.out.err" > "$work/a.err.n"
sed "s#$work/b/home#<HOME>#g" "$work/b.out.err" > "$work/b.err.n"
cmp -s "$work/a.err.n" "$work/b.err.n" || { fail=1; diff -u "$work/a.err.n" "$work/b.err.n" | head -40; }
[ -f "$work/b/home/runs/r1/inbox/n1/1.json" ] || { fail=1; echo "no inbox/n1/1.json on the Bun side"; }
[ "$(jq -r .status "$work/b/home/runs/r1/inbox/n1/1.json" 2>/dev/null)" = delivered ] || { fail=1; echo "m1 not delivered after plain inbox"; }

if [ "$fail" = 0 ]; then
  printf 'inbox-core: bash and Bun match on a seeded run (%s commands)\n' 9
  exit 0
fi
printf 'inbox-core: FAIL\n'
exit 1
