#!/usr/bin/env bash
# Optional static gates. Each tool SKIPs when absent (oxfmt/oxlint are only used if already in bun's cache or on PATH:
# nothing is downloaded here). Only real errors fail (exit 1): oxlint errors, shellcheck errors. Formatting never fails;
# it only prints how many files differ from .oxfmtrc.json.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
rc=0

run_tool() { # run_tool <name> <args…>: oxfmt/oxlint from PATH, else bunx without installing
  local name=$1; shift
  if command -v "$name" >/dev/null 2>&1; then "$name" "$@"
  elif command -v bunx >/dev/null 2>&1; then bunx --no-install "$name" "$@"
  else return 127; fi
}

out=$(run_tool oxfmt --version 2>&1) && {
  n=$(run_tool oxfmt --check src 2>&1 | grep -cE '\.(ts|tsx|css|json) \(' || true)
  printf 'format: %s file(s) differ from .oxfmtrc.json (not enforced)\n' "$n"
} || printf 'SKIP: oxfmt not available\n'

if run_tool oxlint --version >/dev/null 2>&1; then
  o=$(run_tool oxlint src 2>&1)
  errs=$(printf '%s\n' "$o" | grep -c ': error ' || true)
  warns=$(printf '%s\n' "$o" | grep -c ': warning ' || true)
  printf 'oxlint: %s error(s), %s warning(s)\n' "$errs" "$warns"
  [ "$errs" -eq 0 ] || { printf '%s\n' "$o" | grep ': error ' | head -20; rc=1; }
else
  printf 'SKIP: oxlint not available\n'
fi

if command -v shellcheck >/dev/null 2>&1; then
  files=$(find skills/orch/scripts skills/orch/tests scripts -name '*.sh')
  # shellcheck disable=SC2086
  s=$(shellcheck -s bash -S error $files 2>&1)
  if [ -n "$s" ]; then printf 'shellcheck: errors\n%s\n' "$s" | head -30; rc=1; else printf 'shellcheck: 0 errors\n'; fi
else
  printf 'SKIP: shellcheck not found\n'
fi
exit $rc
