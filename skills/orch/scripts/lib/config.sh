#!/usr/bin/env bash
# Config home for orch (~/.harness-orch by default) — sourced by dispatch.sh, never executed.
# Owns: directory layout, first-use bootstrap, settings lookup, profile resolution, memory log.
# profiles.json never holds secret values: env entries are literals or whole-value `${NAME}`
# references resolved from the caller's environment at spawn time, and `auth` lists env-var
# NAMES that must be set. Nothing here prints a resolved secret.
#
# VALID_HARNESSES/VALID_OUTCOMES are the single source of truth — `serve` passes them to the
# server as argv; the dashboard reads them from the API envelopes.
#
# Globals set here (TRASH_FALLBACK_DIR, PROFILE_*) are consumed by the sibling libs.
# shellcheck disable=SC2034

RUNS_HOME="$ORCH_HOME/runs"
PROFILES_FILE="$ORCH_HOME/profiles.json"
MEMORY_FILE="$ORCH_HOME/memory.json"
SUGGESTIONS_FILE="$ORCH_HOME/suggestions.json"
TRASH_FALLBACK_DIR="$ORCH_HOME/.trash"
TEMPLATES_DIR="$SCRIPT_DIR/../templates"
VALID_HARNESSES="claude cursor-agent opencode local-llm"
VALID_OUTCOMES="success failure partial"
MEMORY_LIST_DEFAULT=20
MEMORY_ADD_USAGE='dispatch.sh memory add --profile P --outcome success|failure|partial [--kind K] [--note "…"]'

require_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  printf 'orch: jq is required for %s\n' "${1:-this subcommand}" >&2
  exit 127
}

is_identifier() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  return 0
}

# in_list <word> "<space separated list>"
in_list() {
  case " $2 " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Epoch mtime of a file — BSD stat (macOS) first, GNU stat second.
file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

ensure_home() {
  mkdir -p "$ORCH_HOME" "$JOBS_HOME" "$RUNS_HOME" \
    || { printf 'orch: cannot create %s\n' "$ORCH_HOME" >&2; return 1; }
  [ -f "$PROFILES_FILE" ] || cp "$TEMPLATES_DIR/profiles.json" "$PROFILES_FILE" || return 1
  [ -f "$MEMORY_FILE" ] || printf '[]\n' > "$MEMORY_FILE"
  [ -f "$ORCH_HOME/serve.json" ] || cp "$TEMPLATES_DIR/serve.json" "$ORCH_HOME/serve.json" 2>/dev/null || true
  profiles_migrate || return 1
  suggestions_seed || return 1
}

suggestions_seed() {
  [ -f "$SUGGESTIONS_FILE" ] || cp "$TEMPLATES_DIR/suggestions.json" "$SUGGESTIONS_FILE" \
    || printf '{"generated_at":"%s","suggestions":[]}\n' "$(now_iso)" > "$SUGGESTIONS_FILE"
}

# Adds models{}, learning defaults, and catalog ids for legacy model slugs — never overwrites user edits.
profiles_migrate() {
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$PROFILES_FILE" ] || return 0
  local tmp="$PROFILES_FILE.tmp.$$"
  if ! jq '
    def rename_profile($old; $new):
      if .profiles[$old]? then
        .profiles[$new] = .profiles[$old]
        | del(.profiles[$old])
        | if (.settings.default_profile // "") == $old then .settings.default_profile = $new else . end
        | .profiles |= with_entries(
            .value |= if .fallback? == $old then . + {fallback: $new} else . end
          )
      else .
      end;
    .models //= {}
    | rename_profile("claude-hub"; "claude-llm-hub")
    | rename_profile("cursor-hub"; "cursor-llm-hub")
    |     .settings.learning //= {
        auto_record_memory: true,
        auto_scan_on_finish: true,
        auto_apply_safe: true,
        min_samples: 3,
        recency_days: 30,
        dismiss_ttl_days: 30
      }
    | .settings.learning.auto_apply_safe //= true
    | reduce (.profiles | keys[]) as $name (
        .;
        .profiles[$name] as $p
        | if ($p.model // "") == "" or .models[$p.model]? then .
          else
            ( [ .models | to_entries[]
                | select(.value.slug == $p.model and (.value.harnesses | index($p.harness)))
                | .key ][0] ) as $found
            | if $found then .profiles[$name].model = $found
              else
                ( ($p.harness | gsub("-"; "_")) + "-" + ($p.model | gsub("[^a-zA-Z0-9._-]"; "_")) ) as $nid
                | .models[$nid] = {slug: $p.model, harnesses: [$p.harness], description: ""}
                | .profiles[$name].model = $nid
              end
          end
      )
  ' "$PROFILES_FILE" > "$tmp"; then
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  mv -f "$tmp" "$PROFILES_FILE"
}

# recoverable_remove <path> — `trash` when available, else a timestamped move under .trash/ (never `rm`).
recoverable_remove() {
  local path="${1%/}" dest stamp
  [ -e "$path" ] || return 0
  if command -v trash >/dev/null 2>&1 && trash "$path" 2>/dev/null; then
    return 0
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dest="$TRASH_FALLBACK_DIR/$stamp"
  mkdir -p "$dest" && mv "$path" "$dest/"
}

# Retired file:// dashboard artifacts — recoverably removed on init/install, never left behind.
prune_legacy_dashboard() {
  local path
  for path in "$ORCH_HOME/index.html" "$ORCH_HOME/data"; do
    [ -e "$path" ] || continue
    recoverable_remove "$path" || return 1
    [ -n "${ORCH_INSTALL_QUIET:-}" ] || printf 'orch: moved legacy dashboard leftover %s\n' "${path##*/}" >&2
  done
}

cmd_init() {
  ensure_home || return 1
  prune_legacy_dashboard || return 1
  printf '%s\n' "$ORCH_HOME"
}

# setting_get <key> <default> — never fails; missing file/jq/key all yield the default.
setting_get() {
  local key="$1" default="$2"
  if [ ! -f "$PROFILES_FILE" ] || ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$default"
    return 0
  fi
  jq -r --arg k "$key" --arg d "$default" '.settings[$k] // $d' "$PROFILES_FILE" 2>/dev/null \
    || printf '%s\n' "$default"
}

profile_names() {
  jq -r '.profiles | keys | join(", ")' "$PROFILES_FILE"
}

# Prints the profile's compact JSON, or names the available profiles and returns 2.
profile_require() {
  local json
  json=$(jq -c --arg n "$1" '.profiles[$n] // empty' "$PROFILES_FILE")
  if [ -z "$json" ]; then
    printf 'profile %s: unknown profile. Available: %s\n' "$1" "$(profile_names)" >&2
    return 2
  fi
  printf '%s\n' "$json"
}

# Sets PROFILE_NAME / PROFILE_HARNESS / PROFILE_MODEL / PROFILE_FLAGS[] and exports the profile's
# env. Exit 2 = bad profile definition, exit 1 = environment missing something the profile needs.
profile_load() {
  local name="$1" json
  require_jq "profile $name"
  ensure_home || return 1
  json=$(profile_require "$name") || return $?

  PROFILE_NAME="$name"
  PROFILE_HARNESS=$(printf '%s' "$json" | jq -r '.harness // empty')
  PROFILE_MODEL_ID="${ORCH_MODEL_ID:-}"
  if [ -z "$PROFILE_MODEL_ID" ]; then
    PROFILE_MODEL_ID=$(model_id_resolve "$name")
  elif ! model_id_allowed "$name" "$PROFILE_MODEL_ID"; then
    printf 'profile %s: model %s is not in allowed_models\n' "$name" "$PROFILE_MODEL_ID" >&2
    return 2
  fi
  if [ -n "$PROFILE_MODEL_ID" ]; then
    PROFILE_MODEL=$(model_slug_resolve "$name" "$PROFILE_MODEL_ID")
  else
    PROFILE_MODEL=""
  fi
  if ! in_list "$PROFILE_HARNESS" "$VALID_HARNESSES"; then
    printf 'profile %s: harness "%s" must be one of: %s\n' "$name" "$PROFILE_HARNESS" "$VALID_HARNESSES" >&2
    return 2
  fi

  PROFILE_FLAGS=()
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && PROFILE_FLAGS+=("$line")
  done <<EOF
$(printf '%s' "$json" | jq -r '.flags[]? // empty')
EOF

  profile_export_env "$name" "$json" || return $?
  profile_check_auth "$name" "$json"
}

# Prints the env value to export: a literal as-is, or a whole-value `${NAME}` reference replaced
# by the caller's environment. Partial interpolation is deliberately unsupported (no eval).
profile_resolve_env_value() {
  local name="$1" key="$2" value="$3" ref
  # shellcheck disable=SC2016
  case "$value" in
    '${'*'}') ;;
    *) printf '%s' "$value"; return 0 ;;
  esac
  ref="${value#\$\{}"
  ref="${ref%\}}"
  if ! is_identifier "$ref" || [ -z "${!ref:-}" ]; then
    # shellcheck disable=SC2016
    printf 'profile %s: env %s references unset ${%s}\n' "$name" "$key" "$ref" >&2
    return 1
  fi
  printf '%s' "${!ref}"
}

profile_export_env() {
  local name="$1" json="$2" key value
  while IFS=$'\t' read -r key value; do
    [ -n "$key" ] || continue
    if ! is_identifier "$key"; then
      printf 'profile %s: env key "%s" is not a valid variable name\n' "$name" "$key" >&2
      return 2
    fi
    value=$(profile_resolve_env_value "$name" "$key" "$value") || return 1
    export "$key=$value"
  done <<EOF
$(printf '%s' "$json" | jq -r '.env // {} | to_entries[] | "\(.key)\t\(.value)"')
EOF
}

profile_check_auth() {
  local name="$1" json="$2" var
  while IFS= read -r var; do
    [ -n "$var" ] || continue
    if ! is_identifier "$var" || [ -z "${!var:-}" ]; then
      printf 'profile %s: required auth env var %s is not set\n' "$name" "$var" >&2
      return 1
    fi
  done <<EOF
$(printf '%s' "$json" | jq -r '.auth[]? // empty')
EOF
}

cmd_profile() {
  local sub="${1:-}"
  require_jq "profile"
  ensure_home || return 1
  case "$sub" in
    list)
      jq -r --arg d "$(setting_get default_profile "")" \
        '.profiles | to_entries[] | (if .key == $d then "*" else "" end) + .key + "\t" + .value.harness + "\t" + (.value.model // "")' \
        "$PROFILES_FILE"
      ;;
    show)
      [ -n "${2:-}" ] || { printf 'usage: dispatch.sh profile show <name>\n' >&2; return 2; }
      profile_require "$2" | jq .
      return "${PIPESTATUS[0]}"
      ;;
    pick) shift; cmd_profile_pick "$@" ;;
    sanity) shift; cmd_profile_sanity "$@" ;;
    *) printf 'usage: dispatch.sh profile list | show <name> | pick "<task>" [--complexity …] [--kind K] | sanity [--profile NAME]\n' >&2; return 2 ;;
  esac
}

cmd_memory() {
  local sub="${1:-}"
  require_jq "memory"
  ensure_home || return 1
  [ $# -gt 0 ] && shift
  case "$sub" in
    add) memory_add "$@" ;;
    list) memory_list "$@" ;;
    *) printf 'usage: %s | dispatch.sh memory list [--profile P] [-n N]\n' "$MEMORY_ADD_USAGE" >&2; return 2 ;;
  esac
}

memory_add() {
  local profile="" outcome="" kind="" note="" model_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; profile="${1:-}" ;;
      --outcome) shift; outcome="${1:-}" ;;
      --kind) shift; kind="${1:-}" ;;
      --note) shift; note="${1:-}" ;;
      --model-id) shift; model_id="${1:-}" ;;
      *) printf 'memory add: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [ -z "$profile" ] || [ -z "$outcome" ]; then
    printf 'usage: %s\n' "$MEMORY_ADD_USAGE" >&2
    return 2
  fi
  in_list "$outcome" "$VALID_OUTCOMES" || { printf 'memory add: outcome must be one of: %s\n' "$VALID_OUTCOMES" >&2; return 2; }

  local json harness model slug tmp
  json=$(profile_require "$profile") || return $?
  harness=$(printf '%s' "$json" | jq -r '.harness // ""')
  if [ -z "$model_id" ]; then
    model_id=$(model_id_resolve "$profile")
  fi
  if [ -n "$model_id" ]; then
    slug=$(model_slug_resolve "$profile" "$model_id")
    model="$slug"
  else
    model=$(printf '%s' "$json" | jq -r '.model // ""')
    model_id=""
  fi

  tmp="$MEMORY_FILE.tmp.$$"
  if ! jq --arg ts "$(now_iso)" --arg kind "$kind" --arg profile "$profile" --arg harness "$harness" \
      --arg model "$model" --arg model_id "$model_id" --arg outcome "$outcome" --arg note "$note" \
      '. + [{ts: $ts, task_kind: $kind, profile: $profile, harness: $harness, model: $model,
             model_id: (if $model_id == "" then null else $model_id end),
             outcome: $outcome, note: $note}]' \
      "$MEMORY_FILE" > "$tmp"; then
    printf 'memory add: could not update %s\n' "$MEMORY_FILE" >&2
    return 1
  fi
  mv -f "$tmp" "$MEMORY_FILE"
}

memory_list() {
  local profile="" n="$MEMORY_LIST_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; profile="${1:-}" ;;
      -n) shift; n="${1:-$MEMORY_LIST_DEFAULT}" ;;
      *) printf 'memory list: unknown argument %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  is_uint "$n" || { printf 'memory list: -n expects a number\n' >&2; return 2; }
  jq -r --arg p "$profile" --argjson n "$n" \
    '[ .[] | select($p == "" or .profile == $p) ] | reverse | .[:$n][] | [.ts, .profile, .outcome, .task_kind, .note] | @tsv' \
    "$MEMORY_FILE"
}
