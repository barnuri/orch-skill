#!/usr/bin/env bash
# dispatch.sh tests: llm-hub native mode
# Run: bash llm-hub-native.test.sh (or all files in parallel: bash dispatch.test.sh)

set -u
source "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

# --- llm-hub native mode: hub setup, role→tier, resolve before, settle after ------------------
if ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP: llm-hub native mode test (python3 not found)\n' >&2
else
  nh_dir=$(new_tmp)
  cat > "$nh_dir/hub.py" <<'PY'
import http.server, json, sys
from urllib.parse import urlparse, parse_qs
port_file, log_file = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz": return self.reply(200, b"ok")
        if url.path == "/api/smart-auto/current":
            w = parse_qs(url.query).get("worker", [""])[0]
            return self.reply(200, {"selection": {"main": {"worker": "salted-" + w, "model": "used/model",
                "tier": "intelligence", "role": "planning", "reason": "fresh", "state": "completed"}}})
        self.reply(404, {})
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        with open(log_file, "a") as f: f.write(self.path + " " + body + "\n")
        if self.path == "/api/smart-auto/resolve":
            req = json.loads(body)
            return self.reply(200, {"model": "expected/" + req["tier"], "tier": req["tier"],
                "role": req.get("role"), "reason": "fresh", "alternatives": []})
        if self.path == "/api/smart-auto/outcome": return self.reply(200, {})
        self.reply(404, {})
    def log_message(self, *_): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_address[1]))
s.serve_forever()
PY
  python3 "$nh_dir/hub.py" "$nh_dir/port" "$nh_dir/posts" &
  nh_pid=$!
  for _ in $(seq 1 600); do [ -s "$nh_dir/port" ] && break; sleep 0.1; done
  nh_home=$(new_tmp)
  nh_shims=$(new_tmp)
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${OPENCODE_CONFIG_CONTENT-unset}"\nprintf "%%s\\n" "$@"\n' > "$nh_shims/opencode"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$nh_shims/copilot"
  chmod +x "$nh_shims/opencode" "$nh_shims/copilot"
  printf 'LLM_HUB_URL=http://127.0.0.1:%s\nLLM_HUB_KEY=k\n' "$(cat "$nh_dir/port")" > "$nh_home/env"
  norch() { env PATH="$nh_shims:$PATH" HARNESS_ORCH_HOME="$nh_home" bash "$SCRIPT" "$@"; }
  norch profile list >/dev/null 2>&1

  out=$(norch hub setup --harness nope 2>&1); rc=$?
  expect_exit "hub setup rejects an unknown harness" 2 "$rc"
  out=$(norch hub setup 2>&1); rc=$?
  expect_exit "hub setup succeeds against the fake hub" 0 "$rc"
  expect_match "hub setup turns smart-auto mode on" '^mode: smart-auto$' "$out"
  expect_match "hub setup defaults the harness to opencode" '^harness: opencode$' "$out"
  expect_match "hub setup makes the hub profile the planner" '^planner_profile: opencode-smart-auto$' "$out"
  expect_match "hub setup enables the opencode harness" '^false$' \
    "$(jq '(.settings.disabled_harnesses // []) | index("opencode") != null' "$nh_home/profiles.json")"
  before=$(cat "$nh_home/profiles.json")
  norch hub setup >/dev/null 2>&1
  expect_match "hub setup is idempotent" '^same$' \
    "$( [ "$before" = "$(cat "$nh_home/profiles.json")" ] && printf same || printf changed)"
  expect_match "hub resolve prints the hub's pick" '"model":"expected/fast"' "$(norch hub resolve fast 2>&1)"

  norch run start "Hub" --id hub-1 >/dev/null 2>&1
  norch node add hub-1 plan "Plan" --role planning >/dev/null 2>&1
  norch node add hub-1 check "Check" --role validation --tier fast --acceptance "tests pass" >/dev/null 2>&1
  norch node add hub-1 bare "Bare" >/dev/null 2>&1
  st="$nh_home/runs/hub-1/state.json"
  expect_match "hub mode gives a node without --profile the hub profile" '^opencode-smart-auto$' \
    "$(jq -r '.nodes[0].profile' "$st")"
  expect_match "hub mode maps the planning role to the intelligence tier" '^intelligence$' "$(jq -r '.nodes[0].tier' "$st")"
  expect_match "an explicit --tier beats the role mapping" '^fast$' "$(jq -r '.nodes[1].tier' "$st")"
  expect_match "a node without a role gets no tier" '^null$' "$(jq -r '.nodes[2].tier' "$st")"

  nh_job=$(norch node dispatch hub-1 plan "do it" 2>/dev/null)
  norch wait "$nh_job" --timeout 60 --interval 1 >/dev/null 2>&1
  nh_log=$(cat "$nh_home/jobs/$nh_job/log" 2>/dev/null)
  expect_match "opencode receives the tier header in the hub provider" '"x-llm-hub-smart-auto-tier":"intelligence"' "$nh_log"
  expect_match "opencode receives the worker identity" '"x-llm-hub-smart-auto-worker":"hub-1/plan/1"' "$nh_log"
  expect_match "an opencode node records the headers transport" '^headers$' "$(jq -r '.nodes[0].metadata_transport' "$st")"
  expect_match "dispatch asks the hub to resolve the node's tier and role" \
    '/api/smart-auto/resolve .*"tier":"intelligence".*"role":"planning"' "$(cat "$nh_dir/posts")"
  expect_match "dispatch records the expected model" '^expected/intelligence$' "$(jq -r '.nodes[0].hub.expected.model' "$st")"

  nh_check=$(norch node dispatch hub-1 check "check it" 2>/dev/null)
  norch wait "$nh_check" --timeout 60 --interval 1 >/dev/null 2>&1
  norch run sync hub-1 >/dev/null 2>&1
  expect_match "run sync records the model the hub used" '^used/model$' "$(jq -r '.nodes[0].hub.actual.model' "$st")"
  expect_match "a node without acceptance reports no outcome" '^null$' "$(jq -r '.nodes[0].hub.outcome' "$st")"
  expect_match "a node with acceptance reports tests_passed" '^tests_passed$' "$(jq -r '.nodes[1].hub.outcome' "$st")"
  expect_match "the outcome goes to the hub under the salted worker" \
    '/api/smart-auto/outcome .*"worker":"salted-hub-1/check/1".*"code":"tests_passed"' "$(cat "$nh_dir/posts")"

  # copilot cannot send headers, so its Smart Auto selector moves to the node's tier.
  # shellcheck source=/dev/null
  expect_match "hub_tier_model moves a selector to the tier" '^hub/smart-auto-fast$' \
    "$(bash -c ". '$SCRIPT'; hub_tier_model hub/smart-auto-balance fast")"
  expect_match "hub_tier_model keeps the long-context family" '^hub/smart-auto-long-intelligence$' \
    "$(bash -c ". '$SCRIPT'; hub_tier_model hub/smart-auto-long-balance intelligence")"
  expect_match "hub_tier_model leaves other models alone" '^llama_swap/x$' \
    "$(bash -c ". '$SCRIPT'; hub_tier_model llama_swap/x fast")"

  edit_json "$nh_home/profiles.json" '.settings.llm_hub.role_tiers.validation = "turbo"'
  norch node add hub-1 bad-tier "Bad" --role validation >/dev/null 2>&1
  expect_match "a role_tiers value that is not a tier falls back to the default" '^efficiency$' \
    "$(jq -r '.nodes[] | select(.id == "bad-tier") | .tier' "$st")"

  out=$(norch hub off 2>&1)
  expect_match "hub off turns the mode off" '^mode: off$' "$out"
  norch node add hub-1 after-off "After" --role planning >/dev/null 2>&1
  expect_match "with hub mode off a role adds no tier" '^null$' \
    "$(jq -r '.nodes[] | select(.id == "after-off") | .tier' "$st")"

  kill "$nh_pid" 2>/dev/null
  cleanup_dir "$nh_home"
  cleanup_dir "$nh_shims"
  cleanup_dir "$nh_dir"
fi


finish
