#!/usr/bin/env bash
# dispatch.sh sources lib/<category>/*.sh from its explicit ORCH_LIB_FILES list: every lib file on
# disk must be in that list, and every list entry must exist.
# Run: bash lib-list.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

listed=$(bash -c '. "$1"; for f in $ORCH_LIB_FILES; do printf "%s\n" "$f"; done' _ "$SCRIPT"| sort)
on_disk=$(cd "$SCRIPT_DIR/lib" && for f in */*.sh; do printf '%s\n' "${f%.sh}"; done | sort)
expect_match "ORCH_LIB_FILES is not empty" '^core/config$' "$listed"
expect_match "every lib file is listed and every entry exists" '^same$' \
  "$([ "$listed" = "$on_disk" ] && echo same || diff <(printf '%s\n' "$listed") <(printf '%s\n' "$on_disk"))"
expect_no_match "no lib file is left at the lib/ top level" '\.sh$' "$(ls "$SCRIPT_DIR/lib")"

finish
