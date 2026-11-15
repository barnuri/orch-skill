#!/usr/bin/env bash
# Test double for `dispatch.sh run --profile P @promptfile`. Never calls a model.
[ "$1" = run ] || { echo "unexpected: $*" >&2; exit 2; }
prompt=$(cat "${4#@}")
[ -z "${FAKE_AGENT_LOG:-}" ] || printf '{"profile":"%s","model_id":"%s","resume":"%s","session":"%s","cwd":"%s"}\n' "$3" "${ORCH_MODEL_ID:-}" "${ORCH_RESUME_SESSION:-}" "${ORCH_SESSION_ID:-}" "$PWD" >> "$FAKE_AGENT_LOG"
case "$prompt" in
  *FAIL*) echo "boom" >&2; exit 4 ;;
  *SLOW*) while true; do printf 'tick '; sleep 0.05; done ;;
esac
printf 'turn-echo: %s' "$(printf '%s' "$prompt" | head -n1)"
