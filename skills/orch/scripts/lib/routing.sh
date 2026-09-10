#!/usr/bin/env bash
# Profile/model routing for orch — sourced by dispatch.sh, never executed.

COMPLEXITY_ORDER="trivial small medium large"
PROFILE_PICK_USAGE='dispatch.sh profile pick "<task>" [--complexity trivial|small|medium|large] [--kind K]'
MODEL_LIST_USAGE='dispatch.sh model list [--profile P] [--harness H]'

# jq filter: true when catalog id/slug matches an allowed_models entry (exact id/slug or prefix*).
ROUTING_MATCH_JQ='
  def entry_matches($id; $slug; $entry):
    if ($entry | endswith("*")) then
      ($entry[0:(($entry | length) - 1)]) as $pre
      | ($pre == "") or ($id | startswith($pre)) or ($slug | startswith($pre))
    else
      $entry == $id or $entry == $slug
    end;
  def model_allowed($id; $slug; $allowed):
    any($allowed[]; entry_matches($id; $slug; .));
'

# Prints space-separated model ids allowed for a profile (explicit list, patterns, or all for harness).
profile_allowed_model_ids() {
  local profile="$1"
  jq -r --arg p "$profile" "$ROUTING_MATCH_JQ"'
    .profiles[$p] as $prof
    | if $prof == null then empty
      elif ($prof.allowed_models? | length) > 0 then
        [.models | to_entries[]
        | select(.value.harnesses? | index($prof.harness))
        | select(model_allowed(.key; .value.slug; $prof.allowed_models))
        | .key
        ] | .[]
      else .models | to_entries[]
        | select(.value.harnesses? | index($prof.harness))
        | .key
      end
  ' "$PROFILES_FILE"
}

# Resolves a model id (or legacy slug) to slug for spawn; prints slug or empty.
# The catalog's behaves_as for a profile's resolved model, or empty. Same lookup shape as
# model_slug_resolve: by catalog id first, then by slug.
model_behaves_as_resolve() {
  local profile="$1" model_ref="$2"
  jq -r --arg p "$profile" --arg m "$model_ref" '
    .profiles[$p] as $prof
    | if $prof == null then empty
      elif .models[$m]? then (.models[$m].behaves_as // "")
      else
        ( [ .models | to_entries[]
            | select(.value.slug == $m and (.value.harnesses | index($prof.harness)))
            | .value.behaves_as // "" ][0] ) // ""
      end
  ' "$PROFILES_FILE"
}

model_slug_resolve() {
  local profile="$1" model_ref="$2"
  jq -r --arg p "$profile" --arg m "$model_ref" '
    .profiles[$p] as $prof
    | if $prof == null then empty
      elif .models[$m]? then .models[$m].slug
      else
        (.models | to_entries[] | select(.value.slug == $m and (.value.harnesses | index($prof.harness))) | .value.slug)
        // $m
      end
  ' "$PROFILES_FILE"
}

# Resolves profile.model field to a catalog model id.
model_id_resolve() {
  local profile="$1"
  jq -r --arg p "$profile" '
    .profiles[$p] as $prof
    | if $prof == null or ($prof.model // "") == "" then empty
      elif .models[$prof.model]? then $prof.model
      else
        (.models | to_entries[]
          | select(.value.slug == $prof.model and (.value.harnesses | index($prof.harness)))
          | .key) // empty
      end
  ' "$PROFILES_FILE"
}

model_id_allowed() {
  local profile="$1" model_id="$2"
  jq -e --arg p "$profile" --arg m "$model_id" "$ROUTING_MATCH_JQ"'
    .profiles[$p] as $prof
    | if $prof == null then false
      elif ($prof.allowed_models? | length) == 0 then true
      else
        (.models[$m] // empty) as $spec
        | if $spec == empty then false
          else model_allowed($m; $spec.slug; $prof.allowed_models)
          end
      end
  ' "$PROFILES_FILE" >/dev/null
}

cmd_model() {
  local sub="${1:-}"
  require_jq "model"
  ensure_home || return 1
  [ $# -gt 0 ] && shift
  case "$sub" in
    list) model_list "$@" ;;
    *) printf 'usage: %s\n' "$MODEL_LIST_USAGE" >&2; return 2 ;;
  esac
}

model_list() {
  local profile="" harness=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; profile="${1:-}" ;;
      --harness) shift; harness="${1:-}" ;;
      *) printf 'model list: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [ -n "$profile" ]; then
    jq -r --arg p "$profile" "$ROUTING_MATCH_JQ"'
      .profiles[$p] as $prof
      | if $prof == null then empty
        else
          (if ($prof.allowed_models? | length) > 0 then
            [.models | to_entries[]
            | select(.value.harnesses? | index($prof.harness))
            | select(model_allowed(.key; .value.slug; $prof.allowed_models))
            | .key]
           else [.models | to_entries[] | select(.value.harnesses? | index($prof.harness)) | .key]
           end) as $ids
          | $ids[] as $id
          | .models[$id] as $m
          | [$id, $m.slug, ($m.description // ""), ($m.cost // ""), ($m.quality // "")]
          | @tsv
        end
    ' "$PROFILES_FILE"
    return 0
  fi
  jq -r --arg h "$harness" '
    .models | to_entries[]
    | select($h == "" or (.value.harnesses? | index($h)))
    | [.key, .value.slug, (.value.description // ""), (.value.cost // ""), (.value.quality // "")]
    | @tsv
  ' "$PROFILES_FILE"
}

cmd_profile_pick() {
  local task="" complexity="" kind=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --complexity) shift; complexity="${1:-}" ;;
      --kind) shift; kind="${1:-}" ;;
      -*) printf 'profile pick: unknown option %s\n' "$1" >&2; return 2 ;;
      *) [ -z "$task" ] && task="$1" ;;
    esac
    shift
  done
  [ -n "$task" ] || { printf 'usage: %s\n' "$PROFILE_PICK_USAGE" >&2; return 2; }
  require_jq "profile pick"
  ensure_home || return 1

  if [ -z "$complexity" ]; then
    local words
    words=$(printf '%s' "$task" | wc -w | tr -d ' ')
    if [ "${words:-0}" -le 8 ]; then complexity="small"; else complexity="medium"; fi
  fi

  local budget_ok=1
  budget_check >/dev/null 2>&1 || budget_ok=0

  local pick mem_file
  mem_file="$MEMORY_FILE"
  [ -f "$mem_file" ] || mem_file=/dev/null
  pick=$(jq -r --slurpfile mem "$mem_file" --arg c "$complexity" --arg k "$kind" \
    --argjson budget_ok "$budget_ok" --arg default "$(setting_get default_profile "")" '
    def rank($x): {"trivial":1,"small":2,"medium":3,"large":4}[$x] // 3;
    def in_band($p; $c):
      (if $p.min_complexity then rank($c) >= rank($p.min_complexity) else true end)
      and (if $p.max_complexity then rank($c) <= rank($p.max_complexity) else true end);
    def cost_score($p):
      if $budget_ok == 0 then
        {"free":0,"low":1,"subscription":4,"metered":3,"high":5}[$p.cost // "subscription"] // 3
      else
        {"free":2,"low":1,"subscription":0,"metered":1,"high":3}[$p.cost // "subscription"] // 0
      end;
    def memory_boost($name):
      ($mem[0] // []) | map(select(.profile == $name and .outcome == "success"
        and (($k == "") or (.task_kind // "") == $k))) | length;
    [.profiles | to_entries[]
    | select(.value.enabled != false)
    | select(in_band(.value; $c))
    | {name: .key, score: ((memory_boost(.key) * -10) + cost_score(.value) + (10 - (.value.priority // 5)))}]
    | sort_by(.score, .name)
    | (.[0].name // $default)
  ' "$PROFILES_FILE")

  [ -n "$pick" ] || pick=$(setting_get default_profile "")
  [ -n "$pick" ] || { printf 'profile pick: no profile available\n' >&2; return 2; }

  local model_id reason
  model_id=$(model_id_resolve "$pick")
  reason="complexity=$complexity"
  [ -n "$kind" ] && reason="$reason kind=$kind"
  [ "$budget_ok" -eq 0 ] && reason="$reason budget_tight"

  printf 'profile=%s\n' "$pick"
  [ -n "$model_id" ] && printf 'model=%s\n' "$model_id"
  printf 'reason=%s\n' "$reason"
}
