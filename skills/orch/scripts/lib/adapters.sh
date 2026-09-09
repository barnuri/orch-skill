#!/usr/bin/env bash
# Harness adapters for dispatch.sh — sourced, never executed. One function per target harness,
# all sharing the contract in ../../references/adapter-contract.md:
#   adapter_<name> <prompt> [adapter-specific args...]   stdout = result, stderr = diagnostics,
#   exit = underlying CLI/request code (127 = required binary missing, 1 = request failed).

# @file-prefixed prompts are read from disk; anything else is passed through literally.
resolve_prompt() {
  case "$1" in
    @*)
      local f="${1#@}"
      if [ ! -f "$f" ]; then
        printf 'resolve_prompt: prompt file not found: %s\n' "$f" >&2
        return 1
      fi
      cat "$f"
      ;;
    *) printf '%s' "$1" ;;
  esac
}

# require_bin <caller> <binary>: 127 + a uniform message when a required tool is missing.
# For plain PATH tools (curl, jq) — harness CLIs go through resolve_bin instead.
require_bin() {
  command -v "$2" >/dev/null 2>&1 && return 0
  printf '%s: %s not found on PATH\n' "$1" "$2" >&2
  return 127
}

# resolve_bin <caller> <binary>: prints the absolute path to a harness CLI, or 127 + the same
# message require_bin would print. Goes through harness_find_binary so a CLI installed in
# ~/.local/bin runs under a supervisor's minimal PATH (launchd/systemd) — otherwise `harness
# list` reports "ready" from the wider search while every dispatch fails "not found on PATH".
resolve_bin() {
  local path
  if path=$(harness_find_binary "$2" 2>/dev/null) && [ -n "$path" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  printf '%s: %s not found on PATH\n' "$1" "$2" >&2
  return 127
}

adapter_claude_native() {
  printf 'claude-native: no subprocess spawned; do this work directly in the current session\n'
  return 0
}

# ORCH_SESSION_ID is set by `start`, so the job's session is addressable afterwards. Only this
# adapter takes it: cursor-agent resumes by a chatId minted by its own `create-chat`, not by an
# id we can choose, so orch does not pretend to control it.
adapter_claude() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_claude claude) || return $?
  local -a session_args=()
  [ -n "${ORCH_SESSION_ID:-}" ] && session_args=(--session-id "$ORCH_SESSION_ID")
  "$bin" -p "$prompt" --output-format text ${session_args[@]+"${session_args[@]}"} "$@"
}

adapter_cursor_agent() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_cursor_agent cursor-agent) || return $?
  "$bin" -p "$prompt" --output-format text --force "$@"
}

adapter_opencode() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_opencode opencode) || return $?
  "$bin" run "$prompt" --auto "$@"
}

adapter_local_llm() {
  local prompt="$1"; shift || true
  if [ -z "${LLM_HUB_URL:-}" ]; then
    printf 'adapter_local_llm: LLM_HUB_URL not set\n' >&2
    return 1
  fi
  require_bin adapter_local_llm curl || return $?
  require_bin adapter_local_llm jq || return $?

  local model payload response
  model="${LLM_HUB_MODEL:-local-model}"
  payload=$(jq -n --arg model "$model" --arg prompt "$prompt" \
    '{model: $model, messages: [{role: "user", content: $prompt}], stream: false}')
  response=$(curl -sS --max-time "${LLM_HUB_TIMEOUT:-120}" \
    -H 'Content-Type: application/json' -d "$payload" "$LLM_HUB_URL/chat/completions") \
    || { printf 'adapter_local_llm: request to %s failed\n' "$LLM_HUB_URL" >&2; return 1; }
  printf '%s\n' "$response" | jq -r '.choices[0].message.content // .error // empty'
}

# adapter_claude_native is a sentinel, not a real dispatch path — SKILL.md special-cases the
# claude-native classification before ever calling run/start. It exists so a caller scripting
# against dispatch.sh directly (bypassing SKILL.md) gets defined behavior, not an unhandled case.
adapter_dispatch() {
  local adapter="$1" prompt="$2"
  shift 2 || true
  case "$adapter" in
    claude-native) adapter_claude_native "$prompt" "$@" ;;
    claude)        adapter_claude "$prompt" "$@" ;;
    cursor-agent)  adapter_cursor_agent "$prompt" "$@" ;;
    local-llm)     adapter_local_llm "$prompt" "$@" ;;
    opencode)      adapter_opencode "$prompt" "$@" ;;
    *) printf 'adapter_dispatch: unknown adapter "%s"\n' "$adapter" >&2; return 2 ;;
  esac
}

# Resolves a profile (exporting its env), then runs its harness with: the model flag that harness
# expects (skipped when the profile has no model), the profile's own flags, then caller args.
# `${arr[@]+"${arr[@]}"}` is the bash 3.2 idiom for expanding a possibly-empty array under set -u.
dispatch_with_profile() {
  local profile="$1" prompt="$2"
  shift 2 || true
  profile_load "$profile" || return $?

  local -a model_args=()
  if [ -n "$PROFILE_MODEL" ]; then
    case "$PROFILE_HARNESS" in
      claude|cursor-agent) model_args=(--model "$PROFILE_MODEL") ;;
      opencode)            model_args=(-m "$PROFILE_MODEL") ;;
      local-llm)           export LLM_HUB_MODEL="$PROFILE_MODEL" ;;
    esac
  fi
  adapter_dispatch "$PROFILE_HARNESS" "$prompt" \
    ${model_args[@]+"${model_args[@]}"} ${PROFILE_FLAGS[@]+"${PROFILE_FLAGS[@]}"} "$@"
}
