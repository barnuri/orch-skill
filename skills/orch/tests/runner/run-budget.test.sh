#!/usr/bin/env bash
# Budget, partial record and resume of the test runners, on fake trees with a fake slow test file:
# skills/orch/tests/run.sh, scripts/test-budget.sh (bun chunks) and scripts/test-all.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
REPO="$(cd "$TESTS_DIR/../../.." && pwd)"
export ORCH_TEST_LOCK=0
T=$(new_tmp)

# --- run.sh: fake repo with three unit files (slow, mid, fast) and one failing file elsewhere.
F="$T/bash"
mkdir -p "$F/skills/orch/tests/unit" "$F/skills/orch/tests/other" "$F/scripts"
cp "$TESTS_DIR/run.sh" "$F/skills/orch/tests/run.sh"
printf 'seed_home_template_cached() { echo "%s"; }\n' "$T" > "$F/skills/orch/tests/test-home.sh"
printf 'heavy_lock_acquire() { :; }\n' > "$F/scripts/heavy-test-lock.sh"
for n in slow mid fast; do
  cat > "$F/skills/orch/tests/unit/$n.test.sh" <<EOF
echo "unit/$n" >> "$T/ran.log"
sleep "\${FAKE_SLEEP_$n:-0}"
echo "1 passed, 0 failed"
EOF
done
printf 'echo other/bad >> "%s/ran.log"\necho "0 passed, 1 failed"; exit 1\n' "$T" > "$F/skills/orch/tests/other/bad.test.sh"
# Longest first: slow, mid, fast.
printf 'unit/slow 50\nunit/mid 10\nunit/fast 5\nother/bad 1\n' > "$T/timings"
export ORCH_TEST_TIMINGS="$T/timings" ORCH_TEST_PROGRESS="$T/progress.json" ORCH_TEST_BUDGET_GRACE=3
R="$F/skills/orch/tests/run.sh"

# Two slots: slow and mid start; the slot frees at 3 s, after the 2 s budget, so fast never starts.
# mid ends inside the grace and passes; slow is killed at budget + grace.
out=$(FAKE_SLEEP_slow=60 FAKE_SLEEP_mid=3 ORCH_TEST_JOBS=2 bash "$R" --fast --budget 2 2>&1); rc=$?
expect_exit "a run cut by its budget exits 75" 75 "$rc"
expect_match "the last line says PARTIAL and how to go on" 'PARTIAL: 1 of 3 files, run again with --resume$' "$(printf '%s' "$out" | tail -1)"
expect_file "the partial run is recorded" "$T/progress.json"
rec=$(cat "$T/progress.json" 2>/dev/null)
expect_match "the record keeps the tier" '"mode": "fast"' "$rec"
expect_match "a file that ended inside the grace passed" '"unit/mid": "passed"' "$rec"
expect_match "a file killed at budget + grace did not run" '"unit/slow": "not_run"' "$rec"
expect_match "a file never started did not run" '"unit/fast": "not_run"' "$rec"
expect_match "the record is valid JSON" '^ok$' "$(jq -e '.files | length == 3' "$T/progress.json" >/dev/null && echo ok)"

: > "$T/ran.log"
out=$(bash "$R" --resume 2>&1); rc=$?
expect_exit "a resumed run that finishes every file exits 0" 0 "$rc"
expect_no_match "resume skips the files that passed" 'unit/mid' "$(cat "$T/ran.log")"
expect_match "resume runs the files left" 'unit/slow' "$(cat "$T/ran.log")"
expect_missing "a finished run clears the record" "$T/progress.json"

out=$(bash "$R" --resume 2>&1); rc=$?
expect_exit "resume with no record is a usage error" 2 "$rc"
expect_match "resume with no record says so" 'no partial run recorded' "$out"

# A failure in a resumed run: exit 1, record cleared.
printf '{"mode": "pick",\n "files": {\n  "unit/fast": "passed",\n  "other/bad": "not_run"\n }}\n' > "$T/progress.json"
out=$(bash "$R" --resume 2>&1); rc=$?
expect_exit "a resumed run with a failing file exits 1" 1 "$rc"
expect_missing "a finished run clears the record even with failures" "$T/progress.json"

# --full defaults to a 300 s budget; a run without a budget never writes a record.
out=$(bash "$R" --full 2>&1)
expect_match "--full defaults to a 300 s budget" 'budget: 300s' "$out"
out=$(FAKE_SLEEP_slow=60 ORCH_TEST_FILE_CAP=1 bash "$R" slow 2>&1)
expect_missing "a run without a budget writes no record" "$T/progress.json"
expect_match "--budget rejects a non-number" 'whole seconds' "$(bash "$R" --budget x 2>&1)"

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
