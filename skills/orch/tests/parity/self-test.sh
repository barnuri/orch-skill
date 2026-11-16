#!/usr/bin/env bash
# Self-test for the parity harness: a matching case must pass, and a deliberately different Bun-side
# output must fail. Exit 0 only when both hold.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'self-test: FAIL %s\n' "$1"; exit 1; }

out=$(bash "$D/parity.sh" "$D/cases/self.cases" 2>&1); rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out"; fail "matching case did not pass (rc=$rc)"; }

out2=$(ORCH_PARITY_MUTATE_B='s/0\.1\.0/9.9.9/' bash "$D/parity.sh" "$D/cases/self.cases" 2>&1); rc2=$?
[ "$rc2" -ne 0 ] || fail "deliberately different output passed"
printf '%s\n' "$out2" | grep -q '^FAIL ' || fail "no FAIL line for the deliberate difference"

printf 'self-test: ok (match passes; deliberate difference fails, rc=%s)\n' "$rc2"
