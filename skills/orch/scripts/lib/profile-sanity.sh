#!/usr/bin/env bash
# Profile sanity probes — sourced by dispatch.sh, never executed.
# Runs a minimal prompt through each profile's harness and reports latency + outcome.

SANITY_PROMPT='orch sanity check: respond with exactly the word OK and nothing else.'
PROFILE_SANITY_USAGE='dispatch.sh profile sanity [--profile NAME] [--json]'

now_ms() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
    return 0
  fi
  printf '%s000\n' "$(date +%s)"
}

profile_sanity_one() {
  local name="$1" json enabled start end ms rc out err bytes model_id slug harness ok=false err_file
  json=$(profile_require "$name" 2>/dev/null) || {
    jq -nc --arg p "$name" --arg e "unknown profile" \
      '{profile: $p, ok: false, ms: 0, harness: "", model_id: "", slug: "", exit_code: 2, bytes: 0, error: $e}'
    return 0
  }
  enabled=$(printf '%s' "$json" | jq -r 'if (.enabled | type) == "boolean" then .enabled else true end')
  if [ "$enabled" = "false" ]; then
    jq -nc --arg p "$name" --arg h "$(printf '%s' "$json" | jq -r '.harness // ""')" \
      '{profile: $p, ok: false, ms: 0, harness: $h, model_id: "", slug: "", exit_code: 0, bytes: 0, error: "profile disabled"}'
    return 0
  fi
  harness=$(printf '%s' "$json" | jq -r '.harness // ""')
  model_id=$(model_id_resolve "$name")
  slug=""
  if [ -n "$model_id" ]; then
    slug=$(model_slug_resolve "$name" "$model_id")
  fi
  err=$(profile_load "$name" 2>&1) || {
    err=$(printf '%s' "$err" | tail -1)
    jq -nc --arg p "$name" --arg h "$harness" --arg mid "$model_id" --arg slug "$slug" --arg e "$err" \
      '{profile: $p, ok: false, ms: 0, harness: $h, model_id: $mid, slug: $slug, exit_code: 1, bytes: 0, error: $e}'
    return 0
  }
  err_file="$ORCH_HOME/.sanity-stderr-$$"
  : >"$err_file"
  start=$(now_ms)
  out=$(dispatch_with_profile "$name" "$SANITY_PROMPT" 2>"$err_file")
  rc=$?
  err=$(cat "$err_file" 2>/dev/null || printf '')
  : >"$err_file"
  end=$(now_ms)
  ms=$((end - start))
  bytes=$(printf '%s' "$out" | wc -c | tr -d ' ')
  [ "$rc" -eq 0 ] && ok=true
  jq -nc \
    --arg p "$name" --argjson ok "$ok" \
    --argjson ms "$ms" --arg h "$harness" --arg mid "$model_id" --arg slug "$slug" \
    --argjson exit_code "$rc" --argjson bytes "$bytes" --arg e "$err" \
    '{profile: $p, ok: $ok, ms: $ms, harness: $h, model_id: $mid, slug: $slug,
      exit_code: $exit_code, bytes: $bytes, error: $e}'
}

cmd_profile_sanity() {
  local -a names=() n as_json=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; [ -n "${1:-}" ] && names+=("$1") ;;
      --json) as_json=1 ;;
      *) printf 'profile sanity: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "profile sanity"
  ensure_home || return 1
  if [ "${#names[@]}" -eq 0 ]; then
    while IFS= read -r n; do
      [ -n "$n" ] && names+=("$n")
    done <<EOF
$(jq -r '.profiles | keys[]' "$PROFILES_FILE")
EOF
  fi
  local results="[]" row
  for n in "${names[@]}"; do
    row=$(profile_sanity_one "$n")
    results=$(jq -c --argjson r "$row" '. + [$r]' <<<"$results")
  done
  if [ "$as_json" -eq 1 ]; then
    jq -nc --arg ts "$(now_iso)" --argjson results "$results" '{generated_at: $ts, results: $results}'
    return 0
  fi
  printf '%s\n' "$results"
}
