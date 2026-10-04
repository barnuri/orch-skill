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

# Claude Code refuses a --model it does not recognise, which is every gateway-namespaced id
# ("llama_swap/lfm2.5-8b-a1b" and the like). Its own error names the way out: map the id onto a
# known model with `behavesAs` on a modelPicker row. That row is written to a throwaway settings
# file and passed with --settings, which the CLI honours for this invocation only — the user's
# own settings.json is never touched, and defining modelPicker there would replace their whole
# /model list.
claude_model_settings_file() {
  local model="$1" behaves_as="$2" file
  # BSD mktemp requires the XXXXXX run at the very end of the template — a trailing suffix
  # makes it fail outright, which silently dropped the mapping.
  file=$(mktemp "${TMPDIR:-/tmp}/orch-model-picker-XXXXXX") || return 1
  jq -nc --arg m "$model" --arg b "$behaves_as" \
    '{modelPicker: {options: [{model: $m, label: $m, behavesAs: $b}]}}' > "$file" || return 1
  printf '%s\n' "$file"
}

# ORCH_SESSION_ID is set by `start`, so the job's session is addressable afterwards. Only this
# adapter takes it: cursor-agent resumes by a chatId minted by its own `create-chat`, not by an
# id we can choose, so orch does not pretend to control it.
# Reshapes one `--output-format json` object into the node-cost sidecar. Every field is defaulted:
# a harness that stops reporting one of them must not produce a sidecar `run sync` cannot read.
CLAUDE_USAGE_FILTER='{
  usd: (.total_cost_usd // 0),
  cost_basis: (((.modelUsage // {}) | to_entries | map(.value.costBasis) | map(select(. != null)) | first) // "unknown"),
  input_tokens: (.usage.input_tokens // 0),
  output_tokens: (.usage.output_tokens // 0),
  cache_read_tokens: (.usage.cache_read_input_tokens // 0),
  cache_creation_tokens: (.usage.cache_creation_input_tokens // 0),
  models: ((.modelUsage // {}) | to_entries | map({
    model: .key,
    usd: (.value.costUSD // 0),
    input_tokens: (.value.inputTokens // 0),
    output_tokens: (.value.outputTokens // 0),
    cache_read_tokens: (.value.cacheReadInputTokens // 0),
    cache_creation_tokens: (.value.cacheCreationInputTokens // 0)
  }))
}'

# Writes the cost sidecar beside the job log, when this dispatch has a job dir to write into
# (`start` does, `run` does not). Never fails the dispatch: the work is already done and its
# output already printed, so a sidecar that cannot be written is only a missing metric.
claude_write_usage() {
  local raw="$1" dir="${ORCH_JOB_DIR:-}"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  printf '%s' "$raw" | jq -c "$CLAUDE_USAGE_FILTER" > "$dir/usage.json.tmp" 2>/dev/null \
    && mv "$dir/usage.json.tmp" "$dir/usage.json" 2>/dev/null
  return 0
}

# ORCH_SESSION_ID is set by `start`, so the job's session is addressable afterwards. Only this
# adapter takes it: cursor-agent resumes by a chatId minted by its own `create-chat`, not by an
# id we can choose, so orch does not pretend to control it.
#
# `--output-format json` rather than text, because only the JSON form reports the token counts and
# the dollar cost. Its stdout is this job's log, so just the `result` string is printed — the same
# bytes the text form would have produced — and the usage goes to the sidecar. Without jq there is
# nothing to parse it with, so the text form runs unchanged and the node simply has no cost.
adapter_claude() {
  local prompt="$1"; shift || true
  local bin settings
  bin=$(resolve_bin adapter_claude claude) || return $?
  local -a session_args=() settings_args=()
  if [ -n "${ORCH_RESUME_SESSION:-}" ]; then
    session_args=(--resume "$ORCH_RESUME_SESSION")
  elif [ -n "${ORCH_SESSION_ID:-}" ]; then
    session_args=(--session-id "$ORCH_SESSION_ID")
  fi
  if [ -n "${ORCH_MODEL_BEHAVES_AS:-}" ] && [ -n "${ORCH_MODEL_SLUG:-}" ]; then
    settings=$(claude_model_settings_file "$ORCH_MODEL_SLUG" "$ORCH_MODEL_BEHAVES_AS") \
      && settings_args=(--settings "$settings")
  fi
  if ! command -v jq >/dev/null 2>&1; then
    "$bin" -p "$prompt" --output-format text \
      ${session_args[@]+"${session_args[@]}"} ${settings_args[@]+"${settings_args[@]}"} "$@" </dev/null
    return $?
  fi

  local raw rc
  raw=$("$bin" -p "$prompt" --output-format json \
    ${session_args[@]+"${session_args[@]}"} ${settings_args[@]+"${settings_args[@]}"} "$@" </dev/null)
  rc=$?
  # A failed call, or output that is not the expected object: pass the bytes through untouched so
  # the log still holds whatever the harness said, and keep its exit code.
  if [ "$rc" -ne 0 ] || ! printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
    printf '%s\n' "$raw"
    return "$rc"
  fi
  printf '%s\n' "$(printf '%s' "$raw" | jq -r '.result // ""')"
  claude_write_usage "$raw"
  # The harness can report a failure inside a zero exit; the node should show it as an error.
  printf '%s' "$raw" | jq -e '.is_error != true' >/dev/null 2>&1 || return 1
  return 0
}

# `--force` ("Run Everything") is deliberately NOT passed here. It is a permission bypass, and
# whether it is even allowed is an org policy — a Cursor team admin can disable it, in which case
# cursor-agent refuses the whole invocation and every dispatch fails. Profiles that want it list
# it in `flags`, the same way the claude profiles carry --dangerously-skip-permissions.
adapter_cursor_agent() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_cursor_agent cursor-agent) || return $?
  local -a session_args=()
  [ -n "${ORCH_RESUME_SESSION:-}" ] && session_args=(--resume "$ORCH_RESUME_SESSION")
  "$bin" -p "$prompt" --output-format text ${session_args[@]+"${session_args[@]}"} "$@" </dev/null
}

adapter_opencode() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_opencode opencode) || return $?
  local -a session_args=()
  [ -n "${ORCH_RESUME_SESSION:-}" ] && session_args=(--session "$ORCH_RESUME_SESSION")
  "$bin" run "$prompt" --auto ${session_args[@]+"${session_args[@]}"} "$@"
}

# `--allow-all-tools` is deliberately NOT passed here — same reasoning as cursor-agent's
# `--force` above: it is a permission bypass ("required for non-interactive mode" per `copilot
# --help`, but still a bypass an org policy could restrict), so profiles that want it list it in
# `flags`, the same way the claude profiles carry --dangerously-skip-permissions. `--silent`
# drops the stats footer so stdout is just the agent's answer, matching the contract's "stdout =
# result" every other adapter follows. ORCH_SESSION_ID is set by `start`, so the job's session is
# addressable afterwards, same as the claude adapter — `copilot --session-id` accepts either a
# fresh UUID (mints that session) or an existing one (resumes it).
adapter_copilot() {
  local prompt="$1"; shift || true
  local bin
  bin=$(resolve_bin adapter_copilot copilot) || return $?
  local -a session_args=()
  if [ -n "${ORCH_RESUME_SESSION:-}" ]; then
    session_args=(--session-id "$ORCH_RESUME_SESSION")
  elif [ -n "${ORCH_SESSION_ID:-}" ]; then
    session_args=(--session-id "$ORCH_SESSION_ID")
  fi
  "$bin" -p "$prompt" --silent ${session_args[@]+"${session_args[@]}"} "$@" </dev/null
}

# pi only reaches llm-hub through a provider defined in its models.json, and that file lives in
# its agent dir. So each dispatch gets a private agent dir (PI_CODING_AGENT_DIR) holding a
# models.json with the hub as provider "hub" — the user's own models.json is never touched. Every
# other entry of the user's agent dir (skills, extensions, settings, AGENTS.md, auth) is linked
# in, so the run still sees them; a profile that wants a bare run lists --no-skills and friends
# in `flags`. The key is written as the `$LLM_HUB_KEY` reference pi resolves itself, never as
# its value, so no secret lands on disk.
PI_HUB_PROVIDER=hub
# shellcheck disable=SC2016  # a jq program: its $vars are jq's, not bash's
PI_MODELS_FILTER='{providers: {($provider): {
  baseUrl: $url,
  api: "openai-completions",
  apiKey: $key,
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
    requiresToolResultName: true
  },
  models: [{
    id: $model,
    name: $model,
    reasoning: false,
    input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 131072,
    maxTokens: 32768
  }]
}}}'

# pi_agent_dir <model>: prints a fresh private agent dir. Under the job dir when this dispatch has
# one (`start`), so it is pruned with the job and the exact models.json stays inspectable;
# otherwise a temp dir the caller removes.
pi_agent_dir() {
  local model="$1" dir user_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" entry key_ref
  if [ -n "${ORCH_JOB_DIR:-}" ] && [ -d "$ORCH_JOB_DIR" ]; then
    dir="$ORCH_JOB_DIR/pi-agent"
    mkdir -p "$dir" || return 1
  else
    dir=$(mktemp -d "${TMPDIR:-/tmp}/orch-pi-agent-XXXXXX") || return 1
  fi
  if [ -d "$user_dir" ]; then
    for entry in "$user_dir"/* "$user_dir"/.[!.]*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      [ "${entry##*/}" = models.json ] && continue
      ln -sfn "$entry" "$dir/${entry##*/}" || return 1
    done
  fi
  key_ref='llm-hub'
  # shellcheck disable=SC2016  # the literal reference is the point: pi expands it, not bash
  [ -n "${LLM_HUB_KEY:-}" ] && key_ref='$LLM_HUB_KEY'
  jq -n --arg provider "$PI_HUB_PROVIDER" --arg url "$LLM_HUB_V1_URL" --arg key "$key_ref" \
    --arg model "$model" "$PI_MODELS_FILTER" > "$dir/models.json" || return 1
  printf '%s\n' "$dir"
}

# The model comes from LLM_HUB_MODEL, which dispatch_with_profile sets from the profile — the
# same channel local-llm uses — and is selected as hub/<model>. --no-session: a headless one-shot
# has no conversation to come back to, so pi does not resume either.
adapter_pi() {
  local prompt="$1"; shift || true
  local bin dir model rc
  bin=$(resolve_bin adapter_pi pi) || return $?
  orch_load_env_file
  llm_hub_derive_v1_url
  if [ -z "${LLM_HUB_V1_URL:-}" ]; then
    printf 'adapter_pi: LLM_HUB_URL not set (or set LLM_HUB_V1_URL directly)\n' >&2
    return 1
  fi
  model="${LLM_HUB_MODEL:-}"
  if [ -z "$model" ]; then
    printf 'adapter_pi: no model — give the profile a model or set LLM_HUB_MODEL\n' >&2
    return 2
  fi
  require_bin adapter_pi jq || return $?
  dir=$(pi_agent_dir "$model") \
    || { printf 'adapter_pi: cannot prepare the pi agent dir\n' >&2; return 1; }

  PI_CODING_AGENT_DIR="$dir" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
    "$bin" --model "$PI_HUB_PROVIDER/$model" --approve --no-session -p "$prompt" "$@" </dev/null
  rc=$?
  [ -n "${ORCH_JOB_DIR:-}" ] && [ "$dir" = "$ORCH_JOB_DIR/pi-agent" ] || recoverable_remove "$dir"
  return "$rc"
}

adapter_local_llm() {
  local prompt="$1"; shift || true
  orch_load_env_file
  llm_hub_derive_v1_url
  if [ -z "${LLM_HUB_V1_URL:-}" ]; then
    printf 'adapter_local_llm: LLM_HUB_URL not set (or set LLM_HUB_V1_URL directly)\n' >&2
    return 1
  fi
  require_bin adapter_local_llm curl || return $?
  require_bin adapter_local_llm jq || return $?

  local model payload response
  model="${LLM_HUB_MODEL:-local-model}"
  payload=$(jq -n --arg model "$model" --arg prompt "$prompt" \
    '{model: $model, messages: [{role: "user", content: $prompt}], stream: false}')
  response=$(curl -sS --max-time "${LLM_HUB_TIMEOUT:-120}" \
    -H 'Content-Type: application/json' -d "$payload" "$LLM_HUB_V1_URL/chat/completions") \
    || { printf 'adapter_local_llm: request to %s failed\n' "$LLM_HUB_V1_URL" >&2; return 1; }
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
    copilot)       adapter_copilot "$prompt" "$@" ;;
    pi)            adapter_pi "$prompt" "$@" ;;
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
  if [ -n "${PROFILE_MODEL_BEHAVES_AS:-}" ]; then
    export ORCH_MODEL_BEHAVES_AS="$PROFILE_MODEL_BEHAVES_AS" ORCH_MODEL_SLUG="$PROFILE_MODEL"
  fi
  if [ -n "$PROFILE_MODEL" ]; then
    case "$PROFILE_HARNESS" in
      claude|cursor-agent|copilot) model_args=(--model "$PROFILE_MODEL") ;;
      opencode)            model_args=(-m "$PROFILE_MODEL") ;;
      local-llm|pi)        export LLM_HUB_MODEL="$PROFILE_MODEL" ;;
    esac
  fi
  adapter_dispatch "$PROFILE_HARNESS" "$prompt" \
    ${model_args[@]+"${model_args[@]}"} ${PROFILE_FLAGS[@]+"${PROFILE_FLAGS[@]}"} "$@"
}
