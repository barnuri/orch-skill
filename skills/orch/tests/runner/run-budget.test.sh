#!/usr/bin/env bash
# Budget, partial record and resume of the test runners, on fake trees with a fake slow test file:
# skills/orch/tests/run.sh, scripts/test-budget.sh (bun chunks) and scripts/test-all.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
REPO="$(cd "$TESTS_DIR/../../.." && pwd)"
export ORCH_TEST_LOCK=0
T=$(new_tmp)

# --- test-budget.sh: fake bun command; each "test file" sleeps or fails by its name.
B="$T/bun"
mkdir -p "$B/scripts" "$B/src/a" "$B/src/node_modules/x"
cp "$REPO/scripts/test-budget.sh" "$B/scripts/"
printf 'heavy_lock_acquire() { :; }\n' > "$B/scripts/heavy-test-lock.sh"
for n in a/one a/two three four; do : > "$B/src/$n.test.ts"; done
: > "$B/src/five.test.tsx"
: > "$B/src/node_modules/x/skip.test.ts"
cat > "$T/fakebun" <<EOF
#!/usr/bin/env bash
for f in "\$@"; do
  echo "\$f" >> "$T/bun-ran.log"
  case "\$f" in *three*) sleep "\${FAKE_BUN_SLOW:-0}" ;; *four*) [ -n "\${FAKE_BUN_FAIL:-}" ] && exit 1 ;; esac
done
echo " \$# pass"
EOF
chmod +x "$T/fakebun"
export ORCH_BUN_TEST_CMD="$T/fakebun" ORCH_BUN_TEST_PROGRESS="$T/bun-progress.json"
# Files sorted: a/one a/two five four three; one file per chunk. three sleeps past budget + grace.
out=$(cd "$B" && FAKE_BUN_SLOW=60 bash scripts/test-budget.sh --chunk 1 --budget 1 2>&1); rc=$?
expect_exit "a bun run cut by its budget exits 75" 75 "$rc"
expect_match "the bun run prints PARTIAL last" 'PARTIAL: [0-9]+ of 5 files, run again with --resume$' "$(printf '%s' "$out" | tail -1)"
expect_no_match "node_modules is not scanned" 'skip.test' "$(cat "$T/bun-progress.json")"
expect_match "a slow chunk killed at budget + grace did not run" '"./src/three.test.ts": "not_run"' "$(cat "$T/bun-progress.json")"
expect_match "the first chunk passed" '"./src/a/one.test.ts": "passed"' "$(cat "$T/bun-progress.json")"

: > "$T/bun-ran.log"
out=$(cd "$B" && bash scripts/test-budget.sh --resume 2>&1); rc=$?
expect_exit "a resumed bun run that finishes exits 0" 0 "$rc"
expect_no_match "bun resume skips the files that passed" 'a/one' "$(cat "$T/bun-ran.log")"
expect_match "bun resume runs the files left" 'three' "$(cat "$T/bun-ran.log")"
expect_missing "a finished bun run clears the record" "$T/bun-progress.json"

out=$(cd "$B" && FAKE_BUN_FAIL=1 bash scripts/test-budget.sh --chunk 2 2>&1); rc=$?
expect_exit "a failing bun chunk exits 1" 1 "$rc"
expect_match "a failing chunk names its files" 'bun chunk FAILED.*five.*four' "$out"
expect_missing "a finished bun run with failures writes no record" "$T/bun-progress.json"

# --- test-all.sh: stub suites; bash stops at its budget once, then resumes.
A="$T/all"
mkdir -p "$A/scripts" "$A/skills/orch/tests"
cp "$REPO/scripts/test-all.sh" "$A/scripts/"
printf 'heavy_lock_acquire() { :; }\n' > "$A/scripts/heavy-test-lock.sh"
cat > "$A/skills/orch/tests/run.sh" <<EOF
echo "bash \$*" >> "$T/all-ran.log"
case "\$*" in *--resume*) echo "3 passed, 0 failed"; exit 0 ;; esac
echo "1 passed, 0 failed"; echo "PARTIAL: 1 of 3 files, run again with --resume"; exit 75
EOF
printf 'echo "bun $*" >> "%s/all-ran.log"; echo "bun: 5 passed"; exit 0\n' "$T" > "$A/scripts/test-budget.sh"
printf 'echo types >> "%s/all-ran.log"; echo "typecheck: ok"\n' "$T" > "$A/scripts/typecheck.sh"
printf 'echo lint >> "%s/all-ran.log"\n' "$T" > "$A/scripts/lint-optional.sh"
export ORCH_TEST_ALL_PROGRESS="$T/all-progress"
: > "$T/all-ran.log"
out=$(bash "$A/scripts/test-all.sh" 2>&1); rc=$?
expect_exit "test-all exits 75 when a suite stops at its budget" 75 "$rc"
expect_match "test-all names the suites left" 'PARTIAL: suites left: bash, run again with --resume$' "$(printf '%s' "$out" | tail -1)"
: > "$T/all-ran.log"
out=$(bash "$A/scripts/test-all.sh" --resume 2>&1); rc=$?
expect_exit "test-all --resume exits 0 once the suite finishes" 0 "$rc"
expect_match "test-all --resume reruns only the cut suite, with --resume" '^bash --resume$' "$(cat "$T/all-ran.log")"
expect_missing "test-all clears its record when done" "$T/all-progress"

cleanup_dir "$T"
finish
