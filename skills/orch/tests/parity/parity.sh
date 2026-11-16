#!/usr/bin/env bash
# parity.sh <case-file>: runs each command line of the case file on two fresh homes, the bash path
# (ORCH_BASH=1 dispatch.sh) and the Bun path (ORCH_DIRECT=1 bin/orch), and diffs stdout, stderr,
# exit code and the normalized home tree (normalize.ts). Exit 1 on any difference.
# Case lines are shell words, the arguments after the command name. Blank lines and # comments skip.
# ORCH_PARITY_MUTATE_B=<sed expr>: test hook. Applies the sed expression to the Bun-side stdout, so
# the self-test can prove that a different output fails.
set -u

PARITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_SKILL="$(cd "$PARITY_DIR/../.." && pwd)"
DISPATCH="$ORCH_SKILL/scripts/dispatch.sh"
BIN="$ORCH_SKILL/bin/orch"
BUN="${ORCH_BUN:-bun}"

case_file="${1:-}"
[ -n "$case_file" ] && [ -f "$case_file" ] || { printf 'usage: parity.sh <case-file>\n' >&2; exit 2; }

# shellcheck source=../test-home.sh
. "$ORCH_SKILL/tests/test-home.sh"

export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0 ORCH_OWNER_FILL=0
export ORCH_PARITY_FIXTURES="$PARITY_DIR/fixtures"
work=$(mktemp -d "${TMPDIR:-/tmp}/orch-parity.XXXXXX") || exit 1
work=$(cd "$work" && pwd -P) || exit 1

# Fixture: `# fixture: <run-id> <ops-file>` (ops file under fixtures/) builds that run once on the bash
# path. Each case copies the run's runs/ tree into both homes before its command runs.
fx=$(sed -n 's/^# fixture: //p' "$case_file" | head -1)
fx_home="$work/fixture/home"
if [ -n "$fx" ]; then
  read -r fx_run fx_ops <<<"$fx"
  seed_home "$fx_home" || { printf 'parity: seed failed for fixture\n' >&2; exit 1; }
  env HARNESS_ORCH_HOME="$fx_home" ORCH_BASH=1 bash "$DISPATCH" run start "fixture" --id "$fx_run" >/dev/null 2>&1 \
    && env HARNESS_ORCH_HOME="$fx_home" ORCH_BASH=1 bash "$DISPATCH" node batch "$fx_run" --file "$ORCH_PARITY_FIXTURES/$fx_ops" >/dev/null 2>&1 \
    || { printf 'parity: fixture build failed (%s)\n' "$fx" >&2; exit 1; }
fi

total=0
fails=0
n=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|' '*|'#'*) continue ;; esac
  n=$((n + 1))
  total=$((total + 1))
  case_dir="$work/case-$n"
  homeA="$case_dir/a/home"
  homeB="$case_dir/b/home"
  seed_home "$homeA" || { printf 'parity: seed failed for %s\n' "$homeA" >&2; exit 1; }
  seed_home "$homeB" || { printf 'parity: seed failed for %s\n' "$homeB" >&2; exit 1; }
  mkdir -p "$case_dir/a" "$case_dir/b"
  if [ -n "$fx" ]; then
    cp -R "$fx_home/runs" "$homeA/" && cp -R "$fx_home/runs" "$homeB/" || { printf 'parity: fixture copy failed\n' >&2; exit 1; }
  fi

  env HARNESS_ORCH_HOME="$homeA" ORCH_BASH=1 bash -c "bash \"$DISPATCH\" $line" \
    >"$case_dir/a/out" 2>"$case_dir/a/err"; rcA=$?
  env HARNESS_ORCH_HOME="$homeB" ORCH_DIRECT=1 bash -c "\"$BUN\" \"$BIN\" $line" \
    >"$case_dir/b/out.raw" 2>"$case_dir/b/err"; rcB=$?
  if [ -n "${ORCH_PARITY_MUTATE_B:-}" ]; then
    sed "$ORCH_PARITY_MUTATE_B" "$case_dir/b/out.raw" >"$case_dir/b/out"
  else
    cp "$case_dir/b/out.raw" "$case_dir/b/out"
  fi

  # Home paths differ per side by design: map both to <HOME> before comparing text.
  for side in a b; do
    h=$homeA; [ "$side" = b ] && h=$homeB
    real=$(cd "$h" && pwd -P)
    for f in out err; do
      sed -e "s#$real#<HOME>#g" -e "s#$h#<HOME>#g" "$case_dir/$side/$f" >"$case_dir/$side/$f.n" 2>/dev/null
    done
  done
  "$BUN" "$PARITY_DIR/normalize.ts" "$homeA" | sed "s#$homeA#<HOME>#g" >"$case_dir/a/tree"
  "$BUN" "$PARITY_DIR/normalize.ts" "$homeB" | sed "s#$homeB#<HOME>#g" >"$case_dir/b/tree"

  bad=""
  cmp -s "$case_dir/a/out.n" "$case_dir/b/out.n" || bad="$bad stdout"
  cmp -s "$case_dir/a/err.n" "$case_dir/b/err.n" || bad="$bad stderr"
  [ "$rcA" = "$rcB" ] || bad="$bad exit"
  cmp -s "$case_dir/a/tree" "$case_dir/b/tree" || bad="$bad tree"

  if [ -n "$bad" ]; then
    fails=$((fails + 1))
    printf 'FAIL %s:%s  (%s)\n  %s\n' "$(basename "$case_file")" "$n" "$bad" "$line"
    printf '  exit: bash=%s bun=%s\n' "$rcA" "$rcB"
    for part in $bad; do
      case "$part" in
        stdout) diff -u "$case_dir/a/out.n" "$case_dir/b/out.n" | head -40 ;;
        stderr) diff -u "$case_dir/a/err.n" "$case_dir/b/err.n" | head -40 ;;
        tree) diff -u "$case_dir/a/tree" "$case_dir/b/tree" | head -60 ;;
      esac
    done
  fi
done <"$case_file"

if [ "$fails" -eq 0 ]; then
  printf 'parity: %s/%s cases match (%s)\n' "$((total - fails))" "$total" "$(basename "$case_file")"
  trash "$work" 2>/dev/null || mv "$work" "${TMPDIR:-/tmp}/orch-parity-trash-$$" 2>/dev/null
  exit 0
fi
printf 'parity: %s/%s cases FAILED (%s). Kept: %s\n' "$fails" "$total" "$(basename "$case_file")" "$work"
exit 1
