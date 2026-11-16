#!/usr/bin/env bash
# Shell glue that the not-yet-ported bash libs still use — sourced by dispatch.sh, never executed.
# The config home, profiles.json migrations, settings, profile and memory commands live in core/ (TypeScript).
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
# Gitignored personal overlay: its settings, models and profiles win over the committed template.
PROFILES_OVERLAY_FILE="${ORCH_PROFILES_OVERLAY:-$TEMPLATES_DIR/profiles.local.json}"
VALID_HARNESSES="claude cursor-agent opencode local-llm copilot pi"
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

# profile_load exit code for "the profile is fine, its environment just is not set up" — as
# opposed to 2 for a malformed profile. Lets callers report "not configured" instead of a
# failure the user cannot act on by fixing orch.
PROFILE_UNCONFIGURED_RC=3

# The one readiness rule (shared by runs, visibility, plan and health; here because config.sh is
# sourced before them) (jq def; call as `node_ready($r)` on a node, $r = the run state). A node is
# ready when it is waiting, not blocked on the user (`needs_user`), not held back by the coordinator
# (`hold`), every incoming edge's source is done, and, for an `after_all` gate node, every other non-gate node is done or skipped.
NODE_READY_JQ_DEF='def node_ready($r): . as $x
  | $x.status == "waiting" and (($x.needs_user // "") == "") and (($x.hold // "") == "")
    and all(($r.edges // [])[] | select(.[1] == $x.id) | .[0] as $d | ($r.nodes[] | select(.id == $d) | .status); . == "done")
    and (if ($x.after_all // false) then all($r.nodes[] | select(.id != $x.id and ((.after_all // false) | not)); .status | IN("done", "skipped")) else true end);'

# Epoch mtime of a file — BSD stat (macOS) first, GNU stat second.
file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

# Usage lines printed by `dispatch.sh -h` for commands that now run in core/ (TypeScript).
PLAN_USAGE='dispatch.sh plan <run-id> "<goal>|@file" [--profile P] [--node ID]'
PLAN_APPLY_USAGE='dispatch.sh plan apply <run-id> [--file plan.json]'
RUN_ADVANCE_USAGE='dispatch.sh run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish]'
MSG_SEND_USAGE='dispatch.sh msg send <run-id> --to orch|all|<node-id> [--from <node-id>|orch] "<text>"'
MSG_READ_USAGE='dispatch.sh msg read <run-id> [--for orch|<node-id>] [--since N] [--all]'

# Optional <state-dir>/env: `NAME=value` lines exported before a profile's ${NAME} references
# are resolved. It exists because a supervisor (launchd/systemd) does not inherit your shell, so
# a profile pointing at a gateway had no way to learn the URL.
#
# Plain text, 0600, and deliberately NOT a secret store: keep endpoints and dummy tokens here,
# and for a real credential export it from your shell (or a keychain helper) instead, so it is
# never written to disk. Nothing here is echoed.
ORCH_ENV_FILE_LOADED=""
orch_load_env_file() {
  local file="$ORCH_HOME/env" line name value
  [ -z "$ORCH_ENV_FILE_LOADED" ] || return 0
  ORCH_ENV_FILE_LOADED=1
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    name="${line%%=*}"
    value="${line#*=}"
    is_identifier "$name" || continue
    # Anything the caller already set wins — the shell you launched from is more specific than
    # a file. Tested for being *set*, not non-empty: `LLM_HUB_URL= orch run ...` is an explicit
    # "no value", and a file must not quietly put one back.
    [ -n "${!name+x}" ] && continue
    export "$name=$value"
  done < "$file"
}

# ensure_home: the config home bootstrap runs in core/ (TypeScript).
ensure_home() {
  "${ORCH_BUN:-bun}" "$SCRIPT_DIR/../bin/orch" init --quiet >/dev/null
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

# setting_uint <key> <default> — the setting when it is a positive integer, else the default.
setting_uint() {
  local value
  value=$(setting_get "$1" "$2")
  if is_uint "$value" && [ "$value" -ge 1 ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$2"
  fi
}

# The run cap: defaults.max_parallel, else the old settings.max_parallel, else the built-in 15.
max_parallel_cap() {
  local v
  v=$(jq -r '.defaults.max_parallel // .settings.max_parallel // empty' "$PROFILES_FILE" 2>/dev/null)
  is_uint "$v" && [ "$v" -ge 1 ] && { printf '%s' "$v"; return 0; }
  printf '15'
}

