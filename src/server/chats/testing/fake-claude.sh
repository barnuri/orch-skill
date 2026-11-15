#!/usr/bin/env bash
# Test double for `claude -p --input-format stream-json --output-format stream-json`. Never calls a model.
# Prompt words steer it: SLOW (streams until killed), CRASH (exits 3), FAIL (is_error result), TOOL (emits a tool_use).
args=("$@")
session="fake-session"
for i in "${!args[@]}"; do
  case "${args[$i]}" in --resume|--session-id) session="${args[$((i + 1))]}" ;; esac
done
if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  joined=""
  for a in "$@"; do joined="$joined\"$a\","; done
  printf '{"pid":%s,"args":[%s],"cwd":"%s","env":{"ANTHROPIC_MODEL":"%s"}}\n' "$$" "${joined%,}" "$PWD" "${ANTHROPIC_MODEL:-}" >> "$FAKE_AGENT_LOG"
fi
delta() {
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"%s"}},"session_id":"%s","parent_tool_use_id":null}\n' "$1" "$session"
}
turn=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  turn=$((turn + 1))
  text=${line#*\"text\":\"}
  text=${text%%\"\}*}
  [ -z "${FAKE_AGENT_LOG:-}" ] || printf '{"prompt":"%s"}\n' "$text" >> "$FAKE_AGENT_LOG"
  printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$session"
  case "$text" in *CRASH*) exit 3 ;; esac
  case "$text" in *TOOL*) printf '{"type":"assistant","message":{"model":"fake-model","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/x"}}]}}\n' ;; esac
  case "$text" in *SLOW*) while true; do delta "tick "; sleep 0.05; done ;; esac
  first=${text%%\\n*}
  delta "echo:"
  delta " $first"
  delta " (turn $turn, session $session)"
  printf '{"type":"assistant","message":{"model":"fake-model","content":[{"type":"text","text":"ignored duplicate"}]}}\n'
  case "$text" in
    *FAIL*) printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model exploded","total_cost_usd":0.0123,"usage":{"input_tokens":11,"output_tokens":7},"modelUsage":{"fake-model":{}},"session_id":"%s"}\n' "$session" ;;
    *) printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.0123,"usage":{"input_tokens":11,"output_tokens":7},"modelUsage":{"fake-model":{}},"session_id":"%s"}\n' "$session" ;;
  esac
done
