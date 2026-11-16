#!/usr/bin/env bash
# Tests for owners_job_bind_run: a dispatched job (owner_kind "job") is linked to the opencode session it
# started (opencode mints its own ses_ id), by first user message, else by a lone session in the time
# window. The fill then gives the node session cost, usage and a tier from its Smart Auto selector.
# Run with: bash owner-job-bind.test.sh
set -u
export ORCH_NO_ANNOUNCE=1 ORCH_OWNER_BIND_SECS=0 ORCH_OWNER_HUB=0
unset LLM_HUB_URL LLM_HUB_V1_URL LLM_HUB_KEY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_eq() {
  if [ "$2" = "$3" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}
expect_match() {
  if printf '%s' "$3" | grep -qE -e "$2"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in: %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'owner-job-bind: SKIP (no sqlite3)\n'
  printf 'owner-job-bind: %s passed, %s failed\n' 0 0
  exit 0
fi

home=$(mktemp -d)
export HARNESS_ORCH_HOME="$home"
bash "$SCRIPT" init >/dev/null 2>&1
o() { bash "$SCRIPT" "$@"; }
nf() { jq -r --arg n "$2" ".nodes[] | select(.id==\$n) | $3" "$home/runs/$1/state.json"; }
stamp() { date -u -r "$1" +%Y%m%d%H%M%S 2>/dev/null || date -u -d "@$1" +%Y%m%d%H%M%S; }

db="$home/fixture-opencode.db"
export ORCH_OPENCODE_DB="$db"
now=$(date +%s)
t1=$((now - 120))      # batch: a, b and c start in the same second
t2=$((now - 3600))     # d starts alone
rules='# Shared subagent rules

A coordinator points each dispatched prompt at this file.'
sess() { # id created(s) cost model first-user-text
  printf "insert into session_v2 values ('%s', NULL, 't', '{\"id\":\"%s\"}', %s, 1000, 200, 0, 50, 0, %s, %s, NULL, %s);\n" \
    "$1" "$4" "$3" "$(($2 * 1000))" "$((now * 1000))" "$((now * 1000))"
  jq -nc --arg t "$5" '{text: $t}' | sed "s/'/''/g" | { read -r d; printf "insert into session_message values ('m_%s', '%s', 'user', 1, %s, %s, '%s');\n" "$1" "$1" "$(($2 * 1000))" "$(($2 * 1000))" "$d"; }
}
{
  echo "create table session_v2 (id text, parent_id text, title text, model text, cost real, tokens_input int, tokens_output int,
    tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_created int, time_updated int, time_busy int, time_idle int);"
  echo "create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text);"
  # b's session starts first: only the prompt tells a and b apart.
  sess ses_jobBXXXXXXXXXXXXXXXXXXXXXXX $((t1 + 2)) 0.5 hub/smart-auto-balance "$rules

Task B: fix the fill."
  sess ses_jobAXXXXXXXXXXXXXXXXXXXXXXX $((t1 + 4)) 1.25 hub/smart-auto-balance "$rules

Task A: link jobs."
  sess ses_jobCXXXXXXXXXXXXXXXXXXXXXXX $((t1 + 3)) 2 hub/smart-auto-balance "$rules

Task C: done before."
  sess ses_jobDXXXXXXXXXXXXXXXXXXXXXXX $((t2 + 3)) 0.75 prov/real "some other launch text"
  # A root session long before every job: outside each window.
  sess ses_farXXXXXXXXXXXXXXXXXXXXXXXX $((t2 - 900)) 9 prov/real "$rules

Task A: link jobs."
} | sqlite3 "$db"

R=$(o run start "job bind")
for n in a b c d; do o node add "$R" "$n" "Node $n" >/dev/null; done
job() { # node start status prompt
  local id
  id="$(stamp "$2")-pid-1-1-$RANDOM"
  mkdir -p "$home/jobs/$id"
  ( source "$SCRIPT"; node_patch "$R" "$1" '.status = $st | .job_id = $j | .owner = $j | .owner_kind = "job" | .owner_id = $j
      | .model = $m | .session = "0af43496-564a-4c0f-b8ae-49ef34198318" | .prompt = (if $p == "" then null else $p end)' \
      --arg st "$3" --arg j "$id" --arg m "${5:-hub/smart-auto-balance}" --arg p "$4" )
}
job a "$t1" running "$rules

Task A: link jobs."
job b "$t1" running "$rules

Task B: fix the fill."
job c "$t1" done "$rules

Task C: done before."
job d "$t2" running "" prov/real
jobs_before=$(jq -r '[.nodes[] | .job_id] | join(",")' "$home/runs/$R/state.json")

out=$(o node bind-owners --run "$R")
expect_match "bind: a by prompt" 'a: bound ses_jobAX+ \(job-prompt\)' "$out"
expect_match "bind: b by prompt" 'b: bound ses_jobBX+ \(job-prompt\)' "$out"
expect_match "bind: d alone in its window" 'd: bound ses_jobDX+ \(job-time\)' "$out"
expect_eq "a: owner_id" ses_jobAXXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" a .owner_id)"
expect_eq "b: owner_id" ses_jobBXXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" b .owner_id)"
expect_eq "c: done node bound" ses_jobCXXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" c .owner_id)"
expect_eq "a: kind session, bind job" "session job" "$(nf "$R" a '"\(.owner_kind) \(.owner_bind)"')"
expect_eq "job ids kept" "$jobs_before" "$(jq -r '[.nodes[] | .job_id] | join(",")' "$home/runs/$R/state.json")"
expect_eq "orch session kept" 0af43496-564a-4c0f-b8ae-49ef34198318 "$(nf "$R" a .session)"

# The fill: session cost and usage, tier from the selector, final totals for the done node.
expect_eq "a: cost" "1.25 opencode-session" "$(nf "$R" a '"\(.cost.usd) \(.cost.cost_basis)"')"
expect_eq "a: usage" "1000 200 50" "$(nf "$R" a '"\(.cost.input_tokens) \(.cost.output_tokens) \(.cost.cache_read_tokens)"')"
expect_eq "a: session_stats" ses_jobAXXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" a .session_stats.session)"
expect_eq "a: tier from selector" balance "$(nf "$R" a .tier)"
expect_eq "c: final cost" "2 true" "$(nf "$R" c '"\(.cost.usd) \(.session_stats.final)"')"
expect_eq "d: real model as actual" prov/real "$(nf "$R" d .actual_model)"
expect_eq "d: no selector, no tier" null "$(nf "$R" d .tier)"
expect_eq "a: running job node is not stalled by session idle" null "$(nf "$R" a .stalled)"

# Liveness stays with the job: verify-owners leaves job-bound nodes to `run sync`.
o node verify-owners "$R" >/dev/null
expect_eq "verify: no owner_state from the session" null "$(nf "$R" a .owner_state)"

# A second pass binds nothing new and keeps the bindings.
out=$(o node bind-owners --run "$R")
expect_eq "second pass: no rebind" "" "$(printf '%s' "$out" | grep 'bound' || true)"
expect_eq "second pass: a kept" ses_jobAXXXXXXXXXXXXXXXXXXXXXXX "$(nf "$R" a .owner_id)"

# A status change keeps the job binding (owner_register does not re-parse the job text).
o node update "$R" a done >/dev/null 2>&1
expect_eq "status change: binding kept" "session ses_jobAXXXXXXXXXXXXXXXXXXXXXXX" "$(nf "$R" a '"\(.owner_kind) \(.owner_id)"')"

# Actual model, role and tier for herdr-launched Smart Auto nodes (no ses_ id, only a worker identity).
R2=$(o run start "hub actual")
for n in s w; do o node add "$R2" "$n" "Node $n" >/dev/null; done
( source "$SCRIPT"
  # s: the pick hub_node_settle stored fills the empty fields with no hub call.
  node_patch "$R2" s '.status = "done" | .model = "hub/smart-auto-balance" | .hub.actual = {model: "prov/settled", role: "coder", tier: "balance"}'
  # w: running, launched in a herdr pane: only its worker identity names it to the hub.
  node_patch "$R2" w '.status = "running" | .model = "hub/smart-auto-balance" | .model_id = "hub-smart-auto-balance"
    | .owner_kind = "session" | .owner_bind = "job" | .worker_identity = $w' --arg w "$R2/w/1" )
hub_log="$home/hub-calls.log"
ORCH_OWNER_HUB=1 LLM_HUB_URL=http://hub.invalid HUB_LOG="$hub_log" R2="$R2" bash -c '
  source "$1"
  hub_api() { printf "%s %s\n" "$1" "$2" >> "$HUB_LOG"
    case "$2" in *"worker=$R2%2Fw%2F1"*) printf "{\"selection\":{\"main\":{\"model\":\"prov/picked\",\"role\":\"tester\",\"tier\":\"balance\"}}}" ;; *) return 22 ;; esac; }
  owners_actual_run "$R2"' _ "$SCRIPT"
expect_eq "s: actual from .hub.actual" "prov/settled coder balance" "$(nf "$R2" s '"\(.actual_model) \(.role) \(.tier)"')"
expect_eq "w: actual from the worker selection" "prov/picked tester balance" "$(nf "$R2" w '"\(.actual_model) \(.role) \(.tier)"')"
expect_eq "hub asked by worker only" "GET /api/smart-auto/current?worker=$R2%2Fw%2F1" "$(cat "$hub_log" 2>/dev/null)"

# Dispatch through a Smart Auto profile derives the node tier from the profile model, so the node
# sends the Smart Auto worker header.
fake=$(mktemp -d)
printf '#!/usr/bin/env bash\nprintf "ARGS %%s\\n" "$*"\n' > "$fake/opencode"
chmod +x "$fake/opencode"
jq '.profiles["oc-auto"] = {harness: "opencode", model: "hub-smart-auto-balance", enabled: true, flags: [], env: {}, auth: []}' \
  "$home/profiles.json" > "$home/profiles.tmp" && mv "$home/profiles.tmp" "$home/profiles.json"
o node add "$R2" t "Node t" >/dev/null
job=$(env ORCH_HERDR=0 PATH="$fake:$PATH" bash "$SCRIPT" node dispatch "$R2" t --profile oc-auto "do t" 2>/dev/null)
expect_eq "t: tier from the profile model" balance "$(nf "$R2" t .tier)"
o wait "$job" --timeout 60 --interval 1 >/dev/null 2>&1
trash "$fake" 2>/dev/null || true

trash "$home" 2>/dev/null || true
printf 'owner-job-bind: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
