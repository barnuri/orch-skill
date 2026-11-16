#!/usr/bin/env bash
# dispatch.sh tests: claude capture, node cost, out and digest, artifact
# Run: bash cost-digest.test.sh (or all files in parallel: bash skills/orch/tests/run.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/../test-lib.sh"

# --- claude adapter: JSON capture, cost sidecar, no-jq fallback ----------------
# The JSON form is what reports tokens and dollars. The log must still hold only the answer, so
# these cases pin both halves: what reaches stdout, and what lands in the sidecar.
home=$(new_tmp)
shims=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

json_shim() {
  cat > "$shims/claude" <<SHIM
#!/usr/bin/env bash
cat <<'PAYLOAD'
$1
PAYLOAD
exit ${2:-0}
SHIM
  chmod +x "$shims/claude"
}
with_claude() { env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" "$@"; }

SUCCESS_JSON='{"result":"the answer","total_cost_usd":0.2409,"is_error":false,"usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":81324,"cache_creation_input_tokens":19861},"modelUsage":{"claude-opus-5[1m]":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":81324,"cacheCreationInputTokens":19861,"costUSD":0.2394,"costBasis":"list"}}}'

json_shim "$SUCCESS_JSON"
out=$(with_claude bash "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_exit "claude json run exits 0" 0 "$rc"
expect_match "only the result reaches the log" '^the answer$' "$out"
expect_no_match "the raw json never reaches the log" 'total_cost_usd' "$out"

# `start` has a job dir, so the usage lands beside the log.
job=$(with_claude bash "$SCRIPT" start claude "hi")
expect_match "start prints a job id" '^[0-9]' "$job"
with_claude bash "$SCRIPT" wait "$job" --timeout 30 --interval 1 >/dev/null 2>&1
expect_file "start writes the cost sidecar" "$home/jobs/$job/usage.json"
usage=$(cat "$home/jobs/$job/usage.json" 2>/dev/null)
expect_match "sidecar carries the dollar total" '"usd":0.2409' "$usage"
expect_match "sidecar carries the cost basis" '"cost_basis":"list"' "$usage"
expect_match "sidecar carries input tokens" '"input_tokens":2' "$usage"
expect_match "sidecar carries cache creation tokens" '"cache_creation_tokens":19861' "$usage"
expect_match "sidecar carries the per-model split" '"model":"claude-opus-5\[1m\]"' "$usage"
log=$(cat "$home/jobs/$job/log" 2>/dev/null)
expect_match "the started job's log is still just the answer" '^the answer$' "$log"

# A harness failure reported inside a zero exit still fails the node.
json_shim '{"result":"nope","is_error":true,"total_cost_usd":0.01}'
out=$(with_claude bash "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_exit "is_error true fails the dispatch" 1 "$rc"
expect_match "the result is still logged on a reported failure" '^nope$' "$out"

# Output that is not the expected object passes straight through, so nothing is ever swallowed.
json_shim 'not json at all'
out=$(with_claude bash "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_exit "unparseable output keeps the harness exit code" 0 "$rc"
expect_match "unparseable output reaches the log untouched" '^not json at all$' "$out"

# A non-zero exit is reported as-is, with whatever the harness printed.
json_shim 'boom' 3
out=$(with_claude bash "$SCRIPT" run claude "hi" 2>&1); rc=$?
expect_exit "a failing harness keeps its exit code" 3 "$rc"

# Without jq there is nothing to parse JSON with, so the text form runs and no cost is captured.
# jq sits in /usr/bin beside coreutils here, so it cannot be dropped from PATH without taking
# `dirname` with it. A `command` function shadows the builtin for jq only — which also relies on
# dispatch.sh being safe to source, as its header promises.
json_shim "$SUCCESS_JSON"
out=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash -c '
  . "$1"
  command() {
    if [ "${1:-}" = -v ] && [ "${2:-}" = jq ]; then return 1; fi
    builtin command "$@"
  }
  adapter_claude "hi"
' _ "$SCRIPT" 2>&1); rc=$?
expect_exit "claude without jq still dispatches" 0 "$rc"
# The shim answers every argv with the same payload, so the proof that the text form ran is that
# the payload arrived verbatim: nothing extracted `.result`, and no cost was recorded.
expect_match "without jq the harness output is passed through whole" 'total_cost_usd' "$out"
expect_no_match "without jq nothing is parsed out of the payload" '^the answer$' "$out"
expect_missing "without jq no sidecar is written" "$home/usage.json"

cleanup_dir "$shims"
cleanup_dir "$home"

# --- node cost: the explicit subcommand and the run sync hook ------------------
home=$(new_tmp)
shims=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

cost_run=$(orch run start "cost run")
orch node add "$cost_run" n1 "first" >/dev/null
cost_state="$home/runs/$cost_run/state.json"

expect_match "node add seeds a null cost" '^null$' "$(jq -r '.nodes[0].cost | tostring' "$cost_state")"

out=$(orch node cost 2>&1); rc=$?
expect_exit "node cost with no ids exits 2" 2 "$rc"
expect_match "node cost prints usage" 'dispatch\.sh node cost' "$out"

out=$(orch node cost "$cost_run" n1 2>&1); rc=$?
expect_exit "node cost with no action exits 2" 2 "$rc"
expect_match "node cost asks for an action" 'pass --from-job or --clear' "$out"

out=$(orch node cost "$cost_run" n1 --bogus 2>&1); rc=$?
expect_exit "node cost rejects an unknown flag" 2 "$rc"

out=$(orch node cost "$cost_run" n1 --from-job 2>&1); rc=$?
expect_exit "node cost --from-job needs a job id" 2 "$rc"

out=$(orch node cost "$cost_run" nope --from-job j1 2>&1); rc=$?
expect_exit "node cost rejects an unknown node" 2 "$rc"

out=$(orch node cost "$cost_run" n1 --from-job missing-job 2>&1); rc=$?
expect_exit "node cost reports a job with no usage" 1 "$rc"
expect_match "node cost says the job recorded nothing" 'recorded no usage' "$out"

# A sidecar written by hand stands in for one the adapter wrote; the subcommand is the only
# thing that may move it onto the node.
mkdir -p "$home/jobs/costjob"
cat > "$home/jobs/costjob/usage.json" <<'USAGE'
{"usd":0.2409,"cost_basis":"list","input_tokens":2,"output_tokens":4,"cache_read_tokens":81324,"cache_creation_tokens":19861,"models":[{"model":"claude-opus-5[1m]","usd":0.2394,"input_tokens":2,"output_tokens":4,"cache_read_tokens":81324,"cache_creation_tokens":19861}]}
USAGE
out=$(orch node cost "$cost_run" n1 --from-job costjob 2>&1); rc=$?
expect_exit "node cost --from-job exits 0" 0 "$rc"
expect_match "the node carries the dollar total" '^0.2409$' "$(jq -r '.nodes[0].cost.usd' "$cost_state")"
expect_match "the node carries the cost basis" '^list$' "$(jq -r '.nodes[0].cost.cost_basis' "$cost_state")"
expect_match "the node carries the per-model split" '^claude-opus-5\[1m\]$' "$(jq -r '.nodes[0].cost.models[0].model' "$cost_state")"

out=$(orch node cost "$cost_run" n1 --clear 2>&1); rc=$?
expect_exit "node cost --clear exits 0" 0 "$rc"
expect_match "clearing returns the node to no cost" '^null$' "$(jq -r '.nodes[0].cost | tostring' "$cost_state")"

out=$(orch node cost "$cost_run" n1 --from-job costjob --clear 2>&1); rc=$?
expect_exit "node cost refuses both actions at once" 2 "$rc"

# A malformed sidecar is ignored rather than written through.
printf 'not json\n' > "$home/jobs/costjob/usage.json"
orch node cost "$cost_run" n1 --from-job costjob >/dev/null 2>&1
expect_match "a malformed sidecar leaves the node untouched" '^null$' "$(jq -r '.nodes[0].cost | tostring' "$cost_state")"

# run sync is the automatic route: a finished job's sidecar lands on its node without a caller.
printf '#!/usr/bin/env bash\ncat <<%s\n{"result":"done","total_cost_usd":0.5,"is_error":false,"usage":{"input_tokens":7,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"modelUsage":{"m1":{"inputTokens":7,"outputTokens":9,"costUSD":0.5,"costBasis":"list"}}}\n%s\n' "PAYLOAD" "PAYLOAD" > "$shims/claude"
chmod +x "$shims/claude"
sync_job=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node dispatch "$cost_run" n1 claude "hi")
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$sync_job" --timeout 30 --interval 1 >/dev/null 2>&1
orch run sync "$cost_run" >/dev/null 2>&1
expect_match "run sync copies the cost onto the node" '^0.5$' "$(jq -r '.nodes[0].cost.usd' "$cost_state")"
expect_match "run sync still flips the node to done" '^done$' "$(jq -r '.nodes[0].status' "$cost_state")"

cleanup_dir "$shims"
cleanup_dir "$home"

# --- node out / node digest: the file handoff channel --------------------------
home=$(new_tmp)
shims=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

ho_run=$(orch run start "handoff run")
orch node add "$ho_run" impl "Implement" >/dev/null
orch node add "$ho_run" review "Review" --after impl >/dev/null

out=$(orch node out 2>&1); rc=$?
expect_exit "node out with no ids exits 2" 2 "$rc"
expect_match "node out prints usage" 'dispatch\.sh node out' "$out"

out=$(orch node out "$ho_run" impl extra 2>&1); rc=$?
expect_exit "node out refuses extra arguments" 2 "$rc"

out=$(orch node out nosuchrun impl 2>&1); rc=$?
expect_exit "node out rejects an unknown run" 2 "$rc"

out=$(orch node out "$ho_run" nosuchnode 2>&1); rc=$?
expect_exit "node out rejects an unknown node" 2 "$rc"

out=$(orch node out "$ho_run" "../escape" 2>&1); rc=$?
expect_exit "node out rejects an id outside the pattern" 2 "$rc"

impl_out=$(orch node out "$ho_run" impl); rc=$?
expect_exit "node out exits 0" 0 "$rc"
expect_match "node out prints a path under the run" "runs/$ho_run/out/impl\$" "$impl_out"
if [ -d "$impl_out" ]; then
  pass_count=$((pass_count + 1))
else
  printf 'FAIL: node out creates the directory\n  expected a directory: %s\n' "$impl_out" >&2
  failures=$((failures + 1))
fi

# Calling it twice is how a downstream prompt resolves an upstream node's path; it must not fail
# on a directory that already exists.
out=$(orch node out "$ho_run" impl); rc=$?
expect_exit "node out is idempotent" 0 "$rc"
expect_match "node out returns the same path" "^$impl_out\$" "$out"

out=$(orch node digest "$ho_run" impl 2>&1); rc=$?
expect_exit "node digest on a waiting node exits 0" 0 "$rc"
expect_match "digest names the node and its status" '^node: impl \(waiting\)$' "$out"
expect_match "digest always points at the out dir" "^out: $impl_out\$" "$out"
expect_match "digest says a waiting node was never dispatched" '^log: not dispatched$' "$out"

out=$(orch node digest "$ho_run" impl --lines 0 2>&1); rc=$?
expect_exit "node digest rejects --lines 0" 2 "$rc"
out=$(orch node digest "$ho_run" impl --lines 9999 2>&1); rc=$?
expect_exit "node digest rejects --lines above the cap" 2 "$rc"
out=$(orch node digest "$ho_run" impl --bogus 2>&1); rc=$?
expect_exit "node digest rejects an unknown flag" 2 "$rc"

# A shim that prints many lines and echoes the exported out dir: one dispatch covers both the
# digest bounding and the environment contract.
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
printf 'ORCH_NODE_OUT=%s\n' "${ORCH_NODE_OUT:-unset}"
printf 'ORCH_RUN_ID=%s\n' "${ORCH_RUN_ID:-unset}"
printf 'ORCH_NODE_ID=%s\n' "${ORCH_NODE_ID:-unset}"
i=0
while [ "$i" -lt 200 ]; do printf 'line %s\n' "$i"; i=$((i + 1)); done
SHIM
chmod +x "$shims/claude"

ho_job=$(env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" node dispatch "$ho_run" impl claude "go")
env PATH="$shims:$PATH" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" wait "$ho_job" --timeout 30 --interval 1 >/dev/null 2>&1

job_log=$(cat "$home/jobs/$ho_job/log" 2>/dev/null)
expect_match "the node is told where its handoff goes" "ORCH_NODE_OUT=$impl_out" "$job_log"
expect_match "the node knows its run" "ORCH_RUN_ID=$ho_run" "$job_log"
expect_match "the node knows its own id" 'ORCH_NODE_ID=impl' "$job_log"

out=$(orch node digest "$ho_run" impl 2>&1); rc=$?
expect_exit "node digest on a dispatched node exits 0" 0 "$rc"
expect_match "digest reports the job" "^job: $ho_job\$" "$out"
expect_match "digest reports the exit code" '^exit: 0$' "$out"
expect_match "digest reports the log size" '^log: [0-9]+ bytes, [0-9]+ lines$' "$out"
expect_match "digest shows a head section" '^--- first 10 ---$' "$out"
expect_match "digest shows a tail section" '^--- last 10 ---$' "$out"
expect_match "digest says how much it dropped" '^--- [0-9]+ lines elided ---$' "$out"
expect_match "digest keeps the first line" '^ORCH_NODE_OUT=' "$out"
expect_match "digest keeps the last line" '^line 199$' "$out"
expect_no_match "digest drops the middle" '^line 100$' "$out"

# The whole point: the digest must not grow with the log.
digest_lines=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$digest_lines" -lt 40 ]; then
  pass_count=$((pass_count + 1))
else
  printf 'FAIL: digest stays bounded\n  expected under 40 lines, got %s\n' "$digest_lines" >&2
  failures=$((failures + 1))
fi

# A log shorter than twice --lines has no middle to drop, so it is shown whole.
out=$(orch node digest "$ho_run" impl --lines 200 2>&1)
expect_no_match "a short log is not elided" 'lines elided' "$out"
expect_match "a short log keeps its middle" '^line 100$' "$out"

cleanup_dir "$shims"
cleanup_dir "$home"

# --- artifact: argument validation + a real emit -------------------------------
home=$(new_tmp)
orch() { env HARNESS_ORCH_HOME="$home" bash "$SCRIPT" "$@"; }
seed_home "$home"

out=$(orch artifact 2>&1); rc=$?
expect_exit "artifact with no run id exits 2" 2 "$rc"
expect_match "artifact with no run id prints usage" 'dispatch\.sh artifact <run-id>' "$out"

out=$(orch artifact r1 r2 2>&1); rc=$?
expect_exit "artifact refuses two run ids" 2 "$rc"
expect_match "artifact explains the second id" 'one run id at a time' "$out"

out=$(orch artifact r1 --bogus 2>&1); rc=$?
expect_exit "artifact rejects an unknown flag" 2 "$rc"
expect_match "artifact names the unknown flag" 'unknown flag --bogus' "$out"

out=$(orch artifact r1 --out 2>&1); rc=$?
expect_exit "artifact --out needs a directory" 2 "$rc"

out=$(env HARNESS_ORCH_HOME="$home" ORCH_BUN=/nonexistent/bun bash "$SCRIPT" artifact r1 2>&1); rc=$?
expect_exit "artifact without bun exits 127" 127 "$rc"

if command -v bun >/dev/null 2>&1; then
  run_id=$(orch run start "snapshot me")
  orch node add "$run_id" n1 "first node" >/dev/null
  emit_dir="$home/emitted"

  out=$(orch artifact "$run_id" --out "$emit_dir" 2>&1); rc=$?
  expect_exit "artifact emits a bundle" 0 "$rc"
  expect_file "artifact writes index.html" "$emit_dir/index.html"
  expect_match "artifact reports the embedded documents" 'embedded document' "$out"
  index_html=$(cat "$emit_dir/index.html" 2>/dev/null)
  expect_match "the run is embedded as an island" "orch-island-run-$run_id" "$index_html"
  expect_match "the runs list is embedded" 'orch-island-runs' "$index_html"
  expect_no_match "health is never embedded" 'orch-island-health' "$index_html"
  expect_match "the bundle is referenced by a relative path" 'src="\./chunk-' "$index_html"
  expect_no_match "nothing points at an absolute URL" '(src|href)="https?://' "$index_html"

  # The default output location is under the state dir, so a caller need not pick one.
  out=$(orch artifact "$run_id" 2>&1); rc=$?
  expect_exit "artifact defaults its output directory" 0 "$rc"
  expect_file "artifact defaults under <home>/artifacts" "$home/artifacts/$run_id/index.html"

  out=$(orch artifact 20260101-000000-ffff --out "$home/nope" 2>&1); rc=$?
  expect_exit "artifact rejects an unknown run id" 1 "$rc"
  expect_match "artifact says which run is missing" 'no run 20260101-000000-ffff' "$out"
else
  printf 'SKIP: artifact emit test (bun not found)\n' >&2
fi

cleanup_dir "$home"


finish
