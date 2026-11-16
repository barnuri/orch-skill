#!/usr/bin/env bash
# Tests that no dispatch.ts call leaves a profiles.json.tmp.* file behind. Run with: bash tmp-leak.test.sh
set -u
export ORCH_NO_ANNOUNCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.ts"
failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$want" "$got" >&2
  failures=$((failures + 1))
}

home=$(mktemp -d)

tmps() { find "$1" -maxdepth 1 -name 'profiles.json.tmp.*' | wc -l | tr -d ' '; }

home=$(mktemp -d)
o() { HARNESS_ORCH_HOME="$home" bun "$SCRIPT" "$@"; }
o init >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do o profile list >/dev/null 2>&1; done
expect_match "10 calls leave no temp" '^0$' "$(tmps "$home")"

home2=$(mktemp -d)
printf '{"profiles":{},"settings":{}}\n' > "$home2/profiles.json"
HARNESS_ORCH_HOME="$home2" bun "$SCRIPT" profile list >/dev/null 2>&1
expect_match "changing migration replaced the file" 'max_attempts' "$(cat "$home2/profiles.json")"
expect_match "changing migration leaves no temp" '^0$' "$(tmps "$home2")"

home3=$(mktemp -d)
printf '{broken json\n' > "$home3/profiles.json"
HARNESS_ORCH_HOME="$home3" bun "$SCRIPT" profile list >/dev/null 2>&1
expect_exit "failed migration keeps the file" 0 "$(cmp -s "$home3/profiles.json" <(printf '{broken json\n'); echo $?)"
expect_match "failed migration leaves no temp" '^0$' "$(tmps "$home3")"

m1=$(stat -f %m "$home/profiles.json"); sleep 1; o profile list >/dev/null 2>&1
expect_match "idle call keeps profiles.json mtime" "^$m1\$" "$(stat -f %m "$home/profiles.json")"

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
