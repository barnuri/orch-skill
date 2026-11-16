#!/usr/bin/env bash
# seed_home <dir>: makes <dir> the same as `dispatch.sh init` on an empty home would, by copying a
# home that was initialised once. Sourced by test-lib.sh and by the self-contained *.test.sh files.
#
# Why: the first command on a new home runs the profiles.json migrations (several jq passes and
# file moves), about 2-4 s on a loaded machine. tests/run.sh builds one template for the whole
# suite and exports ORCH_TEST_HOME_TEMPLATE; a file run alone builds its own on first use.
# `cp -p` keeps the mtimes, so the migration signature in .migrations/ still matches and the copy
# does not migrate again. Use it only for setup: tests that check init itself still run `init`.

seed_home_template() {
  local dir="$1"
  mkdir -p "$dir" || return 1
  env HARNESS_ORCH_HOME="$dir" ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0 \
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../scripts/dispatch.sh" init >/dev/null 2>&1
}

seed_home() {
  local dest="$1" src
  if [ -z "${ORCH_TEST_HOME_TEMPLATE:-}" ] || [ ! -f "$ORCH_TEST_HOME_TEMPLATE/profiles.json" ]; then
    ORCH_TEST_HOME_TEMPLATE="$(mktemp -d)/home"
    seed_home_template "$ORCH_TEST_HOME_TEMPLATE" || return 1
    export ORCH_TEST_HOME_TEMPLATE
  fi
  mkdir -p "$dest" || return 1
  local items=()
  for src in "$ORCH_TEST_HOME_TEMPLATE"/* "$ORCH_TEST_HOME_TEMPLATE"/.[!.]*; do
    [ -e "$src" ] || continue
    case "${src##*/}" in .trash) continue ;; esac
    items+=("$src")
  done
  cp -Rp "${items[@]}" "$dest/"
}
