#!/usr/bin/env bash
# Fast-tier unit tests for lib/core/locks.sh: single-flight locks, called in-process.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

orch_lock_acquire demo; rc=$?
expect_exit "a free lock is taken" 0 "$rc"
expect_match "the lock file holds this pid" "^$$\$" "$(cat "$H/locks/demo.pid")"

orch_lock_acquire demo; rc=$?
expect_exit "the owner may take its own lock again" 0 "$rc"

sleep 30 & holder=$!
printf '%s\n' "$holder" > "$H/locks/busy.pid"
orch_lock_acquire busy; rc=$?
expect_exit "a lock held by another live process is refused" 1 "$rc"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
orch_lock_acquire busy; rc=$?
expect_exit "a lock whose holder died is taken over" 0 "$rc"

orch_lock_release demo
expect_file "release keeps the lock file" "$H/locks/demo.pid"
expect_empty "release truncates the lock file" "$(cat "$H/locks/demo.pid")"
orch_lock_acquire demo; rc=$?
expect_exit "a released (empty) lock is taken again" 0 "$rc"

orch_lock_acquire 'a/b c'; rc=$?
expect_exit "a name with unsafe characters is taken" 0 "$rc"
expect_file "unsafe characters map to _ in the file name" "$H/locks/a_b_c.pid"

cleanup_dir "$(dirname "$H")"
finish
