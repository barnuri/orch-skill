#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/plan.sh: settings, the planner profile menu, the plan validator,
# plan apply, ready nodes and the run mailbox, called in-process on a fixture run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
load_dispatch

mkdir -p "$H/runs/r1"
printf '%s\n' '{"run_id":"r1","title":"Demo","status":"running","edges":[["a","b"]],
 "nodes":[{"id":"a","status":"done"},{"id":"b","status":"waiting"},{"id":"c","status":"waiting"}]}' > "$H/runs/r1/state.json"
F="$H/runs/r1/state.json"
T=$(new_tmp)

# --- setting_uint, plan_profile_menu
expect_match "setting_uint reads a positive setting" '^4$' "$(setting_uint max_parallel 9)"
expect_match "setting_uint falls back on a missing setting" '^9$' "$(setting_uint no_such_key 9)"
menu=$(plan_profile_menu)
expect_match "the menu marks the default profile" '^- claude-default \(default\): harness claude' "$menu"
expect_no_match "the menu leaves out a disabled profile" 'opencode-default' "$menu"

# --- the validator: unknown dependency, cycle, layers and profile fallback
validate() { jq -c --slurpfile prof "$PROFILES_FILE" --argjson existing '["a","b","c"]' --argjson max 12 \
  --arg plan plan --arg default claude-default "$PLAN_VALIDATE_JQ" "$1"; }
printf '%s' '{"tasks":[{"id":"x","prompt":"p","after":["ghost"]},{"id":"a","prompt":"p"}]}' > "$T/bad.json"
out=$(validate "$T/bad.json")
expect_match "an unknown dependency is an error" 'task x depends on unknown task ghost' "$out"
expect_match "a task id that collides with a node is an error" 'task id a collides with an existing node' "$out"
printf '%s' '{"tasks":[{"id":"x","prompt":"p","after":["y"]},{"id":"y","prompt":"p","after":["x"]}]}' > "$T/cyc.json"
expect_match "a dependency cycle is an error" 'dependency cycle among: x, y' "$(validate "$T/cyc.json")"

# --- plan apply: nodes, edges, prompts with the footer, stages
cat > "$T/plan.json" <<'EOF'
{"summary":"two steps","tasks":[
 {"id":"impl","label":"Implement","prompt":"write code","profile":"no-such-profile","after":[]}]}
EOF
out=$(cmd_plan_apply r1 --file "$T/plan.json" 2>"$T/err"); rc=$?
expect_exit "plan apply of a valid plan succeeds" 0 "$rc"
expect_match "plan apply prints the count and the stages" 'applied: 1 task.*stages: impl' "$(printf '%s' "$out" | tr '\n' ' ')"
expect_match "an unknown profile falls back to the default with a warning" 'unknown profile no-such-profile, using claude-default' "$(cat "$T/err")"
expect_match "the task becomes a waiting node on the default profile" '^Implement waiting claude-default 1$' \
  "$(jq -r '"\(.nodes[3].label) \(.nodes[3].status) \(.nodes[3].profile) \(.plan.tasks)"' "$F")"
expect_match "the stored prompt has the task text and the orch footer" 'orch context — run r1, task impl' \
  "$(cat "$H/runs/r1/prompts/impl.md")"
out=$(cmd_plan_apply r1 --file "$T/plan.json" 2>&1); rc=$?
expect_exit "a second plan apply is refused" 2 "$rc"

# --- run_ready_ids: waiting nodes whose deps are done
expect_match "ready nodes are the waiting ones with done deps" '^b c impl$' "$(run_ready_ids "$F" | tr '\n' ' ' | sed 's/ $//')"

# --- mailbox
out=$(cmd_msg_send r1 --to all --from all "hi" 2>&1); rc=$?
expect_exit "msg send --from all is refused" 2 "$rc"
cmd_msg_send r1 --to b "for b" >/dev/null
expect_match "a node reads the messages sent to it" '^1	.*	orch -> b	for b$' "$(cmd_msg_read r1 --for b)"
expect_empty "--since skips messages already read" "$(cmd_msg_read r1 --for b --since 1)"

cleanup_dir "$T"
cleanup_dir "$(dirname "$H")"
finish
