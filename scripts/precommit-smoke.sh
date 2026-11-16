#!/usr/bin/env bash
# Fast gate before a node reports done or a commit: syntax of every orch shell script, the CLI
# loading its libs on a temp home, and the TypeScript typecheck. Target: under 20 s.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail=0

bad=0
while IFS= read -r f; do
  bash -n "$f" || { printf 'precommit-smoke: syntax error in %s\n' "$f" >&2; bad=$((bad + 1)); }
done <<EOF
$(find "$ROOT/skills/orch/scripts" -name '*.sh' -type f | sort)
EOF
if [ "$bad" -eq 0 ]; then printf 'bash -n: ok\n'; else fail=1; fi

home=$(mktemp -d "${TMPDIR:-/tmp}/orch-precommit.XXXXXX")
if out=$(HARNESS_ORCH_HOME="$home" bash "$ROOT/skills/orch/scripts/dispatch.sh" run status precommit-smoke-none 2>&1); then
  printf 'dispatch.sh run status: ok\n'
elif [ "$?" -eq 2 ] && printf '%s' "$out" | grep -q 'unknown run'; then
  # The CLI loaded its libs and refused the unknown run cleanly (exit 2). Any other failure is a broken load.
  printf 'dispatch.sh run status: ok (libs load, unknown run refused)\n'
else
  printf 'precommit-smoke: dispatch.sh run status failed:\n%s\n' "$out" | sed 's/^/  /' >&2
  fail=1
fi
trash "$home" 2>/dev/null || mv "$home" "${home}.trash" 2>/dev/null || true

if bash "$ROOT/scripts/typecheck.sh"; then :; else fail=1; fi

[ "$fail" -eq 0 ] && printf 'precommit-smoke: ok\n' || printf 'precommit-smoke: FAILED\n' >&2
exit "$fail"
