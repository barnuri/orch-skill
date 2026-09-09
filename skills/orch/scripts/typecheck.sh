#!/usr/bin/env bash
# Typechecks the orch TypeScript tree without installing a single dependency.
#
#   1. Bun bundles the dashboard (transpile only — no types, but it is the one gate that needs
#      nothing but bun, and it catches syntax and unresolvable-import errors).
#   2. tsc against dashboard/tsconfig.json — the zero-dep half of the tree (DOM lib, `types: []`),
#      which also proves shared/types stays Bun-free.
#   3. tsc against the root tsconfig.json — server + shared + dashboard tests. That one needs
#      bun-types and @types/node, which live in bun's global install cache; they are symlinked
#      into the gitignored .types/ so `typeRoots` resolves without a node_modules in the skill.
#
# A missing tool is a SKIP (exit 0), never a failure, so this is safe to call from the test suite
# on a machine that has only bash. Exit 0 = passed or skipped, 1 = a step that could run failed.

set -u

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
BUN="${ORCH_BUN:-bun}"
BUN_CACHE="${BUN_INSTALL:-$HOME/.bun}/install/cache"
TYPES_DIR="$SKILL_DIR/.types"

# newest_dir <candidate…>: prints the most recently modified candidate that is a directory.
# Callers pass globs; unmatched ones stay literal and are filtered out by the -d test.
newest_dir() {
  local newest="" candidate
  for candidate in "$@"; do
    [ -d "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done
  [ -n "$newest" ] || return 1
  printf '%s\n' "$newest"
}

# bundle_dashboard: step 1. Bundles into an OS temp dir — never inside the skill tree, so a
# half-written bundle can't be mistaken for a source file or land in git.
bundle_dashboard() {
  local out status
  out=$(mktemp -d) || return 1
  "$BUN" build "$SKILL_DIR/dashboard/index.html" --outdir "$out/dashboard" --target=browser >/dev/null
  status=$?
  trash "$out" 2>/dev/null || true
  [ "$status" -eq 0 ] || return 1
}

# bun_types_dir: the bun-types package matching the running bun, honouring an explicit override.
bun_types_dir() {
  local version
  if [ -n "${ORCH_BUN_TYPES:-}" ]; then
    [ -d "$ORCH_BUN_TYPES" ] || return 1
    printf '%s\n' "$ORCH_BUN_TYPES"
    return 0
  fi
  version=$("$BUN" --version) || return 1
  newest_dir "$BUN_CACHE"/bun-types@"$version"*
}

# server_typecheck: step 3. Returns 2 when the cache has no types to link (skip), 1 on failure.
server_typecheck() {
  local bun_types node_types
  bun_types=$(bun_types_dir) || return 2
  node_types=$(newest_dir "$BUN_CACHE"/@types/node@*) || return 2
  mkdir -p "$TYPES_DIR" || return 1
  ln -sfn "$bun_types" "$TYPES_DIR/bun-types" || return 1
  ln -sfn "$node_types" "$TYPES_DIR/node" || return 1
  tsc -p "$SKILL_DIR/tsconfig.json" --noEmit || return 1
}

main() {
  if ! command -v "$BUN" >/dev/null 2>&1; then
    printf 'SKIP: bun not found\n'
    return 0
  fi
  if ! bundle_dashboard; then
    printf 'typecheck: FAIL dashboard bundle\n' >&2
    return 1
  fi

  if ! command -v tsc >/dev/null 2>&1; then
    printf 'SKIP: tsc not found (brew install typescript)\n'
    return 0
  fi
  if ! tsc -p "$SKILL_DIR/dashboard/tsconfig.json" --noEmit; then
    printf 'typecheck: FAIL dashboard tsc\n' >&2
    return 1
  fi

  server_typecheck
  case $? in
    0) ;;
    2)
      printf "SKIP: server typecheck (bun-types/@types/node not in the bun cache; run 'bun add -g @types/bun' once to enable)\n"
      return 0
      ;;
    *)
      printf 'typecheck: FAIL server tsc\n' >&2
      return 1
      ;;
  esac

  printf 'typecheck: ok\n'
}

main "$@"
