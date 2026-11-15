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
  jq -e '.suggestions and ([.suggestions[].id] | length == (unique | length))' "$SUGGESTIONS_FILE" >/dev/null 2>&1 && return 0
  jq -e '.suggestions' "$SUGGESTIONS_FILE" >/dev/null 2>&1 || {
    printf '{"generated_at":"%s","suggestions":[]}\n' "$(now_iso)" > "$SUGGESTIONS_FILE"
  }
  suggest_dedupe_ids
}

# Older builds could hand one id to several suggestions (see suggest_new_id). A shared id makes
# `suggest apply` match many entries, so every copy after the first gets a suffixed id.
suggest_dedupe_ids() {
  jq -e '[.suggestions[].id] | length != (unique | length)' "$SUGGESTIONS_FILE" >/dev/null 2>&1 || return 0
  local tmp="$SUGGESTIONS_FILE.tmp.$$"
  jq '
    reduce range(0; .suggestions | length) as $i (.;
      .suggestions[$i].id as $id
      | if ([.suggestions[0:$i][].id] | index($id)) != null
        then .suggestions[$i].id = ($id + "-" + ($i | tostring)) else . end)
  ' "$SUGGESTIONS_FILE" > "$tmp" && mv -f "$tmp" "$SUGGESTIONS_FILE"
}

# Not $RANDOM: bash 3.2 seeds it once per subshell tree, so every `$(suggest_new_id)` inside a
# subshell that already used it (e.g. `run advance --until-done` finishing a run) returns the
# same value.
suggest_new_id() {
  local hex
  hex=$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  [ -n "$hex" ] || hex=$(printf '%04x%04x' "$RANDOM" "$$")
  printf 'sug-%s\n' "$hex"
}

# Upsert by fingerprint; returns 0 if added/updated. A new entry whose id is already taken gets a
# suffixed one, so ids stay unique even if the generator ever repeats.
suggest_upsert() {
  local json="$1" fingerprint
  fingerprint=$(printf '%s' "$json" | jq -r '.fingerprint')
  local tmp="$SUGGESTIONS_FILE.tmp.$$"
  if ! jq --argjson s "$json" --arg fp "$fingerprint" --arg now "$(now_iso)" '
    .generated_at = $now
    | if any(.suggestions[]?; .fingerprint == $fp and .status == "pending") then
        .suggestions |= map(if .fingerprint == $fp and .status == "pending" then $s + {id: .id} else . end)
      elif any(.suggestions[]?; .fingerprint == $fp and (.status == "dismissed" or .status == "expired")) then
        .
      else
        ([.suggestions[]?.id]) as $ids
        | .suggestions += [if ($ids | index($s.id)) == null then $s
                           else $s + {id: ($s.id + "-" + ($ids | length | tostring))} end]
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

# One jq pass: profile/model description candidates, memory-gap candidates from finished runs, and
# the fingerprint upsert of all of them into suggestions.json (same rules as suggest_upsert).
SUGGEST_SCAN_JQ='
def pdesc($p):
  [ ($p.harness // "agent") + " profile",
    (if ($p.model // "") != "" then "model " + $p.model else empty end),
    (if ($p.cost // "") != "" then $p.cost + " tier" else empty end),
    (if ($p.quality // "") != "" then $p.quality + " quality" else empty end),
    (if (($p.strengths // []) | length) > 0 then "strengths: " + ($p.strengths | join(", ")) else empty end)
  ] | map(select(. != "" and . != null)) | join("; ");
def mdesc($m; $mod):
  [ ($mod.slug // $m) + " on " + (($mod.harnesses // []) | join("/")),
    (if ($mod.cost // "") != "" then $mod.cost + " cost" else empty end),
    (if ($mod.quality // "") != "" then $mod.quality + " quality" else empty end),
    (if ($mod.speed // "") != "" then $mod.speed + " speed" else empty end)
  ] | map(select(. != "" and . != null)) | join("; ");
def resolve($pr; $name):
  ($pr.profiles[$name]) as $prof
  | if $prof == null or ($prof.model // "") == "" then ""
    elif ($pr.models // {})[$prof.model]? then $prof.model
    else (first(($pr.models // {}) | to_entries[]
          | select(.value.slug == $prof.model and (.value.harnesses | index($prof.harness)))
          | .key) // "")
    end;
($pr[0]) as $pr
| (($mem[0] // [])) as $mem
| ($ids | split(" ") | map(select(. != "")) | map("sug-" + .)) as $pool
| input as $sug
| [inputs | {rid: (input_filename | split("/")[-2]), s: .}
   | select((.s.status == "done" or .s.status == "error") and ((.s.finished // "") != ""))] as $runs
| ([ ($pr.profiles // {}) | to_entries[]
     | select((.value.description // "") == "")
     | . as $e | pdesc($e.value) as $text | select($text != "")
     | {status: "pending", created: $ts, confidence: "low",
        kind: "profile_description", title: ("Auto description for " + $e.key),
        reason: "Empty profile description — apply to seed routing metadata.",
        evidence: [{type: "profile", id: $e.key}],
        action: {type: "profile_description", profile: $e.key, description: $text},
        fingerprint: ("profile_description:" + $e.key)}
   ]
   + [ ($pr.models // {}) | to_entries[]
     | select((.value.description // "") == "")
     | . as $e | mdesc($e.key; $e.value) as $text | select($text != "")
     | {status: "pending", created: $ts, confidence: "low",
        kind: "model_description", title: ("Auto description for model " + $e.key),
        reason: "Empty model description — apply to seed the catalog.",
        evidence: [{type: "model", id: $e.key}],
        action: {type: "model_description", model_id: $e.key, description: $text},
        fingerprint: ("model_description:" + $e.key)}
   ]
   + [ $runs[] | . as $r | $r.s.nodes[]?
     | select((.id // "") != "" and (.status == "done" or .status == "error") and ((.profile // "") != ""))
     | . as $n | (.profile) as $profile | ((.label // "") | ascii_downcase | .[0:32]) as $kind
     | select(($mem | any(.[]?; .profile == $profile and (.task_kind // "") == $kind and .outcome == "success")) | not)
     | (if $n.status == "done" then "success" else "failure" end) as $outcome
     | ("from run " + $r.rid + " node " + $n.id) as $note
     | {status: "pending", created: $ts, confidence: "medium",
        kind: "memory_record", title: ("Record memory: " + $profile + " / " + $kind),
        reason: "Finished node has no matching memory row for this kind.",
        evidence: [{type: "run", id: $r.rid, node: $n.id}],
        action: {type: "memory_record", memory: {profile: $profile, outcome: $outcome, task_kind: $kind, note: $note, model_id: resolve($pr; $profile)}},
        fingerprint: ("memory_record:" + $profile + ":" + $kind)}
   ]) as $cands
| reduce range(0; $cands | length) as $i ($sug;
    $cands[$i] as $c
    | if any(.suggestions[]?; .fingerprint == $c.fingerprint and .status == "pending") then
        .suggestions |= map(if .fingerprint == $c.fingerprint and .status == "pending" then $c + {id: .id} else . end)
      elif any(.suggestions[]?; .fingerprint == $c.fingerprint and (.status == "dismissed" or .status == "expired")) then .
      else
        ([.suggestions[]?.id]) as $have
        | ($pool[$i] // ("sug-" + ($i | tostring))) as $id
        | .suggestions += [if ($have | index($id)) == null then $c + {id: $id}
                           else $c + {id: ($id + "-" + ($have | length | tostring))} end]
      end)
| .generated_at = $ts
'

suggest_scan() {
  require_jq "suggest scan"
  ensure_home || return 1
  suggest_ensure || return 1
  suggest_expire_stale
  local ids tmp="$SUGGESTIONS_FILE.tmp.$$" mem="$MEMORY_FILE" f
  local -a files=()
  ids=$(od -An -N8192 -tx4 -v /dev/urandom 2>/dev/null | tr -s ' \n' '  ')
  [ -f "$mem" ] || mem=/dev/null
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done <<EOF
$(run_state_files)
EOF
  if ! jq -n --arg ts "$(now_iso)" --arg ids "$ids" --slurpfile pr "$PROFILES_FILE" --slurpfile mem "$mem" \
    "$SUGGEST_SCAN_JQ" "$SUGGESTIONS_FILE" ${files[@]+"${files[@]}"} > "$tmp" 2>/dev/null; then
    # A half-written or unreadable run state must not stop the scan: drop those files and try once more.
    local -a good=()
    for f in ${files[@]+"${files[@]}"}; do jq -e . "$f" >/dev/null 2>&1 && good+=("$f"); done
    if ! jq -n --arg ts "$(now_iso)" --arg ids "$ids" --slurpfile pr "$PROFILES_FILE" --slurpfile mem "$mem" \
      "$SUGGEST_SCAN_JQ" "$SUGGESTIONS_FILE" ${good[@]+"${good[@]}"} > "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  fi
  mv -f "$tmp" "$SUGGESTIONS_FILE"
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
    profiles_tmp_discard "$tmp"
    return 1
  fi
  profiles_commit "$tmp"
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
    profiles_tmp_discard "$tmp"
    return 1
  fi
  profiles_commit "$tmp"
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

  loops_recover || true
  suggest_scan || true
  if [ "$(learning_get auto_apply_safe true)" = "true" ]; then
    suggest_apply_safe || true
  fi
  printf 'synced\n'
}
