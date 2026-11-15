#!/usr/bin/env bash
# Test double for `dispatch.sh run --profile P @promptfile` on a harness with no session (local-llm).
# Answers with the number of characters it was sent and logs the whole prompt. Never calls a model.
[ "$1" = run ] || { echo "unexpected: $*" >&2; exit 2; }
prompt=$(cat "${4#@}")
[ -z "${FAKE_PROMPT_LOG:-}" ] || printf '%s\n=====\n' "$prompt" >> "$FAKE_PROMPT_LOG"
printf 'chars=%s' "${#prompt}"
