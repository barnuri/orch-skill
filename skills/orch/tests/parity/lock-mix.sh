#!/usr/bin/env bash
# Lock parity (P6): 20 concurrent node add writers on one run, alternating the bash path and the Bun
# path. Pass when every node lands (no lost update) and state.json stays valid JSON.
#   bash skills/orch/tests/parity/lock-mix.sh
set -u

PARITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_SKILL="$(cd "$PARITY_DIR/../.." && pwd)"
DISPATCH="$ORCH_SKILL/scripts/dispatch.sh"
BIN="$ORCH_SKILL/bin/orch"
BUN="${ORCH_BUN:-bun}"

# shellcheck source=../test-home.sh
. "$ORCH_SKILL/tests/test-home.sh"

export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0 ORCH_OWNER_FILL=0
work=$(mktemp -d "${TMPDIR:-/tmp}/orch-lockmix.XXXXXX") || exit 1
home="$work/home"
seed_home "$home" || { printf 'lock-mix: seed failed\n' >&2; exit 1; }
run=lk-run
HARNESS_ORCH_HOME="$home" ORCH_BASH=1 bash "$DISPATCH" run start "lock-mix" --id "$run" >/dev/null 2>&1 \
  || { printf 'lock-mix: run start failed\n' >&2; exit 1; }

N=20
pids=()
for i in $(seq 1 "$N"); do
  id="lk$i"
  if [ $((i % 2)) -eq 1 ]; then
    HARNESS_ORCH_HOME="$home" ORCH_BASH=1 bash "$DISPATCH" node add "$run" "$id" "lock $i" >"$work/out.$i" 2>&1 &
  else
    HARNESS_ORCH_HOME="$home" ORCH_DIRECT=1 "$BUN" "$BIN" node add "$run" "$id" "lock $i" >"$work/out.$i" 2>&1 &
  fi
  pids+=($!)
done
rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done

state="$home/runs/$run/state.json"
if ! "$BUN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$state" 2>/dev/null; then
  printf 'lock-mix: FAIL state.json is not valid JSON\n'; exit 1
fi
got=$("$BUN" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.nodes.filter(n=>/^lk\d+$/.test(n.id)).length)' "$state")
if [ "$got" != "$N" ] || [ "$rc" != 0 ]; then
  printf 'lock-mix: FAIL %s of %s nodes landed, writer exit rc=%s\n' "$got" "$N" "$rc"
  printf 'kept: %s\n' "$work"; exit 1
fi
printf 'lock-mix: ok, %s of %s nodes landed, state.json valid\n' "$got" "$N"
if command -v trash >/dev/null 2>&1; then trash "$work" >/dev/null 2>&1; fi
exit 0
