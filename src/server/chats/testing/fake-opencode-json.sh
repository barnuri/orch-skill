#!/usr/bin/env bash
# Test double for `opencode run --format json --auto [--session <id>] [-m <model>] [-f <file>]... <prompt>`.
# One file per session in $FAKE_STATE; replies "turns=N" in one text part, then a step_finish. Event shape from opencode 2.3.0 run.ts:
# {type,timestamp,sessionID,part|error}. A missing --session id is created (as the real CLI does) unless FAKE_REJECT_UNKNOWN=1.
# Never calls a model.
state=${FAKE_STATE:?}
mkdir -p "$state"
# `serve` (only when FAKE_SERVE=1, else it fails like a CLI without the command): records its pid, prints the
# listening line opencode 2.x prints, then answers HTTP on a free port until killed (bun). Each start appends to
# $state/serve.pids.
if [ "$1" = serve ] && [ "${FAKE_SERVE:-}" = 1 ]; then
  echo $$ >> "$state/serve.pids"
  exec "${FAKE_BUN:-bun}" -e 'const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") }); console.log(`server listening on http://127.0.0.1:${s.port}`); setTimeout(() => process.exit(0), 600_000);'
fi
[ "$1" = run ] || exit 2
shift
sid=""; prompt=""; mode=standalone; files=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) sid=$2; shift ;;
    --server) mode="server:$2:${OPENCODE_SERVER_PASSWORD:+pw}"; shift ;;
    --standalone) mode=standalone ;;
    --format|-m) shift ;;
    -f|--file) files="$files${files:+,}$2"; shift ;;
    --auto) ;;
    *) prompt=$1 ;;
  esac
  shift
done
case $mode in
  server:*)
    if [ "${FAKE_SERVER_DOWN:-}" = 1 ]; then
      printf '{"type":"error","timestamp":1,"sessionID":"","error":{"type":"unknown","message":"Could not reach server at http://127.0.0.1:1: ECONNREFUSED: Unable to connect."}}\n'
      exit 1
    fi ;;
esac
if [ -n "$sid" ]; then
  if [ ! -f "$state/$sid" ]; then
    if [ "${FAKE_REJECT_UNKNOWN:-}" = 1 ]; then
      printf '{"type":"error","timestamp":1,"sessionID":"%s","error":{"type":"unknown","message":"Session not found: %s"}}\n' "$sid" "$sid"
      exit 1
    fi
    : > "$state/$sid"
  fi
else
  sid="ses_$(date +%s)$RANDOM"; : > "$state/$sid"
fi
printf '@@@\n%s\n' "$prompt" >> "$state/$sid"
[ -z "${FAKE_AGENT_LOG:-}" ] || printf 'opencode\t%s\t%s\t%s\t%s\n' "$sid" "$prompt" "$mode" "$files" >> "$FAKE_AGENT_LOG"
n=$(grep -c '^@@@$' "$state/$sid")
ts=1700000000000
printf '{"type":"step_start","timestamp":%s,"sessionID":"%s","part":{"id":"prt_1","sessionID":"%s","messageID":"msg_1","type":"step-start"}}\n' "$ts" "$sid" "$sid"
printf '{"type":"tool_use","timestamp":%s,"sessionID":"%s","part":{"partID":"prt_2","sessionID":"%s","messageID":"msg_1","type":"tool","id":"call_1","tool":"bash","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\n","title":"bash","metadata":{},"time":{"start":1,"end":2}}}}\n' "$ts" "$sid" "$sid"
# FAKE_SLOW_SECONDS: print a first text part, then wait before the rest (a long reply).
if [ -n "${FAKE_SLOW_SECONDS:-}" ]; then
  printf '{"type":"text","timestamp":%s,"sessionID":"%s","part":{"id":"prt_0","sessionID":"%s","messageID":"msg_1","type":"text","text":"slow:","time":{"start":1,"end":2}}}\n' "$ts" "$sid" "$sid"
  sleep "$FAKE_SLOW_SECONDS"
fi
printf '{"type":"text","timestamp":%s,"sessionID":"%s","part":{"id":"prt_3","sessionID":"%s","messageID":"msg_1","type":"text","text":"turns=%s","time":{"start":1,"end":2}}}\n' "$ts" "$sid" "$sid" "$n"
printf '{"type":"step_finish","timestamp":%s,"sessionID":"%s","part":{"id":"prt_4","sessionID":"%s","messageID":"msg_1","type":"step-finish","reason":"stop","cost":0.002,"tokens":{"total":14,"input":11,"output":3,"reasoning":0,"cache":{"write":0,"read":0}}}}\n' "$ts" "$sid" "$sid"
