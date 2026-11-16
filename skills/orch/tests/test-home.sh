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

# seed_home_template_cached: prints the path of a template home shared across runs, under $TMPDIR and
# keyed by a hash of the scripts and templates that shape `init`, so it is rebuilt only after they
# change. Saves the 3-8 s init (on a loaded machine) on every run of the fast tier.
seed_home_template_cached() {
  local orch key cache tmp
  orch="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  key=$(cat "$orch/scripts/dispatch.sh" "$orch"/scripts/lib/*/*.sh "$orch"/templates/* 2>/dev/null | cksum | tr ' ' '-')
  cache="${TMPDIR:-/tmp}"
  cache="${cache%/}/orch-test-home-template.$key"
  if [ ! -f "$cache/profiles.json" ]; then
    tmp=$(mktemp -d) || return 1
    seed_home_template "$tmp/home" || return 1
    # A concurrent runner may have built it first: keep theirs, the copies are equivalent.
    [ -f "$cache/profiles.json" ] || mv "$tmp/home" "$cache" 2>/dev/null
    [ -f "$cache/profiles.json" ] || { printf '%s\n' "$tmp/home"; return 0; }
  fi
  printf '%s\n' "$cache"
}

seed_home() {
  local dest="$1" src
  if [ -z "${ORCH_TEST_HOME_TEMPLATE:-}" ] || [ ! -f "$ORCH_TEST_HOME_TEMPLATE/profiles.json" ]; then
    ORCH_TEST_HOME_TEMPLATE=$(seed_home_template_cached) || return 1
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
