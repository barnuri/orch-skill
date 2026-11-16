#!/usr/bin/env bash
# Tests for `node batch`: mixed ops, all-or-nothing validation, --dry-run, equivalence with the same
# ops run one by one, and timing (one batch of 10 ops vs 10 single calls). Run with: bash batch.test.sh
set -u
export ORCH_NO_ANNOUNCE=1 ORCH_HERDR=0
# The equivalence checks compare whole state files: pin the session id (else each call records its
# own pid-N harness_session) and drop the identity a calling orch node or opencode session exports.
export CLAUDE_CODE_SESSION_ID=batch-test
unset OPENCODE_SESSION_ID ORCH_EVENT_BY ORCH_SESSION_ID ORCH_RUN_ID ORCH_NODE_ID ORCH_NODE_OUT ORCH_JOB_DIR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch.sh"
failures=0
pass_count=0

expect_match() {
  local label="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qE -e "$pattern"; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected to match: %s\n  in output:\n%s\n' "$label" "$pattern" "$output" >&2
  failures=$((failures + 1))
}
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass_count=$((pass_count + 1)); return; fi
  printf 'FAIL: %s\n  expected exit %s, got %s\n' "$label" "$want" "$got" >&2
  failures=$((failures + 1))
}

home=$(mktemp -d)
o() { HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
st() { jq -r "$2" "$home/runs/$1/state.json"; }
o init >/dev/null 2>&1

# mixed ops, stdin, blank lines skipped
R=$(o run start "batch demo")
out=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"Alpha"}' \
  '' \
  '{"op":"add","id":"b","label":"Beta","after":["a"],"role":"planning","tier":"balance"}' \
  '{"op":"update","id":"a","status":"running","owner":"coordinator"}' \
  '{"op":"report","id":"a","note":"halfway","input_tokens":12,"usd":0.5}' \
  '{"op":"update","id":"a","status":"done"}' | o node batch "$R" 2>&1); rc=$?
expect_exit "mixed batch exits 0" 0 "$rc"
expect_match "summary per op" '^line 1: add a "Alpha" ok' "$out"
expect_match "summary keeps input line numbers" 'line 6: update a -> done ok' "$out"
expect_match "final summary" 'applied 5 op\(s\)' "$out"
expect_match "a done" '^done$' "$(st "$R" '.nodes[] | select(.id == "a") | .status')"
expect_match "owner recorded" '^coordinator$' "$(st "$R" '.nodes[] | select(.id == "a") | .owner')"
expect_match "report recorded" '^halfway 12 0.5$' "$(st "$R" '.nodes[] | select(.id == "a") | "\(.report.note) \(.report.input_tokens) \(.report.usd)"')"
expect_match "b role and tier" '^planning balance$' "$(st "$R" '.nodes[] | select(.id == "b") | "\(.role) \(.tier)"')"
expect_match "edge a->b" '^a b$' "$(st "$R" '.edges[0] | join(" ")')"
expect_match "events like single commands" '^add add status note status note$' \
  "$(jq -rs 'map(.kind) | join(" ")' "$home/runs/$R/events.jsonl")"
# done without a handoff: the batch runs done-verify like `node update` (fast path and fallback)
expect_match "batch done without handoff is unverified" '^true$' "$(st "$R" '.nodes[] | select(.id == "a") | .unverified')"
expect_match "batch done-verify warns" 'done without handoff: a ' "$out"
RV=$(o run start "verify fallback")
out=$(printf '%s\n' '{"op":"add","id":"v","goal":"V"}' '{"op":"add","id":"w","goal":"W"}' '{"op":"update","id":"v","status":"done"}' \
  | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RV" 2>&1)
mkdir -p "$home/runs/$RV/out/w" && echo handoff > "$home/runs/$RV/out/w/handoff.md"
printf '%s\n' '{"op":"update","id":"w","status":"done"}' | o node batch "$RV" >/dev/null 2>&1
expect_match "fallback done without handoff is unverified" '^true$' "$(st "$RV" '.nodes[] | select(.id == "v") | .unverified')"
expect_match "done with a handoff stays verified" '^null$' "$(st "$RV" '.nodes[] | select(.id == "w") | .unverified')"

# invalid op rejects all, every error reported with its line number
before=$(cat "$home/runs/$R/state.json")
ev_before=$(wc -l < "$home/runs/$R/events.jsonl")
out=$(printf '%s\n' \
  '{"op":"add","id":"c","goal":"Gamma"}' \
  'not json' \
  '{"op":"update","id":"a","status":"waiting"}' \
  '{"op":"add","id":"d","goal":"Delta","bogus":1}' \
  '{"op":"report","id":"zz","note":"x"}' \
  '{"op":"frob","id":"c"}' | o node batch "$R" 2>&1); rc=$?
expect_exit "invalid batch exits 2" 2 "$rc"
expect_match "bad JSON names line 2" '^line 2: ' "$out"
expect_match "illegal move names line 3" '^line 3: node update: a is done' "$out"
expect_match "unknown field names line 4" '^line 4: unknown field\(s\) for add: bogus' "$out"
expect_match "unknown node names line 5" '^line 5: node zz: not in this run' "$out"
expect_match "unknown op names line 6" '^line 6: "op" must be add, report or update' "$out"
expect_match "nothing applied" '5 invalid op\(s\) of 6; nothing applied' "$out"
out2=$(printf '%s\n' '{"op":"add","id":"c","goal":"Gamma"}' 'not json' '{"op":"update","id":"a","status":"waiting"}' \
  '{"op":"add","id":"d","goal":"Delta","bogus":1}' '{"op":"report","id":"zz","note":"x"}' '{"op":"frob","id":"c"}' \
  | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$R" 2>&1)
if [ "$out" = "$out2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fallback errors differ\n%s\n---\n%s\n' "$out" "$out2" >&2; fi
if [ "$before" = "$(cat "$home/runs/$R/state.json")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: rejected batch changed state.json\n' >&2; fi
expect_match "no events written" "^ *$ev_before\$" "$(wc -l < "$home/runs/$R/events.jsonl")"
# A later op that depends on an earlier one in the same batch validates in order.
out=$(printf '%s\n' '{"op":"add","id":"c","goal":"Gamma"}' '{"op":"add","id":"d","goal":"Delta","after":"c"}' \
  | o node batch "$R" --dry-run 2>&1); rc=$?
expect_exit "in-batch dependency is valid" 0 "$rc"

# dry run: validates, prints, writes nothing
printf '%s\n' '{"op":"add","id":"e","goal":"Eps"}' '{"op":"update","id":"e","status":"skipped"}' > "$home/ops.jsonl"
before=$(cat "$home/runs/$R/state.json")
out=$(o node batch "$R" --file "$home/ops.jsonl" --dry-run 2>&1); rc=$?
expect_exit "dry run exits 0" 0 "$rc"
expect_match "dry run prints would" '^line 2: would update e -> skipped' "$out"
expect_match "dry run summary" 'dry run, nothing applied' "$out"
if [ "$before" = "$(cat "$home/runs/$R/state.json")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: dry run changed state.json\n' >&2; fi
o node batch "$R" --file "$home/ops.jsonl" >/dev/null 2>&1; rc=$?
expect_exit "--file applies" 0 "$rc"
expect_match "--file result" '^skipped$' "$(st "$R" '.nodes[] | select(.id == "e") | .status')"
o node batch "$R" --bogus </dev/null >/dev/null 2>&1; expect_exit "unknown flag rejected" 2 "$?"
printf '' | o node batch "$R" >/dev/null 2>&1; expect_exit "empty input rejected" 2 "$?"
o node batch no-such-run </dev/null >/dev/null 2>&1; expect_exit "unknown run rejected" 2 "$?"

# equivalence + timing: the same 10 ops as one batch and as 10 single calls
ops=$(printf '%s\n' \
  '{"op":"add","id":"p","goal":"Plan"}' \
  '{"op":"add","id":"i","goal":"Implement","after":"p","profile":"local-llm-fast","model":"m1"}' \
  '{"op":"add","id":"t","goal":"Tests","after":["p"],"plan_backed":true,"acceptance":"green"}' \
  '{"op":"update","id":"p","status":"running","owner":"coordinator"}' \
  '{"op":"report","id":"p","model":"opus","output_tokens":7,"note":"planned"}' \
  '{"op":"update","id":"p","status":"done"}' \
  '{"op":"update","id":"i","status":"running","owner":"pid 1"}' \
  '{"op":"update","id":"i","status":"error","error":"boom"}' \
  '{"op":"update","id":"t","status":"skipped"}' \
  '{"op":"report","id":"i","usd":1.25}')
# p ends done: give it a handoff in every equivalence run, so done-verify adds no note there.
ho() { mkdir -p "$home/runs/$1/out/p" && echo handoff > "$home/runs/$1/out/p/handoff.md"; }
RB=$(o run start "eq batch" --id eq-batch); ho "$RB"
RS=$(o run start "eq single" --id eq-single); ho "$RS"
t0=$(date +%s)
printf '%s\n' "$ops" | o node batch "$RB" >/dev/null 2>&1; rc=$?
t1=$(date +%s)
expect_exit "10-op batch exits 0" 0 "$rc"
o node add "$RS" p "Plan" >/dev/null
o node add "$RS" i "Implement" --after p --profile local-llm-fast --model m1 >/dev/null
o node add "$RS" t "Tests" --after p --plan-backed --acceptance green >/dev/null
o node update "$RS" p running --owner coordinator >/dev/null
o node report "$RS" p --model opus --output-tokens 7 --note planned >/dev/null
o node update "$RS" p done >/dev/null
o node update "$RS" i running --owner "pid 1" >/dev/null
o node update "$RS" i error --error boom >/dev/null
o node update "$RS" t skipped >/dev/null
o node report "$RS" i --usd 1.25 >/dev/null
t2=$(date +%s)
norm() {
  jq -S 'del(.run_id, .title, .started) | walk(if type == "object" then
    with_entries(select(.key | IN("created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked") | not))
    else . end)' "$home/runs/$1/state.json"
}
if [ "$(norm "$RB")" = "$(norm "$RS")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: batch state differs from single calls\n' >&2
  diff <(norm "$RB") <(norm "$RS") >&2; fi
evk() { jq -c '[.kind, .node, .from, .to, .note, .by]' "$home/runs/$1/events.jsonl"; }
if [ "$(evk "$RB")" = "$(evk "$RS")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: batch events differ from single calls\n' >&2
  diff <(evk "$RB") <(evk "$RS") >&2; fi
printf 'timing: 10 ops as one batch: %ss; as 10 single calls: %ss\n' $((t1 - t0)) $((t2 - t1))
[ $((t1 - t0)) -le $((t2 - t1)) ] && pass_count=$((pass_count + 1)) || {
  failures=$((failures + 1)); printf 'FAIL: batch (%ss) slower than single calls (%ss)\n' $((t1 - t0)) $((t2 - t1)) >&2; }

# the fast path and the per-op fallback (ORCH_BATCH_FAST=0) give the same state, events and output
RF=$(o run start "eq fallback" --id eq-fallback); ho "$RF"
fout=$(printf '%s\n' "$ops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RF" 2>&1); rc=$?
expect_exit "fallback batch exits 0" 0 "$rc"
if [ "$(norm "$RB")" = "$(norm "$RF")" ] && [ "$(evk "$RB")" = "$(evk "$RF")" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast path and fallback differ\n' >&2
  diff <(norm "$RB") <(norm "$RF") >&2; diff <(evk "$RB") <(evk "$RF") >&2; fi
RG=$(o run start "eq fast out" --id eq-fast-out); ho "$RG"
gout=$(printf '%s\n' "$ops" | o node batch "$RG" 2>&1)
expect_match "fast and fallback print the same lines" "^$(printf '%s' "$fout" | wc -l | tr -d ' ')\$" "$(printf '%s' "$gout" | wc -l | tr -d ' ')"
if [ "$fout" = "$gout" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast and fallback output differ\n%s\n---\n%s\n' "$gout" "$fout" >&2; fi
bad=$(printf '%s\n' '{"op":"update","id":"p","status":"waiting"}' '{"op":"report","id":"p"}' '{"op":"add","id":"p","goal":"x"}' '{"op":"update","id":"t","status":"done","at":"2099-01-01T00:00:00Z"}' '{"op":"update","id":"t","status":"done","job":"nojob"}')
e1=$(printf '%s\n' "$bad" | o node batch "$RB" 2>&1)
e2=$(printf '%s\n' "$bad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$RB" 2>&1)
expect_match "fast path rejects all 5" 'node batch: 5 invalid op\(s\) of 5' "$e1"
if [ "$e1" = "$e2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: fast and fallback errors differ\n%s\n---\n%s\n' "$e1" "$e2" >&2; fi

# an op the fast path does not support (a dependency finished in the run this one continued) falls back
RC=$(o run start "carry src" --id carry-src)
o node add "$RC" a "A" >/dev/null; o node update "$RC" a done >/dev/null; o node add "$RC" b "B" >/dev/null
o run carry "$RC" --id carry-dst >/dev/null 2>&1
out=$(printf '%s\n' '{"op":"add","id":"c","goal":"C","after":"a"}' | o node batch carry-dst 2>&1); rc=$?
expect_exit "continued-run dependency falls back and applies" 0 "$rc"
expect_match "fallback added the node" '^C$' "$(st carry-dst '.nodes[] | select(.id == "c") | .label')"

# update with deps (--after), needs-user and no status: fast path vs fallback vs single calls
dops=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"A"}' \
  '{"op":"add","id":"b","goal":"B"}' \
  '{"op":"add","id":"g","goal":"Gate"}' \
  '{"op":"update","id":"b","after":["a"]}' \
  '{"op":"update","id":"g","after":"*","needs_user":"approve"}' \
  '{"op":"update","id":"a","status":"running","owner":"coordinator","needs_user":"look"}' \
  '{"op":"update","id":"a","clear_needs_user":true}' \
  '{"op":"update","id":"b","after":""}' \
  '{"op":"update","id":"b","after":"a,g"}')
DF=$(o run start "deps fast" --id deps-fast)
DB=$(o run start "deps fallback" --id deps-fallback)
DS=$(o run start "deps single" --id deps-single)
dfo=$(printf '%s\n' "$dops" | o node batch "$DF" 2>&1); rc=$?
expect_exit "deps batch (fast) exits 0" 0 "$rc"
dbo=$(printf '%s\n' "$dops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$DB" 2>&1); rc=$?
expect_exit "deps batch (fallback) exits 0" 0 "$rc"
o node add "$DS" a A >/dev/null; o node add "$DS" b B >/dev/null; o node add "$DS" g Gate >/dev/null
o node update "$DS" b --after a >/dev/null
o node update "$DS" g --after '*' --needs-user approve >/dev/null
o node update "$DS" a running --owner coordinator --needs-user look >/dev/null
o node update "$DS" a --clear-needs-user >/dev/null
o node update "$DS" b --after "" >/dev/null
o node update "$DS" b --after a,g >/dev/null
expect_match "deps fast output" '^line 5: update g ok' "$dfo"
if [ "$dfo" = "$dbo" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: deps fast and fallback output differ\n%s\n---\n%s\n' "$dfo" "$dbo" >&2; fi
expect_match "gate after_all set" '^true approve$' "$(st "$DF" '.nodes[] | select(.id == "g") | "\(.after_all) \(.needs_user)"')"
expect_match "needs_user cleared" '^null$' "$(st "$DF" '.nodes[] | select(.id == "a") | .needs_user')"
expect_match "edges replaced" '^a>b g>b$' "$(st "$DF" '[.edges[] | join(">")] | join(" ")')"
for other in "$DB" "$DS"; do
  if [ "$(norm "$DF")" = "$(norm "$other")" ] && [ "$(evk "$DF")" = "$(evk "$other")" ]; then pass_count=$((pass_count + 1)); else
    failures=$((failures + 1)); printf 'FAIL: deps batch differs from %s\n' "$other" >&2
    diff <(norm "$DF") <(norm "$other") >&2; diff <(evk "$DF") <(evk "$other") >&2; fi
done
dbad=$(printf '%s\n' \
  '{"op":"update","id":"a","after":"a"}' \
  '{"op":"update","id":"a","after":"zz"}' \
  '{"op":"update","id":"a","after":"b"}' \
  '{"op":"update","id":"a"}' \
  '{"op":"update","id":"a","needs_user":""}')
e1=$(printf '%s\n' "$dbad" | o node batch "$DF" 2>&1)
e2=$(printf '%s\n' "$dbad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$DF" 2>&1)
expect_match "self dependency refused" '^line 1: node update: a cannot depend on itself' "$e1"
expect_match "unknown dependency refused" '^line 2: node update: dependency zz is not in run' "$e1"
expect_match "cycle refused" '^line 3: node update: --after b would make a cycle' "$e1"
expect_match "update with nothing refused" '^line 4: usage: dispatch.sh node update' "$e1"
expect_match "empty needs_user refused" '^line 5: node update: --needs-user expects a reason' "$e1"
if [ "$e1" = "$e2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: deps fast and fallback errors differ\n%s\n---\n%s\n' "$e1" "$e2" >&2; fi
e3=""; while IFS= read -r line; do
  e3="$e3$(printf '%s\n' "$line" | jq -r '["node","update","'"$DF"'",.id] + (if .after != null then ["--after", .after] else [] end)
    + (if has("needs_user") then ["--needs-user", .needs_user] else [] end) | @sh' | xargs -I{} sh -c "HARNESS_ORCH_HOME='$home' bash '$SCRIPT' {} 2>&1 >/dev/null")"$'\n'
done <<< "$dbad"
expect_match "single calls give the same messages" 'cannot depend on itself.*' "$e3"
for msg in 'cannot depend on itself' 'dependency zz is not in run' 'would make a cycle' 'usage: dispatch.sh node update' '--needs-user expects a reason'; do
  expect_match "single call says: $msg" "$msg" "$e3"
done

# hold / clear_hold: fast path vs fallback vs single calls; running clears the hold
hops=$(printf '%s\n' \
  '{"op":"add","id":"a","goal":"A"}' \
  '{"op":"add","id":"b","goal":"B"}' \
  '{"op":"update","id":"a","hold":"until load < 4"}' \
  '{"op":"update","id":"b","hold":"later"}' \
  '{"op":"update","id":"b","clear_hold":true}' \
  '{"op":"update","id":"b","hold":"again"}' \
  '{"op":"update","id":"b","status":"running","owner":"coordinator"}')
HF=$(o run start "hold fast" --id hold-fast)
HB=$(o run start "hold fallback" --id hold-fallback)
HS=$(o run start "hold single" --id hold-single)
hfo=$(printf '%s\n' "$hops" | o node batch "$HF" 2>&1); rc=$?
expect_exit "hold batch (fast) exits 0" 0 "$rc"
hbo=$(printf '%s\n' "$hops" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$HB" 2>&1); rc=$?
expect_exit "hold batch (fallback) exits 0" 0 "$rc"
o node add "$HS" a A >/dev/null; o node add "$HS" b B >/dev/null
o node update "$HS" a --hold "until load < 4" >/dev/null
o node update "$HS" b --hold later >/dev/null
o node update "$HS" b --clear-hold >/dev/null
o node update "$HS" b --hold again >/dev/null
o node update "$HS" b running --owner coordinator >/dev/null
if [ "$hfo" = "$hbo" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: hold fast and fallback output differ\n%s\n---\n%s\n' "$hfo" "$hbo" >&2; fi
expect_match "hold set" '^until load < 4$' "$(st "$HF" '.nodes[] | select(.id == "a") | .hold')"
expect_match "running cleared the hold" '^null$' "$(st "$HF" '.nodes[] | select(.id == "b") | .hold')"
expect_match "hold events" '^until load < 4,later,cleared,again$' "$(jq -rs '[.[] | select(.kind == "hold") | .note] | join(",")' "$home/runs/$HF/events.jsonl")"
for other in "$HB" "$HS"; do
  if [ "$(norm "$HF")" = "$(norm "$other")" ] && [ "$(evk "$HF")" = "$(evk "$other")" ]; then pass_count=$((pass_count + 1)); else
    failures=$((failures + 1)); printf 'FAIL: hold batch differs from %s\n' "$other" >&2
    diff <(norm "$HF") <(norm "$other") >&2; diff <(evk "$HF") <(evk "$other") >&2; fi
done
hbad=$(printf '%s\n' '{"op":"update","id":"a","hold":""}' '{"op":"update","id":"a","hold":"x","clear_hold":true}')
h1=$(printf '%s\n' "$hbad" | o node batch "$HF" 2>&1)
h2=$(printf '%s\n' "$hbad" | ORCH_BATCH_FAST=0 HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node batch "$HF" 2>&1)
expect_match "empty hold refused" '^line 1: node update: --hold expects a reason' "$h1"
expect_match "hold with clear_hold refused" 'line 2: "hold" and "clear_hold" cannot be combined' "$h1"
if [ "$h1" = "$h2" ]; then pass_count=$((pass_count + 1)); else
  failures=$((failures + 1)); printf 'FAIL: hold fast and fallback errors differ\n%s\n---\n%s\n' "$h1" "$h2" >&2; fi

printf '%s passed, %s failed\n' "$pass_count" "$failures"
[ "$failures" -eq 0 ]
