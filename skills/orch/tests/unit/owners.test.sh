#!/usr/bin/env bash
# Fast-tier unit tests for lib/runs/owners.sh: owner text parsing, the owner registry, the report
# lines, the bind matcher and the owner state transitions, called in-process.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-lib.sh"
export ORCH_OWNER_INDEX=0
load_dispatch

expect_match "a bare session id parses as a session" '^session	ses_Abc1$' "$(owner_parse '  ses_Abc1 ')"
expect_match "agent: prefix is allowed before a session id" '^session	ses_x9$' "$(owner_parse 'agent: ses_x9')"
expect_match "pid text parses as a process" '^process	42$' "$(owner_parse 'PID: 42')"
expect_match "the coordinator is no owner" '^none	coordinator$' "$(owner_parse 'Coordinator')"
expect_match "blank text is no owner" '^none	$' "$(owner_parse '   ')"
mkdir -p "$H/jobs/job-7"
expect_match "a known job dir parses as a job" '^job	job-7$' "$(owner_parse job-7)"
expect_match "free text is unknown" '^unknown	some agent$' "$(owner_parse 'some agent')"

expect_match "a session id inside free text is found" '^session	ses_Q1$' "$(owner_literal_id 'agent ses_Q1 (spawned)')"
expect_match "a claude uuid is found and lowercased" '^claude	0a1b2c3d-0000-4000-8000-00000000abcd$' \
  "$(owner_literal_id 'run 0A1B2C3D-0000-4000-8000-00000000ABCD now')"
expect_match "a pid inside free text is found" '^process	77$' "$(owner_literal_id 'worker pid-77')"
expect_match "a word ending in pid is not a pid" '^none	$' "$(owner_literal_id 'rapid 12')"

owner_registry_write r1 n1 'ses/x y'
expect_file "registry file name maps unsafe characters to _" "$H/owners/ses_x_y.json"
expect_match "registry file holds run and node" '"run":"r1","node":"n1"' "$(cat "$H/owners/ses_x_y.json")"

out=$(printf 'a\tfinished\t\nb\tgone\t\nc\tidle\t\nd\talive\t\ne\tfinished\t\n' | owner_report_lines)
expect_match "report lists finished owners" '^owner finished: a,e$' "$out"
expect_match "report lists idle owners" '^owner idle: c$' "$out"
expect_match "report lists gone owners" '^owner gone: b$' "$out"
expect_no_match "report leaves alive owners out" '[ ,]d(,|$)' "$out"

nodes='[{"id":"n1","start":1000,"text":"write parser tests"},{"id":"n2","start":5000,"text":"deploy docs"}]'
out=$(owner_bind_match "$nodes" n1 '[{"child":"ses_A","title":"parser tests","created":1010}]')
expect_match "a title match binds" '"child":"ses_A","how":"title"' "$out"
out=$(owner_bind_match "$nodes" n1 '[{"child":"ses_A","title":"x","created":1010}]')
expect_match "a lone time match binds" '"child":"ses_A","how":"time"' "$out"
out=$(owner_bind_match "$nodes" n1 '[{"child":"ses_A","title":"x","created":1010},{"child":"ses_B","title":"y","created":1011}]')
expect_match "a time tie is refused" 'tie on time between ses_A, ses_B' "$out"
out=$(owner_bind_match "$nodes" n1 '[{"child":"ses_A","title":"x","created":1010}]' 1)
expect_match "need-title refuses a time-only match" 'shares a word' "$out"
out=$(owner_bind_match "$nodes" n1 '[{"child":"ses_A","title":"parser","created":9999}]')
expect_match "a candidate far from the start is not bound" 'no child session found' "$out"

mkdir -p "$H/runs/r1"
cat > "$H/runs/r1/state.json" <<'EOF'
{"run_id":"r1","title":"t","status":"running","edges":[],
 "nodes":[{"id":"n1","status":"running","owner":"ses_x","stalled":true,"stalled_reason":"quiet"},
          {"id":"n2","status":"running","owner":"ses_y"}]}
EOF
owner_apply_state r1 n1 alive "" ses_x test 2026-01-01T00:00:00Z
n1=$(jq -c '.nodes[0]' "$H/runs/r1/state.json")
expect_match "alive marks the owner alive" '"owner_state":"alive"' "$n1"
expect_match "alive clears the stall flag" '"stalled":null' "$n1"
owner_apply_state r1 n2 finished "bye" ses_y test 2026-01-01T00:00:00Z
n2=$(jq -c '.nodes[1]' "$H/runs/r1/state.json")
expect_match "a finished session (no job) only goes idle" '"status":"running".*"owner_state":"idle"' "$n2"
expect_match "idle records the time it went idle" '"owner_idle_since":"2026-01-01T00:00:00Z"' "$n2"

# opencode_db_session_model: the newest assistant model of a session, never a Smart Auto selector.
if command -v sqlite3 >/dev/null 2>&1; then
  odb="$H/opencode.db"
  sqlite3 "$odb" "create table session_message (id text, session_id text, type text, seq integer, data text);
    create table message (id text, session_id text, time_created integer, data text);
    insert into session_message values ('m1','ses_real','assistant',1,'{\"model\":{\"id\":\"old\",\"providerID\":\"p\"}}');
    insert into session_message values ('m2','ses_real','assistant',2,'{\"model\":{\"id\":\"claude-opus-5-5\",\"providerID\":\"copilot\"}}');
    insert into session_message values ('m3','ses_auto','assistant',1,'{\"model\":{\"id\":\"smart-auto-balance\",\"providerID\":\"hub\"}}');
    insert into message values ('l1','ses_old',1,'{\"role\":\"assistant\",\"modelID\":\"gpt-x\",\"providerID\":\"openai\"}');"
  expect_match "opencode.db gives the newest assistant model" '^copilot/claude-opus-5-5$' "$(ORCH_OPENCODE_DB="$odb" opencode_db_session_model ses_real)"
  expect_no_match "opencode.db never gives a Smart Auto selector" 'smart-auto' "$(ORCH_OPENCODE_DB="$odb" opencode_db_session_model ses_auto)"
  expect_match "opencode.db falls back to the legacy message table" '^openai/gpt-x$' "$(ORCH_OPENCODE_DB="$odb" opencode_db_session_model ses_old)"
fi

cleanup_dir "$(dirname "$H")"
finish
