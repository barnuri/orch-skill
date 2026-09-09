#!/usr/bin/env bash
# Suggestions + learning loop for orch — sourced by dispatch.sh, never executed.

VALID_SUGGESTION_KINDS="memory_record profile_description model_description profile_tags routing_hint"
SUGGEST_SCAN_USAGE='dispatch.sh suggest scan'
SUGGEST_LIST_USAGE='dispatch.sh suggest list [--pending]'
SUGGEST_APPLY_USAGE='dispatch.sh suggest apply <id> | apply --all | apply --id ID [--id ID...] [--json]'
SUGGEST_DISMISS_USAGE='dispatch.sh suggest dismiss <id>'
SYNC_USAGE='dispatch.sh sync [--no-serve]'

learning_get() {
  local key="$1" default="$2"
  setting_get "learning.$key" "$default"
}

suggest_ensure() {
  suggestions_seed || return 1
  jq -e '.suggestions' "$SUGGESTIONS_FILE" >/dev/null 2>&1 || {
    printf '{"generated_at":"%s","suggestions":[]}\n' "$(now_iso)" > "$SUGGESTIONS_FILE"
  }
}

suggest_new_id() {
  printf 'sug-%04x\n' $((RANDOM % 65536))
}

# Upsert by fingerprint; returns 0 if added/updated.
suggest_upsert() {
  local json="$1" fingerprint
  fingerprint=$(printf '%s' "$json" | jq -r '.fingerprint')
  local tmp="$SUGGESTIONS_FILE.tmp.$$"
  if ! jq --argjson s "$json" --arg fp "$fingerprint" --arg now "$(now_iso)" '
    .generated_at = $now
    | if any(.suggestions[]?; .fingerprint == $fp and .status == "pending") then
        .suggestions |= map(if .fingerprint == $fp and .status == "pending" then $s else . end)
      elif any(.suggestions[]?; .fingerprint == $fp and (.status == "dismissed" or .status == "expired")) then
        .
      else
        .suggestions += [$s]
      end
  ' "$SUGGESTIONS_FILE" > "$tmp"; then
    return 1
  fi
  mv -f "$tmp" "$SUGGESTIONS_FILE"
}

suggest_expire_stale() {
  local ttl days cutoff now_epoch created_epoch tmp
  ttl=$(learning_get dismiss_ttl_days 30)
  is_uint "$ttl" || ttl=30
  cutoff=$((ttl * 86400))
  now_epoch=$(date -u +%s)
  tmp="$SUGGESTIONS_FILE.tmp.$$"
  if ! jq -c '.suggestions[]? | select(.status == "pending") | [.id, .created] | @tsv' "$SUGGESTIONS_FILE" 2>/dev/null \
    | while IFS=$'\t' read -r id created; do
        [ -n "$id" ] || continue
        created_epoch=$(to_epoch_iso "$created" 2>/dev/null) || continue
        if [ "$((now_epoch - created_epoch))" -ge "$cutoff" ]; then
          printf '%s\n' "$id"
        fi
      done > "$tmp.ids"; then
    return 0
  fi
  [ -f "$tmp.ids" ] || return 0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    jq --arg id "$id" '.suggestions |= map(if .id == $id and .status == "pending" then .status = "expired" else . end)' \
      "$SUGGESTIONS_FILE" > "$tmp" && mv -f "$tmp" "$SUGGESTIONS_FILE"
  done < "$tmp.ids"
  rm -f "$tmp.ids"
}

suggest_scan_memory_gaps() {
  local run_id="$1" file outcome profile model_id kind note
  file=$(run_state_file "$run_id" 2>/dev/null) || return 0
  [ -f "$file" ] || return 0
  while IFS=$'\t' read -r node_id label status profile model_id; do
    [ -n "$node_id" ] || continue
    case "$status" in
      done) outcome="success" ;;
      error) outcome="failure" ;;
      *) continue ;;
    esac
    [ -n "$profile" ] || continue
    kind=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | cut -c1-32)
    if jq -e --arg p "$profile" --arg k "$kind" '
      any(.[]; .profile == $p and (.task_kind // "") == $k and .outcome == "success")
    ' "$MEMORY_FILE" >/dev/null 2>&1; then
      continue
    fi
    note="from run $run_id node $node_id"
    model_id=$(model_id_resolve "$profile")
    suggest_upsert "$(jq -nc \
      --arg id "$(suggest_new_id)" --arg ts "$(now_iso)" --arg profile "$profile" \
      --arg outcome "$outcome" --arg kind "$kind" --arg note "$note" --arg model_id "$model_id" \
      --arg run_id "$run_id" --arg node "$node_id" \
      '{
        id: $id, status: "pending", created: $ts, confidence: "medium",
        kind: "memory_record", title: ("Record memory: " + $profile + " / " + $kind),
        reason: ("Finished node has no matching memory row for this kind."),
        evidence: [{type: "run", id: $run_id, node: $node}],
        action: {type: "memory_record", memory: {profile: $profile, outcome: $outcome, task_kind: $kind, note: $note, model_id: $model_id}},
        fingerprint: ("memory_record:" + $profile + ":" + $kind)
      }')"
  done <<EOF
$(jq -r '.nodes[] | [.id, .label, .status, (.profile // ""), ""] | @tsv' "$file")
EOF
}

suggest_generate_profile_description() {
  local name="$1"
  jq -r --arg n "$name" '
    .profiles[$n] as $p
    | if $p == null then empty
      else
        [
          ($p.harness // "agent") + " profile",
          (if ($p.model // "") != "" then "model " + $p.model else empty end),
          (if ($p.cost // "") != "" then $p.cost + " tier" else empty end),
          (if ($p.quality // "") != "" then $p.quality + " quality" else empty end),
          (if (($p.strengths // []) | length) > 0 then "strengths: " + ($p.strengths | join(", ")) else empty end)
        ] | map(select(. != "" and . != null)) | join("; ")
      end
  ' "$PROFILES_FILE"
}

suggest_generate_model_description() {
  local model_id="$1"
  jq -r --arg m "$model_id" '
    .models[$m] as $mod
    | if $mod == null then empty
      else
        [
          ($mod.slug // $m) + " on " + (($mod.harnesses // []) | join("/")),
          (if ($mod.cost // "") != "" then $mod.cost + " cost" else empty end),
          (if ($mod.quality // "") != "" then $mod.quality + " quality" else empty end),
          (if ($mod.speed // "") != "" then $mod.speed + " speed" else empty end)
        ] | map(select(. != "" and . != null)) | join("; ")
      end
  ' "$PROFILES_FILE"
}

suggest_scan_descriptions() {
  local name desc mid text
  while IFS=$'\t' read -r name desc; do
    [ -n "$name" ] || continue
    [ -n "$desc" ] && continue
    text=$(suggest_generate_profile_description "$name")
    [ -n "$text" ] || continue
    suggest_upsert "$(jq -nc --arg id "$(suggest_new_id)" --arg ts "$(now_iso)" --arg profile "$name" --arg text "$text" \
      '{
        id: $id, status: "pending", created: $ts, confidence: "low",
        kind: "profile_description", title: ("Auto description for " + $profile),
        reason: "Empty profile description — apply to seed routing metadata.",
        evidence: [{type: "profile", id: $profile}],
        action: {type: "profile_description", profile: $profile, description: $text},
        fingerprint: ("profile_description:" + $profile)
      }')"
  done <<EOF
$(jq -r '.profiles | to_entries[] | [.key, (.value.description // "")] | @tsv' "$PROFILES_FILE")
EOF

  while IFS=$'\t' read -r mid desc; do
    [ -n "$mid" ] || continue
    [ -n "$desc" ] && continue
    text=$(suggest_generate_model_description "$mid")
    [ -n "$text" ] || continue
    suggest_upsert "$(jq -nc --arg id "$(suggest_new_id)" --arg ts "$(now_iso)" --arg model "$mid" --arg text "$text" \
      '{
        id: $id, status: "pending", created: $ts, confidence: "low",
        kind: "model_description", title: ("Auto description for model " + $model),
        reason: "Empty model description — apply to seed the catalog.",
        evidence: [{type: "model", id: $model}],
        action: {type: "model_description", model_id: $model, description: $text},
        fingerprint: ("model_description:" + $model)
      }')"
  done <<EOF
$(jq -r '.models | to_entries[] | [.key, (.value.description // "")] | @tsv' "$PROFILES_FILE")
EOF
}

suggest_scan() {
  require_jq "suggest scan"
  ensure_home || return 1
  suggest_ensure || return 1
  suggest_expire_stale
  suggest_scan_descriptions
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    local status finished
    status=$(jq -r '.status' "$f" 2>/dev/null)
    finished=$(jq -r '.finished // ""' "$f" 2>/dev/null)
    [ "$status" = "done" ] || [ "$status" = "error" ] || continue
    [ -n "$finished" ] || continue
    suggest_scan_memory_gaps "$(basename "$(dirname "$f")")"
  done <<EOF
$(run_state_files)
EOF
  jq --arg ts "$(now_iso)" '.generated_at = $ts' "$SUGGESTIONS_FILE" > "$SUGGESTIONS_FILE.tmp.$$" \
    && mv -f "$SUGGESTIONS_FILE.tmp.$$" "$SUGGESTIONS_FILE"
  printf 'scanned\n'
}

memory_apply_suggestion() {
  local profile outcome kind note model_id
  profile=$(printf '%s' "$1" | jq -r '.profile // empty')
  outcome=$(printf '%s' "$1" | jq -r '.outcome // empty')
  kind=$(printf '%s' "$1" | jq -r '.task_kind // empty')
  note=$(printf '%s' "$1" | jq -r '.note // empty')
  model_id=$(printf '%s' "$1" | jq -r '.model_id // empty')
  memory_add --profile "$profile" --outcome "$outcome" --kind "$kind" --note "$note" ${model_id:+--model-id "$model_id"}
}

profile_description_apply() {
  local profile desc tmp
  profile=$(printf '%s' "$1" | jq -r '.profile // empty')
  desc=$(printf '%s' "$1" | jq -r '.description // empty')
  [ -n "$profile" ] || { printf 'profile_description apply: missing profile\n' >&2; return 2; }
  profile_require "$profile" >/dev/null || return 2
  if [ -z "$desc" ]; then
    desc=$(suggest_generate_profile_description "$profile")
  fi
  [ -n "$desc" ] || { printf 'profile_description apply: could not generate description for %s\n' "$profile" >&2; return 1; }
  tmp="$PROFILES_FILE.tmp.$$"
  if ! jq --arg p "$profile" --arg d "$desc" '.profiles[$p].description = $d' "$PROFILES_FILE" > "$tmp"; then
    return 1
  fi
  mv -f "$tmp" "$PROFILES_FILE"
}

model_description_apply() {
  local model_id desc tmp
  model_id=$(printf '%s' "$1" | jq -r '.model_id // empty')
  desc=$(printf '%s' "$1" | jq -r '.description // empty')
  [ -n "$model_id" ] || { printf 'model_description apply: missing model_id\n' >&2; return 2; }
  if ! jq -e --arg m "$model_id" '.models[$m]' "$PROFILES_FILE" >/dev/null 2>&1; then
    printf 'model_description apply: unknown model %s\n' "$model_id" >&2
    return 2
  fi
  if [ -z "$desc" ]; then
    desc=$(suggest_generate_model_description "$model_id")
  fi
  [ -n "$desc" ] || { printf 'model_description apply: could not generate description for %s\n' "$model_id" >&2; return 1; }
  tmp="$PROFILES_FILE.tmp.$$"
  if ! jq --arg m "$model_id" --arg d "$desc" '.models[$m].description = $d' "$PROFILES_FILE" > "$tmp"; then
    return 1
  fi
  mv -f "$tmp" "$PROFILES_FILE"
}

suggest_is_auto_kind() {
  case "$1" in
    memory_record|profile_description|model_description) return 0 ;;
  esac
  return 1
}

suggest_apply_one() {
  local id="$1" entry action
  entry=$(jq -c --arg id "$id" '.suggestions[] | select(.id == $id) | .' "$SUGGESTIONS_FILE")
  [ -n "$entry" ] || { printf 'suggest apply: unknown id %s\n' "$id" >&2; return 2; }
  local status
  status=$(printf '%s' "$entry" | jq -r '.status')
  [ "$status" = "pending" ] || { printf 'suggest apply: %s is %s, not pending\n' "$id" "$status" >&2; return 2; }
  action=$(printf '%s' "$entry" | jq -c '.action')
  local kind
  kind=$(printf '%s' "$action" | jq -r '.type')
  case "$kind" in
    memory_record)
      memory_apply_suggestion "$(printf '%s' "$action" | jq -c '.memory')" || return 1
      ;;
    profile_description)
      profile_description_apply "$action" || return 1
      ;;
    model_description)
      model_description_apply "$action" || return 1
      ;;
    *)
      printf 'suggest apply: unsupported action type %s\n' "$kind" >&2
      return 2
      ;;
  esac
  local tmp="$SUGGESTIONS_FILE.tmp.$$"
  jq --arg id "$id" --arg ts "$(now_iso)" \
    '.suggestions |= map(if .id == $id then .status = "applied" | .applied = $ts else . end)' \
    "$SUGGESTIONS_FILE" > "$tmp" && mv -f "$tmp" "$SUGGESTIONS_FILE"
}

suggest_apply_safe() {
  local id kind
  while IFS=$'\t' read -r id kind; do
    [ -n "$id" ] || continue
    suggest_is_auto_kind "$kind" || continue
    suggest_apply_one "$id" || true
  done <<EOF
$(jq -r '.suggestions[] | select(.status == "pending") | [.id, .kind] | @tsv' "$SUGGESTIONS_FILE")
EOF
}

learning_after_finish() {
  local run_id="$1"
  local auto_scan auto_apply
  auto_scan=$(learning_get auto_scan_on_finish true)
  auto_apply=$(learning_get auto_apply_safe true)
  if [ "$auto_scan" = "true" ]; then
    suggest_scan || true
  fi
  if [ "$auto_apply" = "true" ]; then
    suggest_apply_safe || true
  fi
}

cmd_suggest() {
  local sub="${1:-}"
  require_jq "suggest"
  ensure_home || return 1
  suggest_ensure || return 1
  [ $# -gt 0 ] && shift
  case "$sub" in
    scan) suggest_scan ;;
    list) suggest_list "$@" ;;
    apply) suggest_apply "$@" ;;
    dismiss) suggest_dismiss "$@" ;;
    *) printf 'usage: %s\n%s\n%s\n%s\n' "$SUGGEST_SCAN_USAGE" "$SUGGEST_LIST_USAGE" \
      "$SUGGEST_APPLY_USAGE" "$SUGGEST_DISMISS_USAGE" >&2; return 2 ;;
  esac
}

suggest_list() {
  local pending_only=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --pending) pending_only=1 ;;
      *) printf 'suggest list: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [ "$pending_only" -eq 1 ]; then
    jq -r '.suggestions[] | select(.status == "pending") | [.id, .confidence, .kind, .title] | @tsv' "$SUGGESTIONS_FILE"
  else
    jq -r '.suggestions[] | [.id, .status, .confidence, .kind, .title] | @tsv' "$SUGGESTIONS_FILE"
  fi
}

suggest_apply_many() {
  local -a ids=("$@") id err row results="[]" applied=0 failed=0
  for id in "${ids[@]}"; do
    [ -n "$id" ] || continue
    err=""
    if err=$(suggest_apply_one "$id" 2>&1); then
      applied=$((applied + 1))
      row=$(jq -nc --arg id "$id" '{id: $id, ok: true}')
    else
      failed=$((failed + 1))
      row=$(jq -nc --arg id "$id" --arg e "$err" '{id: $id, ok: false, error: $e}')
    fi
    results=$(jq -c --argjson r "$row" '. + [$r]' <<<"$results")
  done
  jq -nc --argjson results "$results" --argjson applied "$applied" --argjson failed "$failed" \
    '{ok: ($failed == 0), results: $results, applied: $applied, failed: $failed}'
  [ "$failed" -eq 0 ]
}

suggest_apply() {
  local -a ids=() id
  local apply_all=0 as_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) apply_all=1 ;;
      --json) as_json=1 ;;
      --id) shift; [ -n "${1:-}" ] && ids+=("$1") ;;
      --*) printf 'suggest apply: unknown argument %s\n' "$1" >&2; return 2 ;;
      *) ids+=("$1") ;;
    esac
    shift
  done
  if [ "$apply_all" -eq 1 ]; then
    while IFS=$'\t' read -r id kind; do
      [ -n "$id" ] || continue
      suggest_is_auto_kind "$kind" && ids+=("$id")
    done <<EOF
$(jq -r '.suggestions[] | select(.status == "pending") | [.id, .kind] | @tsv' "$SUGGESTIONS_FILE")
EOF
  fi
  if [ "${#ids[@]}" -eq 0 ]; then
    printf 'usage: %s\n' "$SUGGEST_APPLY_USAGE" >&2
    return 2
  fi
  if [ "${#ids[@]}" -eq 1 ] && [ "$as_json" -eq 0 ] && [ "$apply_all" -eq 0 ]; then
    suggest_apply_one "${ids[0]}"
    return $?
  fi
  suggest_apply_many "${ids[@]}"
}

suggest_dismiss() {
  local id="${1:-}"
  [ -n "$id" ] || { printf 'usage: %s\n' "$SUGGEST_DISMISS_USAGE" >&2; return 2; }
  local tmp="$SUGGESTIONS_FILE.tmp.$$"
  jq --arg id "$id" '.suggestions |= map(if .id == $id and .status == "pending" then .status = "dismissed" else . end)' \
    "$SUGGESTIONS_FILE" > "$tmp" || return 1
  mv -f "$tmp" "$SUGGESTIONS_FILE"
}

# Reconcile on-disk state after offline CLI work and bring the dashboard back when possible.
cmd_sync() {
  local no_serve=0 f run_id status diag_rc
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-serve) no_serve=1 ;;
      *) printf 'sync: unknown argument %s\n  usage: %s\n' "$1" "$SYNC_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "sync"
  ensure_home || return 1
  suggest_ensure || return 1

  if [ "$no_serve" -eq 0 ]; then
    diag_rc=0
    serve_diagnose >/dev/null 2>&1 || diag_rc=$?
    case "$diag_rc" in
      0) ;;
      2) printf 'sync: dashboard unavailable (bun missing); CLI state on disk is still authoritative\n' >&2 ;;
      *) serve_recover --start 2>/dev/null || printf 'sync: could not start dashboard server; continuing disk sync\n' >&2 ;;
    esac
  fi

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    status=$(jq -r '.status' "$f" 2>/dev/null)
    [ "$status" = "running" ] || continue
    run_id=$(basename "$(dirname "$f")")
    cmd_run_sync "$run_id" || true
  done <<EOF
$(run_state_files)
EOF

  suggest_scan || true
  if [ "$(learning_get auto_apply_safe true)" = "true" ]; then
    suggest_apply_safe || true
  fi
  printf 'synced\n'
}
