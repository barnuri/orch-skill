#!/usr/bin/env bash
# Single-flight locks: <home>/locks/<name>.pid holds the owner pid. A lock whose pid is dead or
# empty is free. Release truncates the file (nothing is deleted). Sourced, never executed.

locks_dir() { printf '%s/locks\n' "$ORCH_HOME"; }

# orch_lock_acquire <name> - 0 when taken by this process, 1 when another live process holds it.
orch_lock_acquire() {
  local f cur
  mkdir -p "$(locks_dir)" 2>/dev/null || return 0
  f="$(locks_dir)/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_').pid"
  if ( set -C; printf '%s\n' "$$" > "$f" ) 2>/dev/null; then return 0; fi
  cur=$(cat "$f" 2>/dev/null)
  if [ -n "$cur" ] && [ "$cur" != "$$" ] && kill -0 "$cur" 2>/dev/null; then return 1; fi
  printf '%s\n' "$$" > "$f" 2>/dev/null
  return 0
}

orch_lock_release() {
  local f
  f="$(locks_dir)/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_').pid"
  [ "$(cat "$f" 2>/dev/null)" = "$$" ] && : > "$f"
  return 0
}
