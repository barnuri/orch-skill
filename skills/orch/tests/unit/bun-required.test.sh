#!/usr/bin/env bash
# orch needs Bun: with no bun on PATH, dispatch.sh exits 127 and prints the install hint.
# With bun on PATH, `dispatch.sh doctor` runs the Bun CLI and prints the bun version.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"

scratch=$(new_tmp)
no_bun_path=$(path_without bun)
if PATH="$no_bun_path" command -v bun >/dev/null 2>&1; then
  printf 'FAIL: bun still on PATH after path_without\n' >&2
  failures=$((failures + 1))
else
  pass_count=$((pass_count + 1))
fi

out=$(env -i PATH="$no_bun_path" HOME="$scratch/home" HARNESS_ORCH_HOME="$scratch/orch" \
  /bin/bash "$SCRIPT" --version 2>&1)
rc=$?
expect_exit "dispatch.sh exits 127 without bun" 127 "$rc"
expect_match "no-bun message names bun and the install URL" \
  'orch needs bun: install it from https://bun.sh' "$out"

bun_bin=$(command -v bun 2>/dev/null || true)
if [ -n "$bun_bin" ]; then
  out=$(env HARNESS_ORCH_HOME="$scratch/orch" "$SCRIPT" doctor 2>&1)
  rc=$?
  expect_exit "doctor exits 0 with bun" 0 "$rc"
  expect_match "doctor prints bun version" '^bun: [0-9]' "$out"
  expect_match "doctor prints home path" "^home: $scratch/orch" "$out"
  expect_match "doctor prints herdr line" '^herdr: ' "$out"
fi

cleanup_dir "$scratch"
finish
