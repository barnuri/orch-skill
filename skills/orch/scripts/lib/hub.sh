# llm-hub native mode: the hub picks every model, orch runs the graph.
#
# settings.llm_hub = {mode: "smart-auto", harness: "<harness>", role_tiers: {<role>: <tier>}}
# With mode "smart-auto" a node added without --profile runs on "<harness>-smart-auto", a node with
# a role and no --tier gets the tier its role maps to, and each dispatch asks the hub which model it
# expects (/api/smart-auto/resolve) and records what the hub actually used after the node ends.

HUB_USAGE='dispatch.sh hub setup [--harness H] | hub off | hub status | hub resolve <tier> [<role>]'
HUB_HARNESSES="claude opencode copilot pi"
HUB_HTTP_TIMEOUT=5
# The defaults for a role with no settings.llm_hub.role_tiers entry. The hub also publishes its own
# advisory defaults at /api/smart-auto/tiers; these match them so orch works without that call.
HUB_ROLE_TIERS_DEFAULT='{"planning":"intelligence","investigation":"balance","implementation":"balance","validation":"efficiency","conversation":"fast"}'

hub_mode_on() {
  [ -f "$PROFILES_FILE" ] || return 1
  [ "$(jq -r '.settings.llm_hub.mode // ""' "$PROFILES_FILE" 2>/dev/null)" = "smart-auto" ]
}

# The profile every hub-mode node runs on unless it names its own.
hub_profile() {
  local harness
  harness=$(jq -r '.settings.llm_hub.harness // "opencode"' "$PROFILES_FILE" 2>/dev/null)
  printf '%s-smart-auto\n' "${harness:-opencode}"
}

# hub_role_tier <role>: the tier for a role, from settings first, then the defaults.
hub_role_tier() {
  local role="$1"
  [ -n "$role" ] || return 0
  jq -r --arg r "$role" --argjson d "$HUB_ROLE_TIERS_DEFAULT" \
    '(.settings.llm_hub.role_tiers // {})[$r] // $d[$r] // ""' "$PROFILES_FILE" 2>/dev/null
}

# hub_api <method> <path> [json-body]: prints the hub's answer; fails on a transport or HTTP error.
hub_api() {
  local method="$1" path="$2" body="${3:-}"
  local -a auth=() data=()
  orch_load_env_file
  [ -n "${LLM_HUB_URL:-}" ] || { printf 'hub: LLM_HUB_URL not set\n' >&2; return 2; }
  [ -z "${LLM_HUB_KEY:-}" ] || auth=(-H "Authorization: Bearer $LLM_HUB_KEY")
  [ -z "$body" ] || data=(-H 'content-type: application/json' --data "$body")
  curl -sS -f --max-time "$HUB_HTTP_TIMEOUT" -X "$method" ${auth[@]+"${auth[@]}"} \
    ${data[@]+"${data[@]}"} "${LLM_HUB_URL%/}$path"
}

# hub_resolve_json <tier> <role> [worker]: the hub's expected pick, as compact JSON.
hub_resolve_json() {
  local body
  body=$(jq -cn --arg t "$1" --arg r "${2:-}" --arg w "${3:-}" \
    '{tier: $t} + (if $r == "" then {} else {role: $r} end) + (if $w == "" then {} else {worker: $w} end)')
  hub_api POST /api/smart-auto/resolve "$body" | jq -c 'select(type == "object" and has("model"))'
}

# Before a hub-mode dispatch: records the model the hub expects for this node. Best effort — a hub
# that is down or too old leaves .hub.expected null and the dispatch still runs.
hub_node_expect() {
  local run_id="$1" node_id="$2" tier="$3" role="$4" worker="$5" expected
  hub_mode_on || return 0
  [ -n "$tier$role" ] || return 0
  expected=$(hub_resolve_json "${tier:-balance}" "$role" "$worker" 2>/dev/null) || expected=""
  [ -n "$expected" ] || expected=null
  node_patch "$run_id" "$node_id" '.hub = {expected: $e, actual: null, outcome: null}' --argjson e "$expected"
}

# After a node ends: records the model the hub actually used for its worker and, when the node has
# acceptance checks, reports whether they passed. Best effort, like hub_node_expect.
hub_node_settle() {
  local run_id="$1" node_id="$2" status="$3" file worker acceptance current actual salted code="" body
  file=$(run_require "$run_id" 2>/dev/null) || return 0
  worker=$(node_field "$file" "$node_id" worker_identity)
  [ -n "$worker" ] || return 0
  current=$(hub_api GET "/api/smart-auto/current?worker=$(jq -rn --arg w "$worker" '$w | @uri')" 2>/dev/null) || return 0
  actual=$(printf '%s' "$current" | jq -c '.selection.main // empty | {model, tier, role, reason, state}' 2>/dev/null)
  [ -n "$actual" ] || return 0
  acceptance=$(node_field "$file" "$node_id" acceptance)
  salted=$(printf '%s' "$current" | jq -r '.selection.main.worker // empty')
  if [ -n "$acceptance" ] && [ -n "$salted" ]; then
    case "$status" in done) code=tests_passed ;; error) code=tests_failed ;; esac
    if [ -n "$code" ]; then
      body=$(jq -cn --arg w "$salted" --arg c "$code" '{worker: $w, code: $c}')
      hub_api POST /api/smart-auto/outcome "$body" >/dev/null 2>&1 || code=""
    fi
  fi
  node_patch "$run_id" "$node_id" \
    '.hub = ((.hub // {expected: null}) + {actual: $a, outcome: (if $c == "" then null else $c end)})' \
    --argjson a "$actual" --arg c "$code"
}

hub_settings_write() {
  local filter="$1" tmp="$PROFILES_FILE.tmp.$$"
  shift
  if ! jq "$@" "$filter" "$PROFILES_FILE" > "$tmp"; then
    rm -f "$tmp"
    printf 'hub: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  mv -f "$tmp" "$PROFILES_FILE"
}

# hub setup: checks the hub answers, makes <harness>-smart-auto the default and planner profile,
# enables that harness, and turns hub mode on. Running it again changes nothing.
hub_setup() {
  local harness="opencode" profile
  while [ $# -gt 0 ]; do
    case "$1" in
      --harness) shift; harness="${1:-}" ;;
      *) printf 'hub setup: unknown argument %s\n  usage: %s\n' "$1" "$HUB_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  in_list "$harness" "$HUB_HARNESSES" \
    || { printf 'hub setup: --harness must be one of: %s\n' "$HUB_HARNESSES" >&2; return 2; }
  orch_load_env_file
  [ -n "${LLM_HUB_URL:-}" ] \
    || { printf 'hub setup: set LLM_HUB_URL (and LLM_HUB_KEY if the hub needs one) in %s/env\n' "$ORCH_HOME" >&2; return 2; }
  [ "$(hub_api GET /healthz 2>/dev/null)" = "ok" ] \
    || { printf 'hub setup: %s/healthz did not answer ok\n' "${LLM_HUB_URL%/}" >&2; return 1; }
  profile="$harness-smart-auto"
  profile_require "$profile" >/dev/null || return 2
  hub_settings_write '
    .settings.llm_hub = ((.settings.llm_hub // {}) + {mode: "smart-auto", harness: $h})
    | .settings.llm_hub.role_tiers //= $d
    | .settings.default_profile = $p
    | .settings.planner_profile = $p
    | .settings.disabled_harnesses = ((.settings.disabled_harnesses // []) - [$h])
    | .profiles[$p].enabled = true' \
    --arg h "$harness" --arg p "$profile" --argjson d "$HUB_ROLE_TIERS_DEFAULT" || return 1
  hub_status
}

hub_status() {
  jq -r '
    .settings as $s
    | "mode: \($s.llm_hub.mode // "off")",
      "harness: \($s.llm_hub.harness // "-")",
      "default_profile: \($s.default_profile // "-")",
      "planner_profile: \($s.planner_profile // "-")",
      "role_tiers: \(($s.llm_hub.role_tiers // {}) | to_entries | map("\(.key)=\(.value)") | join(" "))"
  ' "$PROFILES_FILE"
  orch_load_env_file
  if [ -z "${LLM_HUB_URL:-}" ]; then
    printf 'hub: LLM_HUB_URL not set\n'
  elif [ "$(hub_api GET /healthz 2>/dev/null)" = "ok" ]; then
    printf 'hub: %s ok\n' "${LLM_HUB_URL%/}"
  else
    printf 'hub: %s down\n' "${LLM_HUB_URL%/}"
  fi
}

cmd_hub() {
  require_jq "hub"
  ensure_home || return 1
  case "${1:-}" in
    setup) shift; hub_setup "$@" ;;
    off) hub_settings_write '.settings.llm_hub.mode = "off"' && hub_status ;;
    status) hub_status ;;
    resolve)
      shift
      [ -n "${1:-}" ] || { printf 'usage: %s\n' "$HUB_USAGE" >&2; return 2; }
      in_list "$1" "$SMART_AUTO_TIERS" || { printf 'hub resolve: tier must be one of: %s\n' "$SMART_AUTO_TIERS" >&2; return 2; }
      hub_resolve_json "$1" "${2:-}" || { printf 'hub resolve: the hub gave no pick\n' >&2; return 1; } ;;
    *) printf 'usage: %s\n' "$HUB_USAGE" >&2; return 2 ;;
  esac
}
