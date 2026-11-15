#!/usr/bin/env bash
# Test double for a detached claude turn that writes slowly and survives its parent. Never calls a model.
# FAKE_SLOW_TICKS (default 12) deltas "t0 ", "t1 " ... FAKE_SLOW_SLEEP seconds apart (default 0.1), then waits for
# the FAKE_SLOW_GATE file to exist (when set) and ends with "done" and a result line. Logs its args to FAKE_AGENT_LOG.
args=("$@")
session="fake-session"
for i in "${!args[@]}"; do
  case "${args[$i]}" in --resume|--session-id) session="${args[$((i + 1))]}" ;; esac
done
if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_AGENT_LOG"
fi
IFS= read -r line
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$session"
n=${FAKE_SLOW_TICKS:-12}
for ((i = 0; i < n; i++)); do
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"t%s "}},"session_id":"%s","parent_tool_use_id":null}\n' "$i" "$session"
  sleep "${FAKE_SLOW_SLEEP:-0.1}"
done
while [ -n "${FAKE_SLOW_GATE:-}" ] && [ ! -e "$FAKE_SLOW_GATE" ]; do sleep 0.05; done
printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}},"session_id":"%s","parent_tool_use_id":null}\n' "$session"
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"fake-model":{}},"session_id":"%s"}\n' "$session"
