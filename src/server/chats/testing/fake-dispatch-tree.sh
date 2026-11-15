#!/usr/bin/env bash
# Test double: like a real adapter it starts a child agent (here `sleep`) and waits for it.
# Writes the child pid to $FAKE_TREE_PIDS and, when asked, ignores SIGTERM in the child.
[ "$1" = run ] || exit 2
cat "${4#@}" > "${FAKE_TREE_PROMPT:-/dev/null}"
if [ -n "${FAKE_TREE_STUBBORN:-}" ]; then
  bash -c 'trap "" TERM; echo $$ >> "$FAKE_TREE_PIDS"; while :; do sleep 1; done' &
else
  sleep 60 &
  echo $! >> "$FAKE_TREE_PIDS"
fi
echo started
wait
