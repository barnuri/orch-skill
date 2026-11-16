#!/usr/bin/env bash
# Run the fast tier of the bun suite: every src test file except the slow ones.
# A file is slow when its first line is `// test-tier: slow (...)`: it spawns the real
# dispatch.sh, a real server process or a real harness CLI. `bun run test` still runs all of them.
# Extra arguments go to `bun test` (for example --watch or a name filter).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Slow files that cannot carry the marker yet because another session has uncommitted edits in them.
SLOW_UNMARKED=(
  src/server/routes/runs-routes.test.ts
  src/server/chats/model-offer.test.ts
)

is_unmarked_slow() {
  local file="$1" slow
  for slow in "${SLOW_UNMARKED[@]}"; do
    [[ "$file" == "$slow" ]] && return 0
  done
  return 1
}

files=()
while IFS= read -r file; do
  if head -n 1 "$file" | grep -q '^// test-tier: slow'; then
    continue
  fi
  if is_unmarked_slow "$file"; then
    continue
  fi
  files+=("./$file")
done < <(find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -not -path '*/node_modules/*' | sort)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "test-fast: no fast test files found" >&2
  exit 1
fi

echo "test-fast: ${#files[@]} files" >&2
ORCH_HERDR=0 exec bun test --timeout 30000 --parallel=6 "$@" "${files[@]}"
