#!/usr/bin/env bash
# Fast-tier smoke checks: every script parses, sourcing dispatch.sh (and so every lib in
# ORCH_LIB_FILES, in order) has no side effects, and the help text names every subcommand.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"

ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

scratch=$(new_tmp)
# --- bash -n on every script of the skill (scripts, libs, tests), in the background meanwhile
find "$ORCH_DIR/scripts" "$ORCH_DIR/tests" -name '*.sh' -type f | while IFS= read -r f; do
  bash -n "$f" 2>/dev/null || printf ' %s' "$f"
done > "$scratch/syntax" &
syntax_pid=$!

# --- every lib in ORCH_LIB_FILES exists and parses alone
libs=$(sed -n '/^ORCH_LIB_FILES="/,/"$/p' "$SCRIPT" | tr -d '"' | sed 's/^ORCH_LIB_FILES=//')
missing=""
for l in $libs; do [ -f "$SCRIPT_DIR/lib/$l.sh" ] || missing="$missing $l"; done
expect_empty "every ORCH_LIB_FILES entry exists" "$missing"

# --- sourcing dispatch.sh in a clean shell prints nothing and creates no files
empty=$(new_tmp)
out=$(env -i PATH="$PATH" HOME="$empty/home" HARNESS_ORCH_HOME="$empty/orch" TMPDIR="$empty" \
  bash -c '. "$1"; type adapter_dispatch >/dev/null && echo sourced; declare -F > "$2"' _ "$SCRIPT" "$scratch/declared" 2>&1)
expect_match "sourcing dispatch.sh prints nothing but the probe" '^sourced$' "$out"
created=$(find "$empty" -mindepth 1 2>/dev/null)
expect_empty "sourcing dispatch.sh creates no files" "$created"

# --- every lib function is defined after sourcing, in ORCH_LIB_FILES order
declared=$(awk '{print $3}' "$scratch/declared")
lost=$(sed -nE 's/^([a-z_][a-z0-9_]*)\(\).*/\1/p' $(for l in $libs; do printf '%s ' "$SCRIPT_DIR/lib/$l.sh"; done) \
  | sort -u | comm -23 - <(printf '%s\n' "$declared" | sort -u))
expect_empty "every lib function is defined after sourcing" "$lost"

# --- help: exits 0, writes nothing to stderr, names every top-level subcommand of main()
help=$(HARNESS_ORCH_HOME="$empty/orch" bash "$SCRIPT" --help 2>"$scratch/help.err")
expect_empty "--help writes nothing to stderr" "$(cat "$scratch/help.err")"
expect_match "--help prints the usage" 'dispatch\.sh classify' "$help"
subs=$(sed -n '/^main()/,/^}/p' "$SCRIPT" | sed -nE 's/^    ([a-z][a-z|-]*)\).*/\1/p' | tr '|' '\n')
# A subcommand passes when --help or its own *_USAGE text in a lib names it (owner, delegate).
corpus="$help
$(cat "$SCRIPT_DIR"/lib/*/*.sh)"
absent=$(printf '%s' "$corpus" | awk -v subs="$(printf '%s ' $subs)" '
  { line = line $0 "\n" }
  END { n = split(subs, s, " "); for (i = 1; i <= n; i++) if (line !~ ("dispatch\\.sh " s[i] "( |\n)")) printf " %s", s[i] }')
expect_empty "every main() subcommand has a usage line" "$absent"

# --- an unknown subcommand fails with the usage on stderr, not a bash error
err=$(HARNESS_ORCH_HOME="$empty/orch" bash "$SCRIPT" no-such-subcommand 2>&1 >/dev/null); rc=$?
expect_exit "unknown subcommand exits non-zero" 1 "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
expect_no_match "unknown subcommand prints no bash error" 'command not found|unbound variable|syntax error' "$err"

wait "$syntax_pid"
expect_empty "bash -n passes on every script" "$(cat "$scratch/syntax")"

cleanup_dir "$empty"
cleanup_dir "$scratch"
finish
