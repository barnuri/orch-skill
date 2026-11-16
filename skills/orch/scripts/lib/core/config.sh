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

# A lowercase RFC-4122 v4 uuid. `claude --session-id` requires that exact shape.
new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
    return 0
  fi
  python3 -c 'import uuid; print(uuid.uuid4())'
}

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

# llm-hub serves its OpenAI-compatible API only under /v1, while LLM_HUB_URL may be configured
# with or without it. Exports LLM_HUB_V1_URL as that base with exactly one trailing /v1, so
# adapters and profile env refs (`${LLM_HUB_V1_URL}`) never have to guess. An LLM_HUB_V1_URL the
# caller already set wins, by the same "set, not non-empty" rule orch_load_env_file uses.
llm_hub_derive_v1_url() {
  local base="${LLM_HUB_URL:-}"
  [ -n "$base" ] || return 0
  [ -z "${LLM_HUB_V1_URL+x}" ] || return 0
  while [ "${base%/}" != "$base" ]; do base="${base%/}"; done
  base="${base%/v1}"
  export LLM_HUB_V1_URL="$base/v1"
}

# The temp file of a profiles.json rewrite: renamed over the target on success, trashed on any failure.
# A scratch file this process made: a plain move into the fallback trash dir (Finder `trash` costs ~1 s a call).
profiles_tmp_discard() {
  local dest
  [ -e "$1" ] || return 0
  dest="$TRASH_FALLBACK_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dest" 2>/dev/null && mv -f "$1" "$dest/" 2>/dev/null
  return 0
}

# Moves profiles.json.tmp.<pid> files whose writer is gone into the trash dir. A trap cannot
# clean up after SIGKILL, and the server's dispatch timeouts (health watcher, reconciler) kill
# with SIGKILL, so a call killed between a migration's jq and its commit left its temp file
# behind for good. Glob + `kill -0` are builtins: a pass with no strays forks nothing.
profiles_tmp_sweep() {
  local f pid
  for f in "$PROFILES_FILE".tmp.*; do
    [ -e "$f" ] || continue
    pid="${f##*.tmp.}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" = "$$" ] && continue
    kill -0 "$pid" 2>/dev/null && continue
    profiles_tmp_discard "$f"
  done
  return 0
}

# Signature of profiles.json plus this file: the migrations re-run only when either changes.
profiles_migration_sig() {
  local a b
  a=$(stat -f '%m:%z' "$PROFILES_FILE" 2>/dev/null || stat -c '%Y:%s' "$PROFILES_FILE" 2>/dev/null)
  b=$(stat -f '%m:%z' "${BASH_SOURCE[0]}" 2>/dev/null || stat -c '%Y:%s' "${BASH_SOURCE[0]}" 2>/dev/null)
  printf '%s|%s\n' "$a" "$b"
}
profiles_commit() {
  if cmp -s "$1" "$PROFILES_FILE"; then profiles_tmp_discard "$1"; return 0; fi
  mv -f "$1" "$PROFILES_FILE" && return 0
  profiles_tmp_discard "$1"
  return 1
}

# The profiles template with the overlay merged over it: settings and models/profiles keys merge,
# and an overlay entry replaces the template entry of the same name. Without an overlay it is the
# template bytes. Every reader of the template goes through this function.
profiles_template_merged() {
  if [ ! -f "$PROFILES_OVERLAY_FILE" ]; then
    cat "$TEMPLATES_DIR/profiles.json"
    return
  fi
  command -v jq >/dev/null 2>&1 || { printf 'orch: jq is needed to merge %s\n' "$PROFILES_OVERLAY_FILE" >&2; return 1; }
  jq -s '
    .[0] as $t | .[1] as $o
    | $t
    | .defaults = ($t.defaults // {}) * ($o.defaults // {})
    | .settings = ($t.settings // {}) * ($o.settings // {})
    | .models = ($t.models // {}) + ($o.models // {})
    | .profiles = ($t.profiles // {}) + ($o.profiles // {})
  ' "$TEMPLATES_DIR/profiles.json" "$PROFILES_OVERLAY_FILE"
}

ensure_home() {
  mkdir -p "$ORCH_HOME" "$JOBS_HOME" "$RUNS_HOME" \
    || { printf 'orch: cannot create %s\n' "$ORCH_HOME" >&2; return 1; }
  if [ ! -f "$PROFILES_FILE" ]; then
    local seed="$PROFILES_FILE.tmp.$$"
    if profiles_template_merged > "$seed" && mv -f "$seed" "$PROFILES_FILE"; then :; else
      profiles_tmp_discard "$seed"; return 1
    fi
  fi
  [ -f "$MEMORY_FILE" ] || printf '[]\n' > "$MEMORY_FILE"
  [ -f "$ORCH_HOME/serve.json" ] || cp "$TEMPLATES_DIR/serve.json" "$ORCH_HOME/serve.json" 2>/dev/null || true
  local marker="$ORCH_HOME/.migrations/profiles-main"
  profiles_tmp_sweep
  if [ "$(cat "$marker" 2>/dev/null)" != "$(profiles_migration_sig)" ]; then
    profiles_migrate || return 1
    mkdir -p "$ORCH_HOME/.migrations" 2>/dev/null && profiles_migration_sig > "$marker.tmp.$$" 2>/dev/null && mv -f "$marker.tmp.$$" "$marker" 2>/dev/null
  fi
  suggestions_seed || return 1
}

suggestions_seed() {
  [ -f "$SUGGESTIONS_FILE" ] || cp "$TEMPLATES_DIR/suggestions.json" "$SUGGESTIONS_FILE" \
    || printf '{"generated_at":"%s","suggestions":[]}\n' "$(now_iso)" > "$SUGGESTIONS_FILE"
}

# Adds models{}, learning defaults, the cursor Auto model, and catalog ids for legacy model
# slugs — never overwrites user edits (cursor-default is retargeted only while still on
# the old composer-1 default).
profiles_migrate() {
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$PROFILES_FILE" ] || return 0
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.copilot-profile-migrated" seed_copilot=true
  [ -e "$marker" ] && seed_copilot=false
  if ! jq --argjson seed_copilot "$seed_copilot" '
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
    | .models["cursor-auto"] //= {
        slug: "auto",
        harnesses: ["cursor-agent"],
        description: "Cursor picks the model per request (Auto).",
        cost: "metered",
        quality: "standard",
        speed: "fast",
        tags: ["cursor", "auto"]
      }
    | if $seed_copilot then
        .models["copilot-auto"] //= {
        slug: "auto",
        harnesses: ["copilot"],
        description: "Copilot CLI picks the model per request (auto routing).",
        cost: "subscription",
        quality: "standard",
        speed: "fast",
        tags: ["copilot", "auto"]
        }
        | .profiles["copilot-default"] //= {
        harness: "copilot",
        model: "copilot-auto",
        allowed_models: ["copilot-auto"],
        description: "GitHub Copilot CLI on Copilot subscription (headless -p).",
        cost: "subscription",
        quality: "standard",
        speed: "balanced",
        risk: "medium",
        enabled: true,
        strengths: ["implement", "review", "debug"],
        parallel_ok: true,
        priority: 8,
        flags: ["--allow-all-tools"],
        env: {},
        auth: []
        }
      else . end
    | if (.profiles["cursor-default"].model? // "") == "cursor-composer" then
        .profiles["cursor-default"].model = "cursor-auto"
        | .profiles["cursor-default"].allowed_models = ["cursor-auto"]
      else . end
    | if (.profiles["cursor-default"].auth? // []) == ["CURSOR_API_KEY"] then
        .profiles["cursor-default"].auth = []
      else . end
    | .profiles |= with_entries(
        if .value.harness? == "cursor-agent" then
          .value.flags = [ (.value.flags // [])[] | select(. != "--force") ]
        else . end
      )
    |     .settings.learning //= {
        auto_record_memory: true,
        auto_scan_on_finish: true,
        auto_apply_safe: true,
        min_samples: 3,
        recency_days: 30,
        dismiss_ttl_days: 30
      }
    | .settings.max_attempts //= 5
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
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  [ -e "$marker" ] || { : > "$marker" || return 1; }
  profiles_migrate_copilot_planner || return $?
  profiles_migrate_claude_planner || return $?
  profiles_migrate_bench_local || return $?
  profiles_migrate_claude_tiers || return $?
  profiles_migrate_smart_auto
}

# Seeds the shipped Smart Auto catalog entry and the four *-smart-auto profiles where the user has
# no entry of that name. User entries are never replaced, and the marker stops deleted profiles returning.
SMART_AUTO_PROFILE_NAMES='["claude-smart-auto","copilot-smart-auto","opencode-smart-auto","pi-smart-auto"]'
profiles_migrate_smart_auto() {
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.smart-auto-migrated"
  [ -e "$marker" ] && return 0
  if ! jq --argjson tpl "$(profiles_template_merged)" --argjson names "$SMART_AUTO_PROFILE_NAMES" '
    (if $tpl.models["hub-smart-auto-balance"] then .models["hub-smart-auto-balance"] //= $tpl.models["hub-smart-auto-balance"] else . end)
    | reduce $names[] as $name (.; if $tpl.profiles[$name] then .profiles[$name] //= $tpl.profiles[$name] else . end)
  ' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  : > "$marker"
}

COPILOT_WORKER_FLAGS='["--allow-all-tools","--allow-all-paths","--allow-all","--yolo","--no-ask-user","--autopilot"]'
COPILOT_PLANNER_FLAGS='["--context","long_context","--reasoning-effort","xhigh","--allow-all-tools","--allow-all-paths","--allow-all","--yolo","--no-ask-user","--autopilot"]'

# jq helpers prepended to the migrations. A migration only fills in what is missing: it never
# re-enables a disabled harness or profile, and moves settings.default_profile/planner_profile only
# while the setting is unset or names a profile that no longer exists (a choice the user made stays).
PROFILES_MIGRATE_JQ_DEFS='
  def setting_dangling($k): (.settings[$k] // "") as $v | $v == "" or (.profiles[$v] | not);
'

# One-time switch to the Copilot-led layout: copilot-default (Auto) becomes the default profile,
# a copilot-planner profile (Opus 5.5, 1M context) is seeded, Claude Code is disabled, and the
# planning limits get their defaults. Marker-guarded so a later user edit is never reverted.
# Every run it also splits a flag written as one string ("--a --b") into separate argv entries —
# the adapter passes each array element as one argument, so a joined string never parses.
profiles_migrate_copilot_planner() {
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.copilot-planner-migrated" seed=true
  [ -e "$marker" ] && seed=false
  if ! jq --argjson seed "$seed" --argjson worker "$COPILOT_WORKER_FLAGS" \
      --argjson planner "$COPILOT_PLANNER_FLAGS" "$PROFILES_MIGRATE_JQ_DEFS"'
    def split_joined:
      [ .[] | if type == "string" and test("^-[^\\s\"'"'"']*(\\s+[^\\s\"'"'"']+)+$")
              then (split("\\s+"; null) | .[]) else . end ];
    .profiles |= with_entries(if (.value.flags | type) == "array" then .value.flags |= split_joined else . end)
    | if $seed then
        .models["copilot-opus-5.5"] //= {
          slug: "claude-opus-5.5",
          harnesses: ["copilot"],
          description: "Claude Opus 5.5 through Copilot CLI; pair with --context long_context for the 1M window.",
          cost: "high", quality: "best", speed: "slow", max_complexity: "large",
          tags: ["copilot", "planning", "architecture", "long-context"]
        }
        | .profiles["copilot-planner"] //= {
          harness: "copilot",
          model: "copilot-opus-5.5",
          allowed_models: ["copilot-opus-5.5"],
          description: "Copilot CLI on Claude Opus 5.5, 1M context tier. Splits a goal into a task DAG for copilot-default workers.",
          cost: "high", quality: "best", speed: "slow", risk: "low", enabled: true,
          strengths: ["planning", "architecture", "decomposition"],
          avoid_for: ["trivial", "format"],
          min_complexity: "large", parallel_ok: false, priority: 8,
          flags: $planner, env: {}, auth: []
        }
        | if .profiles["copilot-default"]? then
            .profiles["copilot-default"].model = "copilot-auto"
            | .profiles["copilot-default"].allowed_models = ((.profiles["copilot-default"].allowed_models // []) + ["copilot-auto"] | unique)
            | .profiles["copilot-default"].flags = ((.profiles["copilot-default"].flags // []) as $f
                | $f + [ $worker[] | select(. as $w | $f | index($w) | not) ])
            | (if setting_dangling("default_profile") then .settings.default_profile = "copilot-default" else . end)
          else . end
        | .settings.max_parallel //= 4
        | .settings.max_nodes //= 12
        | .settings.max_attempts //= 5
        | .settings.planner_profile //= "copilot-planner"
      else . end
  ' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  [ -e "$marker" ] || { : > "$marker" || return 1; }
}

# One-time Claude Code re-enable, mirroring the Copilot layout: claude-sub is renamed to
# claude-default (enabled, parallel), a claude-planner profile (Opus 1M, xhigh effort) is seeded,
# the claude harness leaves disabled_harnesses, and the Copilot profiles fall back to their Claude
# twins when Copilot quota runs out. Every reference to claude-sub follows the rename.
# Marker-guarded so a later user edit is never reverted.
profiles_migrate_claude_planner() {
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.claude-planner-migrated"
  [ -e "$marker" ] && return 0
  if ! jq '
    def rename_ref: if . == "claude-sub" then "claude-default" else . end;
    (if .profiles["claude-sub"] and (.profiles["claude-default"] | not) then
       .profiles["claude-default"] = (.profiles["claude-sub"]
         | .parallel_ok = true | .priority = 8
         | .description = "Claude Code on Anthropic subscription (Sonnet). Default Claude worker, the Claude twin of copilot-default."
         | del(.min_complexity, .max_complexity))
       | del(.profiles["claude-sub"])
     else . end)
    | .profiles |= with_entries(if .value.fallback then .value.fallback |= rename_ref else . end)
    | .settings.default_profile |= (if . then rename_ref else . end)
    | .settings.planner_profile |= (if . then rename_ref else . end)
    | .models["claude-opus-1m"] //= {
        slug: "opus[1m]", harnesses: ["claude"],
        description: "Claude Opus with the 1M context window; the planner tier.",
        cost: "high", quality: "best", speed: "slow", max_complexity: "large",
        tags: ["planning", "architecture", "long-context"]
      }
    | .profiles["claude-planner"] //= {
        harness: "claude", model: "claude-opus-1m", allowed_models: ["claude-opus-1m"],
        description: "Claude Code on Opus, 1M context, xhigh effort. Splits a goal into a task DAG for claude-default workers.",
        cost: "high", quality: "best", speed: "slow", risk: "low", enabled: true,
        strengths: ["planning", "architecture", "decomposition"], avoid_for: ["trivial", "format"],
        min_complexity: "large", parallel_ok: false, priority: 8,
        flags: ["--effort", "xhigh", "--dangerously-skip-permissions"], env: {}, auth: []
      }
    | (if .profiles["copilot-default"] and .profiles["claude-default"] then
         .profiles["copilot-default"].fallback //= "claude-default" else . end)
    | (if .profiles["copilot-planner"] then .profiles["copilot-planner"].fallback //= "claude-planner" else . end)
  ' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  : > "$marker"
}

# One-time switch to the local models that passed the 2026-10-04 local-llm benchmark. The new
# catalog entries and llm-hub profiles are seeded from the shipped template (never over a user's
# own), claude-llm-hub moves to qwen3.6-35b (serial: llama-swap holds one big model) only while it
# still runs a not-fit model or the old ornith-1.0-35b default, and the claude llm-hub profiles get the model tier pins Claude Code needs
# against a gateway. cursor-llm-hub (stock cursor-agent cannot reach a local endpoint), local-qwen
# and local-qwen3 go only while they still run a not-fit model, and every reference to them
# follows. A not-fit catalog entry is dropped only once no profile uses it — otherwise the slug
# reduce in profiles_migrate would recreate it as a stub. The opencode, local-llm and pi harnesses
# leave disabled_harnesses. Marker-guarded so a later user edit is never reverted.
profiles_migrate_bench_local() {
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.bench-local-migrated"
  [ -e "$marker" ] && return 0
  if ! jq --argjson tpl "$(profiles_template_merged)" '
    ["local-lfm-8b", "local-lfm-2.6b", "local-qwen3-4b"] as $notfit
    | ["local-qwen3.6-35b", "local-ornith-1.0-35b", "local-ornith-1.5-35b",
       "local-qwen3-coder-next", "local-ornith-1.5-9b"] as $new_models
    | ["claude-llm-hub-planner", "copilot-llm-hub", "opencode-llm-hub", "pi-llm-hub",
       "local-llm-fast"] as $new_profiles
    | (($tpl.profiles["claude-llm-hub"].env // {})
        | with_entries(select(.key | test("^ANTHROPIC_(MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL)$|^CLAUDE_CODE_")))) as $pins
    | def notfit_model: (.model // "") as $m | ($m == "" or ($notfit | index($m)) != null);
      def pattern_allows($slug): endswith("*") and ($slug | startswith(.[:-1]));
    reduce $new_models[] as $id (.; if $tpl.models[$id] then .models[$id] //= $tpl.models[$id] else . end)
    | (if .profiles["claude-llm-hub"]
          and (.profiles["claude-llm-hub"] | (notfit_model and .model != "")
               or .model == "local-ornith-1.0-35b") then
         .models["local-qwen3.6-35b"].slug as $slug
         | .profiles["claude-llm-hub"].model = "local-qwen3.6-35b"
         | .profiles["claude-llm-hub"].parallel_ok = false
         | .profiles["claude-llm-hub"].allowed_models |= (
             if type != "array" or any(.[]; . == "local-qwen3.6-35b" or pattern_allows($slug)) then .
             else . + ["local-qwen3.6-35b"] end)
       else . end)
    | .models as $catalog
    | .profiles |= with_entries(
        if .value.harness == "claude"
           and (($catalog[.value.model // ""].slug // .value.model // "") | startswith("llama_swap/")) then
          .value.env = ($pins + (.value.env // {}))
        else . end)
    | ([ (if .profiles["cursor-llm-hub"] | (.harness == "cursor-agent" and notfit_model)
          then "cursor-llm-hub" else empty end),
         (if .profiles["local-qwen"] | (. != null and notfit_model and .model != "")
          then "local-qwen" else empty end),
         (if .profiles["local-qwen3"] | (. != null and notfit_model and .model != "")
          then "local-qwen3" else empty end) ]) as $gone
    | def retarget: . as $ref
        | if ($gone | index($ref)) == null then .
          elif . == "cursor-llm-hub" then "copilot-llm-hub"
          else "local-llm-fast" end;
    reduce $gone[] as $name (.; del(.profiles[$name]))
    | .profiles |= with_entries(if .value.fallback then .value.fallback |= retarget else . end)
    | .settings.default_profile |= (if . then retarget else . end)
    | .settings.planner_profile |= (if . then retarget else . end)
    | reduce $new_profiles[] as $name (.; if $tpl.profiles[$name] then .profiles[$name] //= $tpl.profiles[$name] else . end)
    | ([ .profiles[] | .model // empty ]) as $used
    | reduce ($notfit[] | select(. as $id | $used | index($id) | not)) as $id (.; del(.models[$id]))
    | .models as $catalog
    | .profiles |= with_entries(
        if (.value.allowed_models | type) == "array" then
          .value.allowed_models |= map(select(. as $a | ($notfit | index($a)) == null or $catalog[$a] != null))
        else . end)
    | ([ .profiles[] | select(.harness == "cursor-agent") | .model // empty ]) as $cursor_models
    | (if .models["local-ornith-1.0-35b"] and ($cursor_models | index("local-ornith-1.0-35b") | not) then
         .models["local-ornith-1.0-35b"].harnesses |= map(select(. != "cursor-agent"))
       else . end)
  ' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  : > "$marker"
}

# One-time switch to the three Claude subscription tiers: claude-planner (Opus) plans,
# claude-default (Sonnet) is the default worker, claude-haiku (Haiku 5.5) takes small tasks.
# claude-haiku and its catalog entry are seeded from the template, or replaced while still on the
# old trivial-only shape; the planner description is refreshed while still the shipped one, and
# claude-default outranks copilot-default while both keep their shipped priorities. The default and
# planner settings move only when their Claude profile exists.
# Marker-guarded so a later user edit is never reverted.
profiles_migrate_claude_tiers() {
  local tmp="$PROFILES_FILE.tmp.$$" marker="$ORCH_HOME/.claude-tiers-migrated"
  [ -e "$marker" ] && return 0
  if ! jq --argjson tpl "$(profiles_template_merged)" "$PROFILES_MIGRATE_JQ_DEFS"'
    $tpl as $t
    | (if (.models["claude-haiku"] | not)
          or .models["claude-haiku"].description == "Fast and cheap: typos, formatting, tiny edits, boilerplate." then
         .models["claude-haiku"] = $t.models["claude-haiku"] else . end)
    | (if (.profiles["claude-haiku"] | not) or .profiles["claude-haiku"].max_complexity == "trivial" then
         .profiles["claude-haiku"] = $t.profiles["claude-haiku"] else . end)
    | (if .profiles["claude-planner"].description? == "Claude Code on Opus, 1M context, xhigh effort. Splits a goal into a task DAG for claude-default workers." then
         .profiles["claude-planner"].description = $t.profiles["claude-planner"].description else . end)
    | (if .profiles["claude-default"].priority? == 8 then .profiles["claude-default"].priority = 9 else . end)
    | (if .profiles["copilot-default"].priority? == 9 then .profiles["copilot-default"].priority = 8 else . end)
    | (if .profiles["claude-default"] and setting_dangling("default_profile") then .settings.default_profile = "claude-default" else . end)
    | (if .profiles["claude-planner"] and setting_dangling("planner_profile") then .settings.planner_profile = "claude-planner" else . end)
  ' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profiles migrate: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp" || return 1
  : > "$marker"
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

# profile_effective <name> [<node-override-json>]: the effective value of each profile key and where
# it came from (node, profile, defaults, builtin). Order: node override, profile, defaults, builtin.
# env is merged key by key (defaults first, profile wins); flags are replaced, not merged.
# Prints a JSON object {key: {value, source}}. Shared rule with src/shared effectiveProfile().
PROFILE_EFFECTIVE_KEYS="parallel_ok max_parallel flags env timeout_min retry stall_min effort tier role cost quality speed risk"
profile_effective() {
  local name="$1" node="${2:-}" json
  require_jq "profile effective"
  json=$(profile_require "$name") || return $?
  [ -n "$node" ] || node='{}'
  jq -n --argjson p "$json" --argjson d "$(jq -c '.defaults // {}' "$PROFILES_FILE")" --argjson n "$node" \
    --arg keys "$PROFILE_EFFECTIVE_KEYS" '
    def builtin: {parallel_ok: true, max_parallel: 15, flags: [], env: {}};
    def pick($k):
      if $n | has($k) then {value: $n[$k], source: "node"}
      elif $p | has($k) then {value: $p[$k], source: "profile"}
      elif $d | has($k) then {value: $d[$k], source: "defaults"}
      elif builtin | has($k) then {value: builtin[$k], source: "builtin"}
      else {value: null, source: "builtin"} end;
    reduce ($keys | split(" ")[]) as $k ({}; . + {($k): pick($k)})
    | .env = {value: (($d.env // {}) + ($p.env // {}) + ($n.env // {})),
              source: (if ($n | has("env")) then "node" elif ($p | has("env")) then "profile" elif ($d | has("env")) then "defaults" else "builtin" end)}
  '
}

# Sets PROFILE_NAME / PROFILE_HARNESS / PROFILE_MODEL / PROFILE_FLAGS[] and exports the profile's
# env. Exit 2 = bad profile definition, exit 3 ($PROFILE_UNCONFIGURED_RC) = the profile is fine
# but its declared env/auth is not set, exit 1 = anything else.
# harness_disabled <id>: 0 when settings.disabled_harnesses lists it. A profile on such a harness
# cannot run: routing already skips it, and profile_load refuses it, so it is never "active".
harness_disabled() {
  [ -f "$PROFILES_FILE" ] || return 1
  jq -e --arg h "$1" '(.settings.disabled_harnesses // []) | index($h) != null' "$PROFILES_FILE" >/dev/null 2>&1
}

profile_load() {
  local name="$1" json
  require_jq "profile $name"
  ensure_home || return 1
  orch_load_env_file
  llm_hub_derive_v1_url
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
    PROFILE_MODEL_BEHAVES_AS=$(model_behaves_as_resolve "$name" "$PROFILE_MODEL_ID")
  else
    PROFILE_MODEL=""
    PROFILE_MODEL_BEHAVES_AS=""
  fi
  if ! in_list "$PROFILE_HARNESS" "$VALID_HARNESSES"; then
    printf 'profile %s: harness "%s" must be one of: %s\n' "$name" "$PROFILE_HARNESS" "$VALID_HARNESSES" >&2
    return 2
  fi
  if harness_disabled "$PROFILE_HARNESS"; then
    printf 'profile %s: harness "%s" is disabled (settings.disabled_harnesses); enable it on the Harnesses page first\n' "$name" "$PROFILE_HARNESS" >&2
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
    return "$PROFILE_UNCONFIGURED_RC"
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
    value=$(profile_resolve_env_value "$name" "$key" "$value") || return $?
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
      return "$PROFILE_UNCONFIGURED_RC"
    fi
  done <<EOF
$(printf '%s' "$json" | jq -r '.auth[]? // empty')
EOF
}

# `settings get <key>` / `settings set <key> <value>` for the profile defaults (defaults.<key>).
# Validated: max_parallel is an integer 1..32, parallel_ok a boolean. Writes via profiles_commit.
SETTINGS_USAGE='dispatch.sh settings get defaults.<key> | set defaults.<key> <value>'
cmd_settings() {
  local sub="${1:-}" key="${2:-}" value="${3:-}" tmp
  require_jq "settings"
  ensure_home || return 1
  case "$sub" in
    get)
      [ -n "$key" ] || { printf 'usage: %s\n' "$SETTINGS_USAGE" >&2; return 2; }
      jq -r --arg k "${key#defaults.}" '.defaults[$k] // "null" | tojson' "$PROFILES_FILE"
      ;;
    set)
      [ -n "$key" ] && [ $# -ge 3 ] || { printf 'usage: %s\n' "$SETTINGS_USAGE" >&2; return 2; }
      case "$key" in
        defaults.max_parallel)
          is_uint "$value" && [ "$value" -ge 1 ] && [ "$value" -le 32 ] || { printf 'settings set: defaults.max_parallel must be an integer 1-32\n' >&2; return 2; }
          value_json="$value" ;;
        defaults.parallel_ok)
          case "$value" in true|false) value_json="$value" ;; *) printf 'settings set: defaults.parallel_ok must be true or false\n' >&2; return 2 ;; esac ;;
        *) printf 'settings set: unknown key %s (settable: defaults.max_parallel, defaults.parallel_ok)\n' "$key" >&2; return 2 ;;
      esac
      tmp="$PROFILES_FILE.tmp.$$"
      if jq --argjson v "$value_json" --arg k "${key#defaults.}" '.defaults = ((.defaults // {}) + {($k): $v}) | if $k == "max_parallel" then del(.settings.max_parallel) else . end' "$PROFILES_FILE" > "$tmp" \
        && profiles_commit "$tmp"; then
        printf '%s = %s\n' "$key" "$value_json"
      else
        profiles_tmp_discard "$tmp"; printf 'settings set: could not write profiles.json\n' >&2; return 1
      fi
      ;;
    *) printf 'usage: %s\n' "$SETTINGS_USAGE" >&2; return 2 ;;
  esac
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
      [ -n "${2:-}" ] || { printf 'usage: dispatch.sh profile show <name> [--effective]\n' >&2; return 2; }
      if [ "${3:-}" = "--effective" ]; then
        profile_effective "$2" | jq -r 'to_entries[] | "\(.key)\t\(.value.value | tojson)\t\(.value.source)"'
        return "${PIPESTATUS[0]}"
      fi
      profile_require "$2" | jq .
      return "${PIPESTATUS[0]}"
      ;;
    pick) shift; cmd_profile_pick "$@" ;;
    sanity) shift; cmd_profile_sanity "$@" ;;
    unset-env) shift; cmd_profile_unset_env "$@" ;;
    sync-overlay) shift; cmd_profile_sync_overlay "$@" ;;
    *) printf 'usage: dispatch.sh profile list | show <name> | pick "<task>" [--complexity …] [--kind K] | sanity [--profile NAME] | unset-env <name> <VAR>...\n' >&2; return 2 ;;
  esac
}

# Adds the profiles (and their models) of the gitignored overlay that the live profiles.json lacks.
# Never overwrites a profile that already exists, so a user edit stays.
cmd_profile_sync_overlay() {
  local tmp="$PROFILES_FILE.tmp.$$" before after replace='[]'
  if [ "${1:-}" = "--replace" ]; then shift; replace=$(printf '%s\n' "$@" | jq -R . | jq -sc .); fi
  [ -f "$PROFILES_OVERLAY_FILE" ] || { printf 'profile sync-overlay: no overlay at %s\n' "$PROFILES_OVERLAY_FILE" >&2; return 1; }
  before=$(jq -r '.profiles | keys | length' "$PROFILES_FILE")
  if ! jq --argjson rep "$replace" --slurpfile ov "$PROFILES_OVERLAY_FILE" '
    .profiles = ((.profiles | with_entries(select(.key as $k | $rep | index($k) | not))) as $keep
      | (($ov[0].profiles // {}) | with_entries(select(.key as $k | ($rep | index($k)) != null or ($keep[$k] == null)))) + $keep)
    | .models = (($ov[0].models // {}) + (.models // {}))
    | .models |= (. + (($ov[0].models // {}) | with_entries(select(.key as $k | ($rep | length) > 0 and ($ov[0].profiles | to_entries | map(select(.key as $p | $rep | index($p) != null) | .value.model) | index($k) != null)))))' "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"; printf 'profile sync-overlay: could not merge\n' >&2; return 1
  fi
  profiles_commit "$tmp" || return 1
  after=$(jq -r '.profiles | keys | length' "$PROFILES_FILE")
  printf 'profile sync-overlay: %s profile(s) added\n' "$((after - before))"
}

# Drops env vars from one profile's env map. Other profiles and keys stay as written.
cmd_profile_unset_env() {
  local name="${1:-}" tmp="$PROFILES_FILE.tmp.$$"
  [ -n "$name" ] && [ $# -ge 2 ] || { printf 'usage: dispatch.sh profile unset-env <name> <VAR>...\n' >&2; return 2; }
  shift
  profile_require "$name" >/dev/null || return $?
  if ! jq --arg n "$name" '.profiles[$n].env |= ((. // {}) | with_entries(select(.key as $k | $ARGS.positional | index($k) | not)))' \
    --args "$@" < "$PROFILES_FILE" > "$tmp"; then
    profiles_tmp_discard "$tmp"
    printf 'profile unset-env: could not update %s\n' "$PROFILES_FILE" >&2
    return 1
  fi
  profiles_commit "$tmp"
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
