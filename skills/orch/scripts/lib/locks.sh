#!/usr/bin/env bash
# Single-flight locks: <home>/locks/<name>.pid holds the owner pid. A lock whose pid is dead or
# empty is free. Release truncates the file (nothing is deleted). Sourced, never executed.

locks_dir() { printf '%s/locks\n' "$ORCH_HOME"; }

# orch_lock_acquire <name> - 0 when taken by this process, 1 when another live process holds it.
# A released lock is an existing, empty file, so `set -C` alone no longer excludes anyone: two callers
# that both read it empty both took it. The takeover of an empty or dead lock is therefore done under
# a mkdir mutex (atomic); a mutex left by a killed caller is ignored after 5 s.
orch_lock_acquire() {
  local f cur m got=1 t
  mkdir -p "$(locks_dir)" 2>/dev/null || return 0
  f="$(locks_dir)/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_').pid"
  if ( set -C; printf '%s\n' "$$" > "$f" ) 2>/dev/null; then return 0; fi
  cur=$(cat "$f" 2>/dev/null)
  if [ -n "$cur" ] && [ "$cur" != "$$" ] && kill -0 "$cur" 2>/dev/null; then return 1; fi
  m="$f.take"
  if ! mkdir "$m" 2>/dev/null; then
    t=$(file_mtime "$m" 2>/dev/null) || t=""
    [ -n "$t" ] && [ $(( $(date +%s) - t )) -ge 5 ] || return 1
  fi
  cur=$(cat "$f" 2>/dev/null)
  if [ -z "$cur" ] || [ "$cur" = "$$" ] || ! kill -0 "$cur" 2>/dev/null; then
    printf '%s\n' "$$" > "$f" 2>/dev/null && got=0
  fi
  rmdir "$m" 2>/dev/null
  return $got
}

orch_lock_release() {
  local f
  f="$(locks_dir)/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_').pid"
  [ "$(cat "$f" 2>/dev/null)" = "$$" ] && : > "$f"
  return 0
}
