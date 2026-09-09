#!/usr/bin/env bash
# Harness registry + live availability probes — sourced by dispatch.sh, never executed.

HARNESS_LIST_USAGE='dispatch.sh harness list [--json]'

# Extra CLIs probed for the dashboard; not orch adapters until wired in adapters.sh.
DETECTED_CLI_IDS="pi codex aider gemini"

harness_ids() {
  printf '%s\n' $VALID_HARNESSES
}

# Resolves a binary: PATH first, then common install dirs (service PATH is often minimal).
# Directories searched when a CLI is not on PATH — a supervisor (launchd/systemd) starts with a
# minimal PATH that omits every one of them. Set ORCH_BIN_DIRS to "" to search PATH only.
harness_bin_dirs() {
  if [ -n "${ORCH_BIN_DIRS+x}" ]; then
    printf '%s\n' "$ORCH_BIN_DIRS" | tr ':' '\n'
    return 0
  fi
  printf '%s\n' \
    "${HOME:-}/.local/bin" \
    "${HOME:-}/bin" \
    "${HOME:-}/.cargo/bin" \
    "${HOME:-}/.bun/bin" \
    "${HOME:-}/.opencode/bin" \
    /opt/homebrew/bin \
    /usr/local/bin
}

harness_find_binary() {
  local name="$1" dir
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ -x "$dir/$name" ] && printf '%s/%s\n' "$dir" "$name" && return 0
  done <<EOF
$(harness_bin_dirs)
EOF
  return 1
}

harness_probe_available() {
  local id="$1"
  case "$id" in
    claude|cursor-agent|opencode|pi|codex|aider|gemini)
      harness_find_binary "$id" >/dev/null 2>&1
      ;;
    local-llm) [ -n "${LLM_HUB_URL:-}" ] ;;
    *) return 1 ;;
  esac
}

harness_probe_reason() {
  local id="$1" hint=""
  case "$id" in
    claude)
      harness_find_binary claude >/dev/null 2>&1 && printf '' && return 0
      hint="install the claude CLI (often ~/.local/bin/claude)"
      ;;
    cursor-agent)
      harness_find_binary cursor-agent >/dev/null 2>&1 && printf '' && return 0
      hint="install cursor-agent (often ~/.local/bin/cursor-agent)"
      ;;
    opencode)
      harness_find_binary opencode >/dev/null 2>&1 && printf '' && return 0
      hint="install opencode and ensure it is on PATH"
      ;;
    pi)
      harness_find_binary pi >/dev/null 2>&1 && printf '' && return 0
      hint="install pi (mariozechner/pi) — not wired as an orch adapter yet"
      ;;
    codex)
      harness_find_binary codex >/dev/null 2>&1 && printf '' && return 0
      hint="install the codex CLI — not wired as an orch adapter yet"
      ;;
    aider)
      harness_find_binary aider >/dev/null 2>&1 && printf '' && return 0
      hint="install aider — not wired as an orch adapter yet"
      ;;
    gemini)
      harness_find_binary gemini >/dev/null 2>&1 && printf '' && return 0
      hint="install the gemini CLI — not wired as an orch adapter yet"
      ;;
    local-llm)
      [ -n "${LLM_HUB_URL:-}" ] && printf '' && return 0
      hint="set LLM_HUB_URL to an OpenAI-compatible /chat/completions base URL"
      ;;
    *) printf 'unknown harness' ; return 0 ;;
  esac
  printf '%s' "$hint"
}

cmd_harness() {
  local sub="${1:-}"
  case "$sub" in
    list) shift; harness_list "$@" ;;
    *)
      printf 'usage: %s\n' "$HARNESS_LIST_USAGE" >&2
      return 2
      ;;
  esac
}

harness_list() {
  local json_flag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json_flag=1 ;;
      *) printf 'harness list: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "harness list"
  ensure_home || return 1

  local probed_at ids json id avail reason enriched all_ids
  probed_at=$(now_iso)
  ids=$(harness_ids)
  all_ids=$( { harness_ids; printf '%s\n' $DETECTED_CLI_IDS; } | awk 'NF && !seen[$0]++')
  json=$(jq -n --arg probed "$probed_at" --slurpfile prof "$PROFILES_FILE" --arg ids "$all_ids" '
    def meta($id):
      if $id == "claude" then {kind:"cli", binary:"claude", wired:true, description:"Anthropic Claude Code CLI (headless -p).", needs:[]}
      elif $id == "cursor-agent" then {kind:"cli", binary:"cursor-agent", wired:true, description:"Cursor agent CLI for in-editor tasks.", needs:["CURSOR_API_KEY on profile"]}
      elif $id == "opencode" then {kind:"cli", binary:"opencode", wired:true, description:"OpenCode CLI agent loop.", needs:[]}
      elif $id == "local-llm" then {kind:"http", binary:null, wired:true, description:"OpenAI-compatible HTTP chat API via curl.", needs:["LLM_HUB_URL"]}
      elif $id == "pi" then {kind:"cli", binary:"pi", wired:false, description:"pi coding agent CLI.", needs:[]}
      elif $id == "codex" then {kind:"cli", binary:"codex", wired:false, description:"OpenAI Codex CLI.", needs:[]}
      elif $id == "aider" then {kind:"cli", binary:"aider", wired:false, description:"Aider pair-programming CLI.", needs:[]}
      elif $id == "gemini" then {kind:"cli", binary:"gemini", wired:false, description:"Google Gemini CLI.", needs:[]}
      else {kind:"cli", binary:null, wired:false, description:"", needs:[]}
      end;
    def disabled: ($prof[0].settings.disabled_harnesses // []);
    ($ids | split("\n") | map(select(length > 0))) as $list |
    {probed_at: $probed, harnesses: [
      $list[] | . as $id | meta($id) as $m | {
        id: $id,
        kind: $m.kind,
        binary: $m.binary,
        wired: $m.wired,
        description: $m.description,
        needs: $m.needs,
        enabled: (if $m.wired then ((disabled | index($id)) == null) else true end),
        available: false,
        reason: ""
      }
    ]}
  ')

  while read -r id; do
    [ -n "$id" ] || continue
    if harness_probe_available "$id"; then
      avail=1
      reason=""
    else
      avail=0
      reason=$(harness_probe_reason "$id")
    fi
    enriched=$(printf '%s' "$json" | jq --arg id "$id" --argjson avail "$avail" --arg reason "$reason" '
      .harnesses = [.harnesses[] |
        if .id == $id then .available = ($avail == 1) | .reason = (if $avail == 1 then "" else $reason end)
        else . end]
    ')
    json="$enriched"
  done <<EOF
$all_ids
EOF

  if [ "$json_flag" -eq 1 ]; then
    printf '%s\n' "$json"
    return 0
  fi
  printf '%s\n' "$json" | jq -r '.harnesses[] | [.id, .kind, (if .available then "ok" else "missing" end), (if .enabled then "on" else "off" end)] | @tsv'
}
