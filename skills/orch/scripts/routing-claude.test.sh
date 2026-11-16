#!/usr/bin/env bash
# dispatch.sh tests: routing and learning, claude and pi adapters
# Run: bash routing-claude.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

# --- routing + learning -------------------------------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
orch init >/dev/null
out=$(orch profile pick "fix a typo" --complexity trivial 2>&1)
expect_match "profile pick prints profile" '^profile=' "$out"
expect_match "profile pick prints model id" '^model=' "$out"
out=$(orch model list --profile claude-default 2>&1)
expect_match "model list includes catalog id" 'claude-sonnet' "$out"
edit_json "$home/profiles.json" '
  .models["local-lfm-8b"] = {
    "slug": "llama_swap/lfm2.5-8b-a1b",
    "harnesses": ["local-llm", "claude"],
    "description": "bench winner"
  }
  | .models["local-qwen3-4b"] = {
    "slug": "llama_swap/qwen3-4b-2507",
    "harnesses": ["local-llm", "claude"],
    "description": "backup"
  }
  | .profiles["claude-llm-hub"] = {
    "harness": "claude",
    "model": "local-lfm-8b",
    "allowed_models": ["llama_swap*"],
    "flags": [],
    "env": {},
    "auth": []
  }'
out=$(orch model list --profile claude-llm-hub 2>&1)
expect_match "model list expands llama_swap pattern" 'local-lfm-8b' "$out"
expect_match "model list includes second llama_swap model" 'local-qwen3-4b' "$out"
expect_no_match "model list excludes non-llama_swap" 'claude-sonnet' "$out"
edit_json "$home/profiles.json" '.profiles["opencode-default"].description = ""'
out=$(orch suggest scan 2>&1); rc=$?
expect_match "suggest scan completes" 'scanned' "$out"
expect_exit "suggest scan exits 0" 0 "$rc"
out=$(orch suggest list --pending 2>&1)
expect_match "suggest list finds empty description" 'profile_description' "$out"
desc_id=$(orch suggest list --pending 2>&1 | awk -F'\t' '$3 == "profile_description" && $4 ~ /opencode-default/ {print $1; exit}')
out=$(orch suggest apply "$desc_id" 2>&1); rc=$?
expect_exit "suggest apply profile_description exits 0" 0 "$rc"
out=$(jq -r '.profiles["opencode-default"].description // ""' "$home/profiles.json")
expect_match "suggest apply profile_description writes description" '.' "$out"
edit_json "$home/suggestions.json" '.suggestions += [{
  "id": "sug-test", "status": "pending", "created": "2026-01-01T00:00:00Z",
  "confidence": "medium", "kind": "memory_record",
  "title": "Record memory", "reason": "test",
  "evidence": [], "fingerprint": "memory_record:claude-default:test",
  "action": {"type": "memory_record", "memory": {"profile": "claude-default", "outcome": "success", "task_kind": "test", "note": "from test"}}
}]'
out=$(orch suggest apply sug-test 2>&1); rc=$?
expect_exit "suggest apply memory_record exits 0" 0 "$rc"
out=$(orch memory list --profile claude-default 2>&1)
expect_match "suggest apply memory_record writes memory" 'from test' "$out"
out=$(orch suggest apply --json --id sug-test 2>&1); rc=$?
expect_match "suggest apply batch json reports failure for applied id" '"ok":false' "$out"
edit_json "$home/profiles.json" '.models["claude-haiku"].description = ""'
orch suggest scan >/dev/null
out=$(orch suggest apply --json --all 2>&1); rc=$?
expect_exit "suggest apply all exits 0" 0 "$rc"
expect_match "suggest apply all returns json" '"results":' "$out"

# bash 3.2 reuses one $RANDOM seed across a subshell tree, which once gave every suggestion from
# a single scan the same id and made `run finish` print "sug-… is pending … not pending".
ids=$(env HARNESS_ORCH_HOME="$home" bash -c '. "$1"; ( : $RANDOM; for i in 1 2 3 4; do echo "$(suggest_new_id)"; done )' _ "$SCRIPT")
expect_match "suggestion ids stay unique inside a seeded subshell" '^4$' "$(printf '%s\n' "$ids" | sort -u | wc -l | tr -d ' ')"
orch run start "Ids" --id sug-ids >/dev/null 2>&1
for n in one two three; do
  orch node add sug-ids "$n" "Kind $n" --profile local-llm-fast >/dev/null 2>&1
  orch node update sug-ids "$n" done >/dev/null 2>&1
done
edit_json "$home/profiles.json" '.settings.learning.auto_record_memory = false'
out=$(env HARNESS_ORCH_HOME="$home" bash -c '( : $RANDOM; bash "$1" run finish sug-ids )' _ "$SCRIPT" 2>&1)
expect_no_match "run finish applies its suggestions quietly" 'not pending' "$out"
expect_match "every suggestion keeps its own id" '^0$' \
  "$(jq '[.suggestions[].id] | length - (unique | length)' "$home/suggestions.json")"
edit_json "$home/profiles.json" '.settings.learning.auto_record_memory = true'
edit_json "$home/suggestions.json" '.suggestions += [
  {"id": "sug-dup", "status": "pending", "created": "2026-01-01T00:00:00Z", "kind": "memory_record",
   "fingerprint": "memory_record:local-llm-fast:dup-a",
   "action": {"type": "memory_record", "memory": {"profile": "local-llm-fast", "outcome": "success", "task_kind": "dup-a"}}},
  {"id": "sug-dup", "status": "pending", "created": "2026-01-01T00:00:00Z", "kind": "memory_record",
   "fingerprint": "memory_record:local-llm-fast:dup-b",
   "action": {"type": "memory_record", "memory": {"profile": "local-llm-fast", "outcome": "success", "task_kind": "dup-b"}}}]'
out=$(orch suggest apply sug-dup 2>&1); rc=$?
expect_exit "a duplicated id is repaired before apply" 0 "$rc"
expect_match "the repaired copy gets its own id" '^1$' \
  "$(jq '[.suggestions[] | select(.id | startswith("sug-dup-"))] | length' "$home/suggestions.json")"
out=$(orch profile sanity --profile nope 2>&1); rc=$?
expect_exit "profile sanity unknown profile exits 0" 0 "$rc"
expect_match "profile sanity unknown profile ok false" '"ok":false' "$out"
expect_match "profile sanity unknown profile error" 'unknown profile' "$out"
edit_json "$home/profiles.json" '.profiles["claude-default"].enabled = false'
out=$(orch profile sanity --profile claude-default 2>&1); rc=$?
expect_exit "profile sanity disabled exits 0" 0 "$rc"
expect_match "profile sanity disabled ok false" '"ok":false' "$out"
expect_match "profile sanity disabled error" 'profile disabled' "$out"
cleanup_dir "$home"

# --- claude adapter + --profile grammar --------------------------------------
# Fake CLI shims print their argv one per line, so the exact argument shape can be asserted
# without running a real harness. The claude adapter now asks for `--output-format json`; since
# an argv echo is not a JSON object, these cases also cover its pass-through fallback — output it
# cannot parse reaches the log untouched.
home=$(new_tmp)
shims=$(new_tmp)
for tool in claude cursor-agent opencode copilot; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$shims/$tool"
  chmod +x "$shims/$tool"
done
with_shims() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" CURSOR_API_KEY=shim "$@"; }
joined() { printf '%s' "$1" | tr '\n' ' '; }

out=$(with_shims bash "$SCRIPT" run --profile claude-default "hi there" --extra 2>&1)
expect_match "claude profile: argv order is model, profile flags, pass-through" \
  '^-p hi there --output-format json --model sonnet --dangerously-skip-permissions --extra$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" profile sanity --profile claude-default 2>&1); rc=$?
expect_exit "profile sanity exits 0" 0 "$rc"
expect_match "profile sanity ok with shims" '"ok":true' "$out"
expect_match "profile sanity includes profile name" '"profile":"claude-default"' "$out"
expect_match "profile sanity includes ms" '"ms":' "$out"
expect_match "profile sanity includes harness" '"harness":"claude"' "$out"

edit_json "$home/profiles.json" '.profiles["cursor-default"].model = "gpt-5"'
out=$(with_shims bash "$SCRIPT" run --profile cursor-default "x" 2>&1)
expect_match "cursor profile: model flag, no forced permission bypass" \
  '^-p x --output-format text --model gpt-5$' "$(joined "$out")"
expect_no_match "the cursor adapter never forces --force" '\-\-force' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run --profile opencode-default "x" 2>&1)
expect_match "opencode profile with empty model: no model flag" '^run x --auto --standalone$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run --profile copilot-default "x" 2>&1)
expect_match "copilot profile: model flag, permission bypass from profile flags" \
  '^-p x --silent --model auto --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot$' "$(joined "$out")"
expect_no_match "the copilot adapter never bakes in --allow-all-tools" \
  '^-p x --silent --allow-all-tools --model' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run --profile copilot-planner "x" 2>&1)
expect_match "copilot planner: Opus 5.5 on the 1M context tier, headless flags" \
  '^-p x --silent --model claude-opus-5.5 --context long_context --reasoning-effort xhigh --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot$' \
  "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run copilot "plain" 2>&1)
expect_match "plain copilot adapter: no model flag, no permission bypass" \
  '^-p plain --silent$' "$(joined "$out")"

out=$(with_shims bash "$SCRIPT" run claude "plain" 2>&1)
expect_match "plain claude adapter: no model flag" '^-p plain --output-format json$' "$(joined "$out")"

out=$(env ORCH_RESUME_SESSION=resume-123 PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run claude "continue" 2>&1)
expect_match "claude adapter resumes with --resume" \
  '^-p continue --output-format json --resume resume-123$' "$(joined "$out")"

out=$(env ORCH_RESUME_SESSION=resume-123 PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run copilot "continue" 2>&1)
expect_match "copilot adapter resumes with --session-id" \
  '^-p continue --silent --session-id resume-123$' "$(joined "$out")"

out=$(env ORCH_RESUME_SESSION=ses_resume123 PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run opencode "continue" 2>&1)
expect_match "opencode adapter resumes with --session" \
  '^run continue --auto --standalone --session ses_resume123$' "$(joined "$out")"
out=$(env ORCH_RESUME_SESSION=resume-123 PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run opencode "continue" 2>&1)
expect_match "opencode adapter skips a session id opencode did not mint" \
  '^run continue --auto --standalone$' "$(joined "$out")"
out=$(with_shims bash "$SCRIPT" run opencode "x" --server http://127.0.0.1:4096 --pure 2>&1)
expect_match "opencode adapter: a named --server replaces --standalone, --pure is dropped" \
  '^run x --auto --server http://127.0.0.1:4096$' "$(joined "$out")"

out=$(env ORCH_RESUME_SESSION=cursor:abc PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run cursor-agent "continue" 2>&1)
expect_match "cursor adapter resumes with --resume when given a chat id" \
  '^-p continue --output-format text --resume cursor:abc$' "$(joined "$out")"

# --- pi adapter ---------------------------------------------------------------
# The pi shim prints its argv, then the env it was given, and copies the private agent dir's
# models.json plus a listing of that dir out to $pi_capture — the dir itself is gone (trashed)
# by the time a `run` returns. The user's agent dir is a fake one, so the real ~/.pi is untouched.
pi_shim=$(new_tmp)
pi_capture=$(new_tmp)
pi_user=$(new_tmp)
mkdir -p "$pi_user/skills/demo" "$pi_user/extensions"
printf '{"providers":{"mine":{}}}' > "$pi_user/models.json"
printf '{}' > "$pi_user/settings.json"
cat > "$pi_shim/pi" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@"
printf 'env PI_OFFLINE=%s PI_SKIP_VERSION_CHECK=%s PI_TELEMETRY=%s\n' "\$PI_OFFLINE" "\$PI_SKIP_VERSION_CHECK" "\$PI_TELEMETRY"
printf '%s\n' "\$PI_CODING_AGENT_DIR" > "$pi_capture/dir"
cp "\$PI_CODING_AGENT_DIR/models.json" "$pi_capture/models.json"
for e in "\$PI_CODING_AGENT_DIR"/*; do
  if [ -L "\$e" ]; then printf '%s -> %s\n' "\${e##*/}" "\$(readlink "\$e")"; else printf '%s\n' "\${e##*/}"; fi
done > "$pi_capture/listing"
EOF
chmod +x "$pi_shim/pi"
with_pi() {
  env -u LLM_HUB_V1_URL -u LLM_HUB_KEY PATH="$pi_shim:$PATH" HARNESS_ORCH_HOME="$home" \
    PI_CODING_AGENT_DIR="$pi_user" LLM_HUB_URL=http://hub:9 "$@"
}
edit_json "$home/profiles.json" '
  .models["hub-qwen"] = {slug: "qwen3-coder", harnesses: ["pi"], description: "hub model"}
  | .profiles["pi-test"] = {harness: "pi", model: "hub-qwen", flags: ["--thinking", "off"], env: {}, auth: []}'

out=$(with_pi bash "$SCRIPT" run --profile pi-test "do it" --extra 2>&1); rc=$?
expect_exit "pi profile exits 0" 0 "$rc"
expect_match "pi profile: hub model, placeholder key, headless flags, then profile flags and pass-through" \
  '^--model hub/qwen3-coder --approve --no-session -p do it --thinking off --extra env' "$(joined "$out")"
expect_match "pi runs offline with no version check or telemetry" \
  'env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0' "$out"
expect_no_match "the pi adapter adds no --no-skills of its own" '\-\-no-(skills|extensions)' "$out"
models=$(cat "$pi_capture/models.json" 2>/dev/null)
expect_match "models.json points provider hub at the /v1 base" \
  '^http://hub:9/v1 openai-completions llm-hub$' "$(printf '%s' "$models" | jq -r '.providers.hub | "\(.baseUrl) \(.api) \(.apiKey)"')"
expect_match "models.json carries the hub compat block" \
  '^\{"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsUsageInStreaming":false,"maxTokensField":"max_tokens","requiresToolResultName":true\}$' \
  "$(printf '%s' "$models" | jq -c '.providers.hub.compat')"
expect_match "models.json defines exactly the profile's model" \
  '^\[\{"id":"qwen3-coder","name":"qwen3-coder","reasoning":false,"input":\["text"\],"cost":\{"input":0,"output":0,"cacheRead":0,"cacheWrite":0\},"contextWindow":131072,"maxTokens":32768\}\]$' \
  "$(printf '%s' "$models" | jq -c '.providers.hub.models')"
expect_match "models.json defines only the hub provider" '^\["hub"\]$' "$(printf '%s' "$models" | jq -c '.providers | keys')"
listing=$(cat "$pi_capture/listing" 2>/dev/null)
expect_match "the user's skills are linked into the private agent dir" "^skills -> $pi_user/skills$" "$listing"
expect_match "the user's extensions are linked into the private agent dir" "^extensions -> $pi_user/extensions$" "$listing"
expect_match "the user's models.json is not linked, the generated one replaces it" '^models\.json$' "$listing"
expect_missing "a run's private agent dir is cleaned up afterwards" "$(cat "$pi_capture/dir" 2>/dev/null)"
expect_match "the user's own models.json is untouched" '"mine"' "$(cat "$pi_user/models.json")"

out=$(with_pi LLM_HUB_KEY=hub-secret bash "$SCRIPT" run --profile pi-test "x" 2>&1)
expect_no_match "the hub key never appears on the pi command line" 'hub-secret' "$(joined "$out")"
expect_match "models.json references the key instead of holding it" '^\$LLM_HUB_KEY$' \
  "$(jq -r '.providers.hub.apiKey' "$pi_capture/models.json" 2>/dev/null)"
expect_no_match "the key value is never written to models.json" 'hub-secret' "$(cat "$pi_capture/models.json" 2>/dev/null)"

pi_job=$(new_tmp)
out=$(with_pi ORCH_JOB_DIR="$pi_job" LLM_HUB_MODEL=m1 bash "$SCRIPT" run pi "x" 2>&1)
expect_match "plain pi adapter takes the model from LLM_HUB_MODEL" '^--model hub/m1 --approve --no-session -p x env' "$(joined "$out")"
expect_match "with a job dir the private agent dir lives inside it" "^$pi_job/pi-agent$" "$(cat "$pi_capture/dir" 2>/dev/null)"
expect_file "the job's agent dir is kept with the job" "$pi_job/pi-agent/models.json"
cleanup_dir "$pi_job"

out=$(with_pi bash "$SCRIPT" run --profile pi-llm-hub "x" 2>&1); rc=$?
expect_exit "shipped pi-llm-hub profile exits 0" 0 "$rc"
expect_match "pi-llm-hub runs ornith-1.5-35b as bare as the benchmark did" \
  '^--model hub/llama_swap/ornith-1.5-35b --approve --no-session -p x --thinking off env' \
  "$(joined "$out")"

# The shipped llm-hub profiles for copilot and opencode, against shims that also report the env
# they were given. Only the URL and config are echoed — never the key.
hub_shims=$(new_tmp)
cat > "$hub_shims/copilot" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$@"
printf 'env %s %s %s %s\n' "$COPILOT_PROVIDER_BASE_URL" "$COPILOT_PROVIDER_TYPE" "$COPILOT_MODEL" "$COPILOT_OFFLINE"
SHIM
cat > "$hub_shims/opencode" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$@"
printf 'config %s\n' "$OPENCODE_CONFIG_CONTENT"
SHIM
chmod +x "$hub_shims/copilot" "$hub_shims/opencode"
with_hub() {
  env -u LLM_HUB_V1_URL PATH="$hub_shims:$PATH" HARNESS_ORCH_HOME="$home" \
    LLM_HUB_URL=http://127.0.0.1:8888 LLM_HUB_KEY=dummy "$@"
}
out=$(with_hub bash "$SCRIPT" run --profile copilot-llm-hub "x" 2>&1); rc=$?
expect_exit "copilot-llm-hub exits 0" 0 "$rc"
expect_match "copilot-llm-hub: hub model, worker flags, then the isolation flags" \
  '^-p x --silent --model llama_swap/qwen3.6-35b --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot --no-auto-update --no-custom-instructions --disable-builtin-mcps env' \
  "$(joined "$out")"
expect_match "copilot-llm-hub points BYOK at the derived /v1 base" \
  '^env http://127.0.0.1:8888/v1 openai llama_swap/qwen3.6-35b true$' "$out"
out=$(with_hub bash "$SCRIPT" run --profile opencode-llm-hub "x" 2>&1); rc=$?
expect_exit "opencode-llm-hub exits 0" 0 "$rc"
expect_match "opencode-llm-hub: provider/model split of the hub slug, standalone server" \
  '^run x --auto --standalone -m llama_swap/qwen3-coder-next config' "$(joined "$out")"
oc_config=$(printf '%s\n' "$out" | sed -n 's/^config //p')
expect_match "opencode config is JSON whose model id is the full hub id" \
  '^\{env:LLM_HUB_V1_URL\} \{env:LLM_HUB_KEY\} llama_swap/qwen3-coder-next$' \
  "$(printf '%s' "$oc_config" | jq -r '.provider.llama_swap | "\(.options.baseURL) \(.options.apiKey) \(.models["qwen3-coder-next"].id)"')"
expect_match "shipped opencode profiles keep the user's skills (no OPENCODE_DISABLE_* env)" '^0$' \
  "$(jq -r '[.profiles | to_entries[] | select(.key | startswith("opencode-")) | .value.env // {} | keys[] | select(startswith("OPENCODE_DISABLE"))] | length' "$SCRIPT_DIR/../templates/profiles.json")"
edit_json "$home/profiles.json" '.profiles["opencode-smart-auto"].env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"'
HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile unset-env opencode-smart-auto OPENCODE_DISABLE_EXTERNAL_SKILLS >/dev/null 2>&1; rc=$?
expect_exit "profile unset-env exits 0" 0 "$rc"
expect_match "profile unset-env drops only the named var" '^OPENCODE_CONFIG_CONTENT$' \
  "$(jq -r '.profiles["opencode-smart-auto"].env | keys | join(",")' "$home/profiles.json")"
HARNESS_ORCH_HOME="$home" bash "$SCRIPT" profile unset-env opencode-smart-auto >/dev/null 2>&1; rc=$?
expect_exit "profile unset-env without a var is a usage error" 2 "$rc"
cleanup_dir "$hub_shims"

out=$(with_pi bash "$SCRIPT" run pi "x" 2>&1); rc=$?
expect_exit "pi with no model exits 2" 2 "$rc"
expect_match "pi with no model says where one comes from" 'adapter_pi: no model' "$out"
out=$(with_pi LLM_HUB_URL= LLM_HUB_MODEL=m1 bash "$SCRIPT" run pi "x" 2>&1); rc=$?
expect_exit "pi with no hub url exits 1" 1 "$rc"
expect_match "pi with no hub url is reported" 'adapter_pi: LLM_HUB_URL not set' "$out"
out=$(env ORCH_BIN_DIRS= PATH="$(path_without pi)" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" run pi "hi" 2>&1); rc=$?
expect_match "pi missing is reported" 'pi not found on PATH' "$out"
expect_exit "pi missing exits 127" 127 "$rc"
cleanup_dir "$pi_shim"
cleanup_dir "$pi_capture"
cleanup_dir "$pi_user"

# A dispatched job is only resumable if orch chose the session id and wrote it down, so both
# halves are asserted: the flag the harness saw, and the id left behind in the job dir.
session_home=$(new_tmp)
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" bash "$SCRIPT" init >/dev/null 2>&1
session_job=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" \
  bash "$SCRIPT" start claude "session probe" 2>/dev/null)
expect_match "start prints a job id" '^[0-9]{14}-' "$session_job"
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$session_home" \
  bash "$SCRIPT" wait "$session_job" --timeout 60 --interval 1 >/dev/null 2>&1
expect_file "start records the job's session id" "$session_home/jobs/$session_job/session"
session=$(cat "$session_home/jobs/$session_job/session" 2>/dev/null)
expect_match "the recorded session id is a uuid" \
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "$session"
expect_match "the claude adapter is told which session to use" \
  "--session-id $session" "$(joined "$(cat "$session_home/jobs/$session_job/log" 2>/dev/null)")"
cleanup_dir "$session_home"

resume_home=$(new_tmp)
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" init >/dev/null 2>&1
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" run start "Resume retry" --id resume-retry >/dev/null
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" node add resume-retry a "a" >/dev/null
resume_first=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" node dispatch resume-retry a claude "full original task" 2>/dev/null)
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" wait "$resume_first" --timeout 60 --interval 1 >/dev/null 2>&1
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" run sync resume-retry >/dev/null
resume_session=$(jq -r '.nodes[0].session' "$resume_home/runs/resume-retry/state.json")
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" node update resume-retry a error --force --error "exit=1" >/dev/null
resume_second=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" node retry resume-retry a 2>/dev/null)
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$resume_home" bash "$SCRIPT" wait "$resume_second" --timeout 60 --interval 1 >/dev/null 2>&1
resume_log=$(cat "$resume_home/jobs/$resume_second/log" 2>/dev/null)
expect_match "node retry resumes the previous claude session" "--resume $resume_session" "$(joined "$resume_log")"
expect_match "node retry sends a continuation prompt" 'Continue the same task from where you left off' "$resume_log"
expect_no_match "node retry does not send the full original prompt when resuming" 'full original task' "$resume_log"
expect_match "node retry records resumed mode" '^resumed$' "$(jq -r '.nodes[0].attempts[0].retry_mode' "$resume_home/runs/resume-retry/state.json")"
expect_match "node retry records resumed session" "^$resume_session$" "$(jq -r '.nodes[0].attempts[0].retry_session' "$resume_home/runs/resume-retry/state.json")"
expect_match "node retry keeps the original stored prompt" '^full original task$' "$(jq -r '.nodes[0].prompt' "$resume_home/runs/resume-retry/state.json")"
cleanup_dir "$resume_home"


# suggest scan batches its jq work: at most 6 jq spawns however many profiles, models and runs
jq_home=$(new_tmp)
jq_shim=$(new_tmp)
printf '#!/bin/sh\necho x >> "$JQLOG"\nexec %s "$@"\n' "$(command -v jq)" > "$jq_shim/jq"
chmod +x "$jq_shim/jq"
env HARNESS_ORCH_HOME="$jq_home" bash "$SCRIPT" init >/dev/null
for r in a b c; do
  mkdir -p "$jq_home/runs/$r"
  jq -n --arg r "$r" '{id:$r,status:"error",finished:"2026-01-01T00:00:00Z",nodes:[{id:"n1",label:"Build",status:"done",profile:"claude-default"},{id:"n2",label:"Fix",status:"error",profile:"opencode-default"}]}' > "$jq_home/runs/$r/state.json"
done
: > "$jq_shim/log"
out=$(env HARNESS_ORCH_HOME="$jq_home" JQLOG="$jq_shim/log" PATH="$jq_shim:$PATH" bash "$SCRIPT" suggest scan 2>&1)
expect_match "batched scan completes" 'scanned' "$out"
jq_calls=$(wc -l < "$jq_shim/log" | tr -d ' ')
expect_match "suggest scan spawns at most 6 jq (got $jq_calls)" '^[0-6]$' "$jq_calls"
expect_match "batched scan records memory gaps" 'memory_record' "$(jq -r '.suggestions[].kind' "$jq_home/suggestions.json")"
cleanup_dir "$jq_home"; cleanup_dir "$jq_shim"


finish
