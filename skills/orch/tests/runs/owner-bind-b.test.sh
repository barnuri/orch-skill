#!/usr/bin/env bash
# Tests for the owner binder and filler, part B: opencode child listing, unbound and unowned, fill, copilot actual model (split from owner-bind.test.sh).
# Run with: bash owner-bind-b.test.sh
set -u
export ORCH_NO_ANNOUNCE=1
# The API paths only; the session-table parts point this at a fixture session table.
export ORCH_OPENCODE_DB=/nonexistent/opencode.db

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_match() {
  if printf '%s' "$3" | grep -qE -e "$2"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in: %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}
expect_eq() {
  if [ "$2" = "$3" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" >&2; failures=$((failures + 1))
}

fake=$(mktemp -d)
mkdir -p "$fake/bin"
export FAKE_DIR="$fake"
cat > "$fake/bin/opencode" <<'EOS'
#!/usr/bin/env bash
# fake: api GET /api/session --param parentID=X  |  api GET /api/session/<id>  |  .../message
path="$3"
echo "$*" >> "$FAKE_DIR/calls"
case "$path" in
  /api/session) [ -f "$FAKE_DIR/children.json" ] && cat "$FAKE_DIR/children.json" || { echo boom >&2; exit 1; } ;;
  */message) echo '{"data":[{"type":"assistant","time":{},"content":[]}]}' ;;
  /api/session/*) id="${path#/api/session/}"; [ -f "$FAKE_DIR/info-$id.json" ] && cat "$FAKE_DIR/info-$id.json" || { echo 'Error: 404 Not Found' >&2; exit 1; } ;;
esac
EOS
chmod +x "$fake/bin/opencode"
export PATH="$fake/bin:$PATH"
export ORCH_OWNER_CALL_TIMEOUT=5 ORCH_OWNER_CACHE_SECS=0 ORCH_OWNER_TOTAL_SECS=120
export ORCH_OWNER_BIND_SECS=0 ORCH_UNOWNED_SECS=0
# An inherited hub URL would win over the test home's env file.
unset LLM_HUB_URL LLM_HUB_V1_URL LLM_HUB_KEY
export OPENCODE_SESSION_ID=ses_parent

. "$(dirname "${BASH_SOURCE[0]}")/../test-home.sh"
new_home() { home=$(mktemp -d); export HARNESS_ORCH_HOME="$home"; seed_home "$home"; }
o() { bash "$SCRIPT" "$@"; }
nf() { jq -r --arg n "$2" ".nodes[] | select(.id==\$n) | $3" "$home/runs/$1/state.json"; }
now_ms() { printf '%s000' "$(date +%s)"; }
pend() { # child title offset-ms
  mkdir -p "$home/owners/pending"
  jq -nc --arg c "$1" --arg t "$2" --argjson ms "$(( $(date +%s) * 1000 + $3 ))" \
    '{child: $c, parent: "ses_parent", title: $t, created: "2026-01-01T00:00:00Z", created_ms: $ms}' > "$home/owners/pending/$1.json"
}

# 4. opencode child listing when there is no pending file
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"speed","label":"Make the test suites faster"}
{"op":"update","id":"speed","status":"running","owner":"agent (spawned)"}
OPS
now_s=$(date +%s)
jq -nc --argjson ms "$((now_s * 1000 + 3000))" --argjson old "$(( (now_s - 3600) * 1000 ))" '{data: [
  {id: "ses_k1", parentID: "ses_parent", title: "test suites speedup", time: {created: $ms}},
  {id: "ses_old", parentID: "ses_parent", title: "test suites", time: {created: $old}},
  {id: "ses_other", parentID: "ses_zzz", title: "test suites", time: {created: $ms}}]}' > "$fake/children.json"
out=$(o node bind-owners --run "$R")
expect_match "listing: bound" 'speed: bound ses_k1 \(listing-title\)' "$out"
rm -f "$fake/children.json"

# 5. nothing found: unbound reason (listing unavailable), then the unowned flag
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"x","label":"X node"}
{"op":"add","id":"y","label":"Y node"}
{"op":"update","id":"x","status":"running","owner":"agent (spawned)"}
{"op":"update","id":"y","status":"running"}
OPS
o node bind-owners --run "$R" >/dev/null
expect_match "unbound reason" 'listing unavailable' "$(nf "$R" x .owner_reason)"
expect_eq "unowned flag" true "$(nf "$R" y .unowned)"
expect_match "unowned reason" 'running without an owner' "$(nf "$R" y .owner_reason)"
expect_eq "unowned event once" 1 "$(grep -c '"unowned"' "$home/runs/$R/events.jsonl")"
o node bind-owners --run "$R" >/dev/null
expect_eq "unowned event still once" 1 "$(grep -c '"unowned"' "$home/runs/$R/events.jsonl")"

# 6. fill: only empty fields, never overwrite
new_home
R=$(o run start "bind")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"f1","label":"Fill one"}
{"op":"add","id":"f2","label":"Fill two"}
{"op":"update","id":"f1","status":"running","owner":"ses_fill1"}
{"op":"update","id":"f2","status":"running","owner":"ses_fill2"}
{"op":"report","id":"f2","model":"coordinator-model","input_tokens":7,"usd":0.5}
OPS
now_s=$(date +%s)
for s in fill1 fill2; do
  jq -nc --arg id "ses_$s" --argjson c "$((now_s * 1000))" '{data: {id: $id, model: {id: "prov/real-model"}, cost: 1.25, tokens: {input: 900, output: 100}, time: {created: $c, updated: $c}}}' > "$fake/info-ses_$s.json"
done
o node bind-owners --run "$R" >/dev/null
expect_eq "fill: model" prov/real-model "$(nf "$R" f1 .model)"
expect_eq "fill: input tokens" 900 "$(nf "$R" f1 .report.input_tokens)"
expect_eq "fill: output tokens" 100 "$(nf "$R" f1 .report.output_tokens)"
expect_eq "fill: usd" 1.25 "$(nf "$R" f1 .report.usd)"
expect_eq "fill: harness" opencode "$(nf "$R" f1 .harness)"
expect_eq "fill: last activity set" true "$(nf "$R" f1 '.last_activity != null')"
expect_eq "no overwrite: model" coordinator-model "$(nf "$R" f2 .model)"
expect_eq "no overwrite: tokens" 7 "$(nf "$R" f2 .report.input_tokens)"
expect_eq "no overwrite: usd" 0.5 "$(nf "$R" f2 .report.usd)"
expect_eq "fill: only tokens not set on f2 output" null "$(nf "$R" f2 .report.output_tokens)"

# 8. copilot: the real model from Copilot's own events.jsonl (main agent only, latest call wins).
new_home
cp_dir=$(mktemp -d)
export ORCH_COPILOT_SESSION_DIR="$cp_dir"
mkdir -p "$cp_dir/11111111-2222-3333-4444-555555555555"
{
  echo '{"type":"session.start","data":{"selectedModel":"auto"}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"user","model":"gpt-6-luna","responseModel":"gpt-6-luna"}}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"agent","model":"gpt-6.1-sol","responseModel":"gpt-6.1-sol"}}}'
  echo '{"type":"session.usage_record","data":{"usage":{"initiator":"sub-agent","model":"claude-sonnet-5.5","responseModel":"claude-sonnet-5-5"}}}'
} > "$cp_dir/11111111-2222-3333-4444-555555555555/events.jsonl"
R=$(o run start "copilot")
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"cp","label":"Copilot node"}
{"op":"update","id":"cp","status":"running","owner":"coordinator"}
OPS
( source "$SCRIPT"; node_patch "$R" cp '.adapter = "copilot" | .model = "copilot-auto" | .session = "11111111-2222-3333-4444-555555555555"' )
o node bind-owners --run "$R" >/dev/null
expect_eq "copilot: actual model from events.jsonl" gpt-6.1-sol "$(nf "$R" cp .actual_model)"
expect_eq "copilot: alias kept" copilot-auto "$(nf "$R" cp .model)"
o node batch "$R" >/dev/null <<'OPS'
{"op":"add","id":"cq","label":"Copilot no session file"}
{"op":"update","id":"cq","status":"running","owner":"coordinator"}
OPS
( source "$SCRIPT"; node_patch "$R" cq '.adapter = "copilot" | .session = "99999999-0000-0000-0000-000000000000"' )
o node bind-owners --run "$R" >/dev/null
expect_eq "copilot: no session file leaves actual unset" null "$(nf "$R" cq .actual_model)"
unset ORCH_COPILOT_SESSION_DIR

printf 'owner-bind-b: %s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
