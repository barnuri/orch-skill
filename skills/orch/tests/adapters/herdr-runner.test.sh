#!/usr/bin/env bash
# Tests for the dedicated orch herdr instance: ensure, panes per job, wrapper-written exit files,
# auto-close, cap, fallbacks, and that the live herdr session is never used. A fake herdr binary
# stands in for most of it; one smoke test at the end drives the real herdr in an isolated HOME.
# Run with: bash herdr-runner.test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../test-lib.sh"

EVIDENCE_DIR=/private/var/folders/21/q6cg_6gx3911sv2l3y_w8t180000gn/T/opencode/herdr-runner
mkdir -p "$EVIDENCE_DIR"

root=$(new_tmp)
webdir="$root/envs.d"; WEB_PLUGIN=/Users/barnu/sandbox/private/herdr-web-plugin
fake="$root/fake"; shims="$root/shims"; realhome="$root/realhome"; home="$root/orch home"
mkdir -p "$fake" "$shims" "$realhome" "$home"
fake_log="$root/herdr-calls.log"
: > "$fake_log"

# --- fake herdr: state under $HOME/.config/herdr/fake, panes run their command like a pane shell would
cat > "$fake/herdr" <<'FAKE'
#!/usr/bin/env bash
cfg="$HOME/.config/herdr"; S="$cfg/fake"; sock="$cfg/herdr.sock"; state="$S/state.json"
mkdir -p "$S"
printf 'HOME=%s sock=%s socketenv=%s :: %s\n' "$HOME" "$sock" "${HERDR_SOCKET_PATH:-}" "$*" >> "${ORCH_HERDR_FAKE_LOG:-/dev/null}"
[ -f "$state" ] || printf '{"workspaces":[],"tabs":[],"panes":[],"next":1}' > "$state"
save() { jq "$@" "$state" > "$state.tmp" && mv "$state.tmp" "$state"; }
nid() { jq -r '.next' "$state"; save '.next += 1'; }
label_arg() { printf '%s\n' "$@" | sed -n '/^--label$/{n;p;}'; }
case "$1 $2" in
  "server stop") mv "$sock" "$sock.stopped" 2>/dev/null; exit 0 ;;
  "status --json")
    if [ -f "$sock" ] && kill -0 "$(cat "$sock" 2>/dev/null)" 2>/dev/null; then echo '{"server":{"running":true}}'; else echo '{"server":{"running":false}}'; fi ;;
  "workspace list") jq '{result:{workspaces:.workspaces}}' "$state" ;;
  "workspace create")
    n=$(nid)
    save --arg w "w$n" --arg l "$(label_arg "$@")" '.workspaces += [{workspace_id:$w,label:$l}] | .tabs += [{tab_id:($w+":t1"),workspace_id:$w,label:"1"}] | .panes += [{pane_id:($w+":p1"),tab_id:($w+":t1")}]'
    echo "{\"result\":{\"workspace\":{\"workspace_id\":\"w$n\"},\"tab\":{\"tab_id\":\"w$n:t1\"},\"root_pane\":{\"pane_id\":\"w$n:p1\"}}}" ;;
  "tab rename") save --arg t "$3" --arg l "$4" '(.tabs[] | select(.tab_id == $t) | .label) = ("[1] " + $l)'; echo '{}' ;;
  "tab list") jq --arg w "$4" '{result:{tabs:[.tabs[] | select(.workspace_id == $w)]}}' "$state" ;;
  "tab close") save --arg t "$3" '.tabs |= map(select(.tab_id != $t)) | .panes |= map(select(.tab_id != $t))'; echo '{}' ;;
  "tab create")
    n=$(nid); w=$4
    save --arg w "$w" --arg t "$w:t$n" --arg p "$w:p$n" --arg l "$(label_arg "$@")" '.tabs += [{tab_id:$t,workspace_id:$w,label:$l}] | .panes += [{pane_id:$p,tab_id:$t}]'
    echo "{\"result\":{\"tab\":{\"tab_id\":\"$w:t$n\"},\"root_pane\":{\"pane_id\":\"$w:p$n\"}}}" ;;
  "pane list") jq '{result:{panes:.panes}}' "$state" ;;
  "pane split")
    n=$(nid); src=$3; tab=$(jq -r --arg p "$src" '.panes[] | select(.pane_id == $p) | .tab_id' "$state")
    save --arg p "${src%%:*}:p$n" --arg t "$tab" '.panes += [{pane_id:$p,tab_id:$t}]'
    echo "{\"result\":{\"pane\":{\"pane_id\":\"${src%%:*}:p$n\"}}}" ;;
  "pane rename") save --arg p "$3" --arg l "$4" '(.panes[] | select(.pane_id == $p) | .label) = $l'; echo '{}' ;;
  "pane close") save --arg p "$3" '.panes |= map(select(.pane_id != $p)) | . as $s | .tabs |= map(select(.tab_id as $t | $s.panes | any(.tab_id == $t))) | . as $s | .workspaces |= map(select(.workspace_id as $w | $s.tabs | any(.workspace_id == $w)))'; echo '{"result":{"type":"ok"}}' ;;
  "pane read") cat "$S/pane-$3.out" 2>/dev/null ;;
  "pane run") nohup bash -c "$4" > "$S/pane-$3.out" 2>&1 < /dev/null & echo '{}' ;;
  *)
    if [ "$1" = server ]; then
      [ -z "${ORCH_HERDR_FAKE_DOWN:-}" ] || exit 1
      printf 'x\n' >> "$S/starts"; sleep 0.3
      printf '%s' "$$" > "$sock"
      while [ -f "$sock" ]; do sleep 0.2; done
      exit 0
    fi
    echo "fake herdr: unsupported $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$fake/herdr"

# claude shim: prints HOME and a marker, then exits ORCH_TEST_EXIT (default 0) after ORCH_TEST_SLEEP
cat > "$shims/claude" <<'SHIM'
#!/usr/bin/env bash
printf 'shim HOME=%s marker=%s\n' "$HOME" "${ORCH_TEST_MARKER:-none}"
[ -z "${ORCH_TEST_SLEEP:-}" ] || sleep "$ORCH_TEST_SLEEP"
exit "${ORCH_TEST_EXIT:-0}"
SHIM
chmod +x "$shims/claude"

# `${home}` has a space and is long on purpose: the socket must still end up under 104 bytes.
d() {
  env -u ORCH_RUN_ID -u ORCH_NODE_ID -u ORCH_NODE_ATTEMPT HOME="$realhome" PATH="$fake:$shims:$PATH" HARNESS_ORCH_HOME="$home" ORCH_HERDR=1 \
    ORCH_HERDR_FAKE_LOG="$fake_log" ORCH_HERDR_CLOSE_AFTER=1 ORCH_HERDR_START_WAIT=8 ORCH_HERDR_CALL_TIMEOUT=40 ORCH_HERDR_WEB_ENVS_DIR="$webdir" \
    HERDR_SOCKET_PATH="$realhome/live-session.sock" HERDR_ENV=1 HERDR_PANE_ID=live:p1 "$@"
}
fake_state() { cat "$home/herdr/home/.config/herdr/fake/state.json" 2>/dev/null; }
wait_job() { d bash "$SCRIPT" wait "$1" --timeout 90 --interval 1 >/dev/null 2>&1; }

# Mirrors the herdr web plugin's registry rules (lib/envs.js readRegistry): id pattern, not "default",
# non-empty label <= 40, absolute home and socket <= 400 bytes, file <= 4 KB. Prints 1 when valid.
web_env_valid() {
  local f="$1" size
  size=$(wc -c < "$f" | tr -d ' ')
  [ "$size" -le 4096 ] || { echo 0; return; }
  jq -e '(.id | test("^[a-z0-9][a-z0-9_-]{0,31}$")) and .id != "default"
    and (.label | type == "string" and (gsub("^\\s+|\\s+$"; "") | length > 0 and length <= 40))
    and (.home | startswith("/") and length <= 400) and (.socket | startswith("/") and length <= 400)' "$f" >/dev/null 2>&1 && echo 1 || echo 0
}

d bash "$SCRIPT" init >/dev/null 2>&1

# --- ensure: idempotent, single flight, minimal config
d bash "$SCRIPT" herdr ensure >/dev/null 2>&1; expect_exit "ensure starts the instance" 0 $?
d bash "$SCRIPT" herdr ensure >/dev/null 2>&1; expect_exit "a second ensure is a no-op" 0 $?
for _ in 1 2 3; do d bash "$SCRIPT" herdr ensure >/dev/null 2>&1 & done; wait
inst_cfg="$home/herdr/home/.config/herdr"
expect_match "the server started once for five ensures" '^1$' "$(wc -l < "$inst_cfg/fake/starts" | tr -d ' ')"
expect_file "minimal config.toml written" "$inst_cfg/config.toml"
expect_no_match "the config enables no plugin or notification" 'plugin|sound|delivery = "(os|all)"' "$(grep -v '^#' "$inst_cfg/config.toml")"
expect_match "the pidfile exists" '^[0-9]+$' "$(tr -d '\n' < "$home/herdr/server.pid")"
out=$(d bash "$SCRIPT" herdr status 2>&1)
expect_match "status says running" '^server: running' "$out"
expect_match "status prints the attach command with the instance HOME" 'HOME=.*herdr' "$out"
expect_match "status prints the default reason" '^herdr: on \(ORCH_HERDR=1\)' "$out"

# --- web registry: the instance appears in the herdr web UI as "orch-skill"
wf="$webdir/orch-skill.json"
expect_file "ensure writes the web env file in the override dir" "$wf"
expect_match "the web env file passes the plugin's rules" '^1$' "$(web_env_valid "$wf")"
expect_match "the web env id and label are orch-skill" '^orch-skill orch-skill$' "$(jq -r '"\(.id) \(.label)"' "$wf")"
expect_match "the web env socket is the instance socket (short symlink path)" '^/tmp/orch-herdr-[0-9]+-[0-9]+/\.config/herdr/herdr\.sock$' "$(jq -r .socket "$wf")"
expect_match "the web env home is the instance HOME" '^/tmp/orch-herdr-' "$(jq -r .home "$wf")"
expect_match "the live socket answers at that path" '^1$' "$([ -f "$(jq -r .socket "$wf")" ] && echo 1 || echo 0)"
expect_missing "no temp file is left behind (atomic write)" "$wf.tmp.$$"
expect_match "only the final file is in the dir" '^orch-skill.json$' "$(ls "$webdir")"
jq '.socket = "/stale/path.sock"' "$wf" > "$wf.x" && mv "$wf.x" "$wf"
d bash "$SCRIPT" herdr ensure >/dev/null 2>&1
expect_match "ensure rewrites a stale web env file" '/herdr\.sock$' "$(jq -r .socket "$wf")"
expect_no_match "the user's real config dir is untouched" 'herdr-web' "$(cat "$fake_log")"
expect_missing "the real HOME got no herdr-web dir" "$realhome/.config/herdr-web"

# --- herdr health: server pid, socket, registry file, web plugin listing; --nudge self-heals
hj() { d env ORCH_HERDR_WEB_URL="${WEB_URL:-off}" bash "$SCRIPT" herdr health --json "$@" 2>/dev/null; }
out=$(hj)
expect_match "health is ok with the instance up" '^ok$' "$(printf '%s' "$out" | jq -r .state)"
expect_match "health sees the pid, socket and registry" '^true true ok skipped orch-skill$' \
  "$(printf '%s' "$out" | jq -r '"\(.pid_alive) \(.socket_ok) \(.registry) \(.web) \(.env_id)"')"
expect_match "health names the registry path" "^$webdir/orch-skill.json\$" "$(printf '%s' "$out" | jq -r .registry_path)"
expect_match "plain health prints the state" '^herdr health: ok' "$(d env ORCH_HERDR_WEB_URL=off bash "$SCRIPT" herdr health 2>&1)"
# A stand-in for the web plugin's GET /api/envs.
webroot="$root/webroot"; mkdir -p "$webroot/api"
web_port=$(( 20000 + RANDOM % 20000 ))
( cd "$webroot" && exec python3 -m http.server "$web_port" --bind 127.0.0.1 ) >/dev/null 2>&1 &
web_srv=$!
printf '[{"id":"default","label":"default","default":true,"reachable":true},{"id":"orch-skill","label":"orch-skill","default":false,"reachable":true}]' > "$webroot/api/envs"
wait_until "curl -fs http://127.0.0.1:$web_port/api/envs" 20
WEB_URL="http://127.0.0.1:$web_port"
expect_match "health sees the env listed in herdr web" '^ok listed$' "$(hj | jq -r '"\(.state) \(.web)"')"
printf '[{"id":"default","label":"default","default":true,"reachable":true}]' > "$webroot/api/envs"
expect_match "an env herdr web does not list is degraded" '^degraded missing$' "$(hj | jq -r '"\(.state) \(.web)"')"
d env ORCH_HERDR_WEB_URL="$WEB_URL" bash "$SCRIPT" herdr health >/dev/null 2>&1; expect_exit "degraded health exits 1" 1 $?
kill "$web_srv" 2>/dev/null; wait "$web_srv" 2>/dev/null
expect_match "a plugin that does not answer is reported, not degraded" '^ok no-plugin$' "$(hj | jq -r '"\(.state) \(.web)"')"
WEB_URL=off
mv "$wf" "$root/wf.moved"
expect_match "a missing registry file is degraded" '^degraded missing$' "$(hj | jq -r '"\(.state) \(.registry)"')"
expect_match "--nudge re-registers the env" '^ok ok true$' "$(hj --nudge | jq -r '"\(.state) \(.registry) \(.nudged)"')"
expect_file "--nudge wrote the registry file back" "$wf"
d bash "$SCRIPT" herdr stop >/dev/null 2>&1
mkdir -p "$webdir"; jq -n '{id:"orch-skill",label:"orch-skill",home:"/x",socket:"/x/s"}' > "$wf"
out=$(hj)
expect_match "a stopped instance is down" '^down false wrong$' "$(printf '%s' "$out" | jq -r '"\(.state) \(.socket_ok) \(.registry)"')"
expect_match "down health lists the socket problem" 'does not answer' "$(printf '%s' "$out" | jq -r '.problems[]')"
d env ORCH_HERDR_WEB_URL=off bash "$SCRIPT" herdr health >/dev/null 2>&1; expect_exit "down health exits 3" 3 $?
expect_match "--nudge restarts a dead instance" '^ok true true$' "$(hj --nudge | jq -r '"\(.state) \(.socket_ok) \(.nudged)"')"
expect_match "the restarted instance was started a second time" '^2$' "$(wc -l < "$inst_cfg/fake/starts" | tr -d ' ')"
expect_match "--nudge fixed the wrong registry file" '/herdr\.sock$' "$(jq -r .socket "$wf")"
: > "$fake_log"
expect_match "ORCH_HERDR=0 health is off" '^off false$' "$(d env ORCH_HERDR=0 ORCH_HERDR_WEB_URL=off bash "$SCRIPT" herdr health --json --nudge | jq -r '"\(.state) \(.enabled)"')"
expect_match "off health makes no herdr call" '^0$' "$(wc -l < "$fake_log" | tr -d ' ')"
# serve boot: `dispatch.sh serve` ensures and registers the instance in the background.
d bash "$SCRIPT" herdr stop >/dev/null 2>&1
expect_missing "stop removed the registry before the serve boot" "$wf"
d bash -c 'source "$1"; herdr_serve_boot' _ "$SCRIPT"
wait_until "[ -f '$wf' ]" 30
expect_file "the serve boot registers the env" "$wf"
expect_match "the serve boot started the instance" '^ok$' "$(hj | jq -r .state)"
d env ORCH_HERDR=0 bash -c 'source "$1"; herdr_serve_boot' _ "$SCRIPT"; expect_exit "serve boot with ORCH_HERDR=0 is a no-op" 0 $?
grep -q 'herdr_serve_boot' "$SCRIPT_DIR/lib/dashboard/serve.sh"; expect_exit "cmd_serve calls the herdr serve boot" 0 $?

# --- a job runs in a pane; the wrapper writes the exit file; HOME and env are restored
job=$(d env ORCH_HERDR_CLOSE_AFTER=6 ORCH_TEST_MARKER=m1 bash "$SCRIPT" start claude "pane probe" 2>/dev/null)
wait_job "$job"
jd="$home/jobs/$job"
expect_match "the job finishes with exit 0" '^done exit=0$' "$(d bash "$SCRIPT" status "$job")"
expect_match "the exit file comes from the wrapper" '^0$' "$(cat "$jd/exit_code" 2>/dev/null)"
expect_match "the pane id is saved in the job dir" '^w1:p2$' "$(cat "$jd/herdr_pane" 2>/dev/null)"
expect_match "the instance socket is saved in the job dir" 'herdr\.sock$' "$(cat "$jd/herdr_sock" 2>/dev/null)"
expect_match "the pane runs with the real HOME and the job env" "shim HOME=$realhome marker=m1" "$(cat "$jd/log" 2>/dev/null)"
expect_no_match "the launcher stores no unrelated env" 'live-session' "$(cat "$jd/herdr-launch.sh")"
expect_match "the generated command line starts the TypeScript launcher" 'exec bun .*/core/commands/herdr-launch\.ts' "$(cat "$jd/herdr-launch.sh")"
expect_match "the job's argv is written for the launcher" '"bash","-c"' "$(cat "$jd/argv.json" 2>/dev/null)"
expect_match "the job's tab is titled with the job id" "(^|\] )$job\$" "$(fake_state | jq -r '.tabs[].label')"
expect_match "a job with no run gets a workspace labelled jobs" '^jobs$' "$(fake_state | jq -r '.workspaces[].label')"
expect_no_match "the job's tab has no split pane" 'pane split' "$(cat "$fake_log")"

# --- success: the tab lingers, then closes (ORCH_HERDR_CLOSE_AFTER=1)
wait_until "[ \"\$(fake_state | jq '.tabs | length')\" = 0 ]" 30
expect_match "a successful job's tab closes after the linger" '^0$' "$(fake_state | jq '.tabs | length')"

# --- a run node: one workspace per run, one tab per node titled with the node id, one pane in it
: > "$fake_log"
d bash "$SCRIPT" run start "Herdr run" --id hr-run >/dev/null
d bash "$SCRIPT" node add hr-run a "a" >/dev/null
node_job=$(d env ORCH_HERDR_CLOSE_AFTER=30 ORCH_TEST_EXIT=3 bash "$SCRIPT" node dispatch hr-run a claude "fail probe" 2>/dev/null)
wait_job "$node_job"
expect_match "a failed job records its exit code" '^done exit=3$' "$(d bash "$SCRIPT" status "$node_job")"
expect_match "the run has its own workspace" '^hr-run$' "$(fake_state | jq -r '.workspaces[].label')"
expect_match "the node tab is titled with the node id" '(^|\] )a$' "$(fake_state | jq -r '.tabs[].label')"
expect_match "the node tab holds exactly one pane" '^1$' \
  "$(fake_state | jq '[.tabs[] | select(.label == "a" or .label == "[1] a") | .tab_id] as $t | [.panes[] | select(.tab_id == $t[0])] | length')"
expect_match "the node job made one tab and no split" '^1 0$' \
  "$(printf '%s %s' "$(grep -c 'tab create' "$fake_log")" "$(grep -c 'pane split' "$fake_log")")"
expect_match "the node job tab is saved in the job dir" '^w[0-9]+:t[0-9]+$' "$(cat "$home/jobs/$node_job/herdr_tab")"

# --- retry reuses the node tab: no new tab, title gets the attempt number
: > "$fake_log"
retry_job=$(d env ORCH_RUN_ID=hr-run ORCH_NODE_ID=a ORCH_NODE_ATTEMPT=2 ORCH_HERDR_CLOSE_AFTER=30 ORCH_TEST_EXIT=0 bash "$SCRIPT" start claude "retry probe" 2>/dev/null)
wait_job "$retry_job"
expect_match "a retry makes no new tab" '^0$' "$(grep -c 'tab create' "$fake_log")"
expect_match "a retry renames the reused tab with the attempt" '^\[1\] a #2$' "$(fake_state | jq -r '.tabs[].label')"
expect_match "the retry runs in the same tab as the first attempt" "^$(cat "$home/jobs/$node_job/herdr_tab")\$" "$(cat "$home/jobs/$retry_job/herdr_tab")"
expect_match "the first attempt's closer does not close the reused tab" '^1$' "$(fake_state | jq '.tabs | length')"

# --- pane cap: close the run's tabs, then cap 2 runs one pane and cap 1 falls back
inst_herdr() { env -i PATH="$fake:$PATH" HOME="$home/herdr/home" herdr "$@"; }
for t in $(fake_state | jq -r '.tabs[].tab_id'); do inst_herdr tab close "$t" >/dev/null; done
cap2=$(d env ORCH_HERDR_PANE_CAP=2 ORCH_HERDR_CLOSE_AFTER=30 ORCH_TEST_EXIT=1 bash "$SCRIPT" start claude "cap two" 2>/dev/null); wait_job "$cap2"
cap3=$(d env ORCH_HERDR_PANE_CAP=1 ORCH_TEST_EXIT=1 bash "$SCRIPT" start claude "cap three" 2>/dev/null); wait_job "$cap3"
expect_file "the job under the cap has a pane" "$home/jobs/$cap2/herdr_pane"
expect_missing "the job over the cap runs detached (no pane)" "$home/jobs/$cap3/herdr_pane"
expect_match "the capped job still finishes through the wrapper" '^done exit=1$' "$(d bash "$SCRIPT" status "$cap3")"

# --- task 5: the job process dies without an exit code -> the node gets a note event
d bash "$SCRIPT" run start "Gone run" --id gone-run >/dev/null
d bash "$SCRIPT" node add gone-run a "a" >/dev/null
gone_job=$(d env ORCH_TEST_SLEEP=60 bash "$SCRIPT" node dispatch gone-run a claude "die" 2>/dev/null)
wait_until "[ -s '$home/jobs/$gone_job/pid' ]" 30
gone_kids=$(pgrep -P "$(cat "$home/jobs/$gone_job/pid")" 2>/dev/null)
kill -9 "$(cat "$home/jobs/$gone_job/pid")" 2>/dev/null; kill -9 $gone_kids 2>/dev/null
wait_until "! kill -0 $(cat "$home/jobs/$gone_job/pid") 2>/dev/null" 20
d bash "$SCRIPT" run sync gone-run --no-retry >/dev/null 2>&1
expect_match "a lost job's node becomes error" '^error$' "$(jq -r '.nodes[0].status' "$home/runs/gone-run/state.json")"
expect_match "the node gets a pane-gone event" '"kind":"note".*"node":"a".*pane w[0-9]+:p[0-9]+ is gone' "$(cat "$home/runs/gone-run/events.jsonl")"

# --- the live session is never used: every fake call ran under the instance HOME, none saw a socket env
bad=$(grep -vc "HOME=$home/herdr/home\|HOME=/tmp/orch-herdr-" "$fake_log")
expect_match "every herdr call used the instance HOME" '^0$' "$bad"
expect_no_match "no call saw the caller's HERDR_SOCKET_PATH" 'socketenv=.+ ::' "$(cat "$fake_log")"
expect_no_match "the live session socket is never logged" 'live-session|realhome' "$(cat "$fake_log")"
expect_match "the instance socket path is under 104 bytes" '^1$' "$(grep -o 'sock=[^ ]*herdr.sock' "$fake_log" | sed 's/^sock=//' | awk '{ if (length($0) < 104) ok=1; else { ok=0; exit } } END { print ok }')"

# --- fallbacks: herdr missing, ORCH_HERDR=0, instance unreachable
: > "$fake_log"
nopath=$(path_without herdr)
miss=$(env HOME="$realhome" PATH="$shims:$nopath" HARNESS_ORCH_HOME="$home" ORCH_HERDR=1 bash "$SCRIPT" start claude "missing" 2>/dev/null)
wait_job "$miss"
expect_match "with herdr missing the job runs detached" '^done exit=0$' "$(d bash "$SCRIPT" status "$miss")"
expect_missing "no pane when herdr is missing" "$home/jobs/$miss/herdr_pane"
out=$(env HOME="$realhome" PATH="$shims:$nopath" HARNESS_ORCH_HOME="$home" bash "$SCRIPT" herdr status 2>&1)
expect_match "status names the missing binary" 'herdr not on PATH' "$out"

off=$(d env ORCH_HERDR=0 bash "$SCRIPT" start claude "off" 2>/dev/null)
wait_job "$off"
expect_match "ORCH_HERDR=0 runs detached" '^done exit=0$' "$(d bash "$SCRIPT" status "$off")"
expect_missing "no pane with ORCH_HERDR=0" "$home/jobs/$off/herdr_pane"
expect_match "ORCH_HERDR=0 makes no herdr call at all" '^0$' "$(wc -l < "$fake_log" | tr -d ' ')"

d bash "$SCRIPT" herdr stop >/dev/null 2>&1
expect_missing "stop removes the web env file" "$wf"
expect_match "stop stops the instance" 'server: not running' "$(d bash "$SCRIPT" herdr status 2>&1)"
d env ORCH_HERDR=0 bash "$SCRIPT" herdr ensure >/dev/null 2>&1
expect_missing "ORCH_HERDR=0 writes no web env file" "$wf"
d bash "$SCRIPT" herdr stop >/dev/null 2>&1
down=$(d env ORCH_HERDR_FAKE_DOWN=1 bash "$SCRIPT" start claude "unreachable" 2>/dev/null)
wait_job "$down"
expect_match "an instance that cannot start leaves the job detached" '^done exit=0$' "$(d bash "$SCRIPT" status "$down")"
expect_missing "no pane when the instance is unreachable" "$home/jobs/$down/herdr_pane"

# --- one real, isolated herdr: temp HOME, headless server, run `echo hi`, read the pane, stop
if command -v herdr >/dev/null 2>&1; then
  real_root=$(new_tmp)
  rhome="$real_root/orch home with a long path to force the short symlink"
  mkdir -p "$rhome" "$real_root/realhome" "$real_root/shims"
  printf '#!/usr/bin/env bash\necho hi\n' > "$real_root/shims/claude"; chmod +x "$real_root/shims/claude"
  rd() {
    env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID HOME="$real_root/realhome" PATH="$real_root/shims:$PATH" \
      HARNESS_ORCH_HOME="$rhome" ORCH_HERDR=1 ORCH_HERDR_CLOSE_AFTER=30 ORCH_HERDR_WEB_ENVS_DIR="$real_root/envs.d" "$@"
  }
  rd bash "$SCRIPT" init >/dev/null 2>&1
  rd bash "$SCRIPT" herdr ensure >/dev/null 2>&1; expect_exit "real herdr: ensure" 0 $?
  rinst=$(rd bash "$SCRIPT" herdr status 2>&1 | sed -n 's/^home: //p')
  sleep 5
  idle=$(ps eww -axo pid=,rss=,%cpu=,command= 2>/dev/null | grep "herdr server" | grep -F "HOME=$rinst " | grep -v grep | awk '{print "pid="$1" rss_kb="$2" cpu%="$3}' | head -1)
  rjob=$(rd bash "$SCRIPT" start claude "hi" 2>/dev/null)
  rd bash "$SCRIPT" wait "$rjob" --timeout 90 --interval 1 >/dev/null 2>&1
  rpane=$(cat "$rhome/jobs/$rjob/herdr_pane" 2>/dev/null)
  sleep 1
  pane_text=$(env -i PATH="$PATH" HOME="$rinst" herdr pane read "$rpane" 2>&1)
  expect_match "real herdr: the job ran in a pane" '^w' "$rpane"
  expect_match "real herdr: the pane shows the job output" '(^|[^a-z])hi' "$pane_text"
  expect_match "real herdr: exit 0 from the wrapper" '^done exit=0$' "$(rd bash "$SCRIPT" status "$rjob")"
  expect_match "real herdr: the log has the output" 'hi' "$(cat "$rhome/jobs/$rjob/log")"
  expect_match "real herdr: the node tab title is set" "$rjob" "$(env -i PATH="$PATH" HOME="$rinst" herdr pane list 2>&1)"
  expect_no_match "real herdr: no plugin loaded in the instance" 'herdr-folders' "$(env -i PATH="$PATH" HOME="$rinst" herdr plugin list 2>&1)"
  # Second web plugin server on a temp port, its own HOME and registry dir: never the live plugin.
  web_out=""
  if command -v node >/dev/null 2>&1 && [ -f "$WEB_PLUGIN/server.js" ]; then
    expect_match "real herdr: the web env file is valid" '^1$' "$(web_env_valid "$real_root/envs.d/orch-skill.json")"
    mkdir -p "$real_root/webhome" "$real_root/webcfg"
    ( cd "$WEB_PLUGIN" && exec env -i PATH="$PATH" HOME="$real_root/webhome" HERDR_PLUGIN_CONFIG_DIR="$real_root/webcfg" \
        HERDR_WEB_HOST=127.0.0.1 HERDR_WEB_PORT=6965 HERDR_WEB_ENVS_DIR="$real_root/envs.d" HARNESS_ORCH_HOME="$rhome" \
        node server.js ) > "$real_root/web.log" 2>&1 &
    web_pid=$!
    wait_until "curl -fs http://127.0.0.1:6965/api/envs" 40
    web_out=$(curl -s http://127.0.0.1:6965/api/envs 2>&1)
    kill "$web_pid" 2>/dev/null
    expect_match "real herdr: the second web plugin lists orch-skill" '"id":"orch-skill"' "$web_out"
    expect_match "real herdr: orch-skill is labelled orch-skill" '"label":"orch-skill"' "$web_out"
    expect_no_match "real herdr: the registered instance is not listed twice (no auto orch env)" '"id":"orch"' "$web_out"
  else
    printf 'SKIP: web plugin discovery (node or plugin missing)\n'
  fi
  printf '%s\n' "$web_out" > "$EVIDENCE_DIR/web-envs.json"
  rd bash "$SCRIPT" herdr stop >/dev/null 2>&1
  expect_missing "real herdr: stop removes the web env file" "$real_root/envs.d/orch-skill.json"
  expect_match "real herdr: the server is stopped" 'server: not running' "$(rd bash "$SCRIPT" herdr status 2>&1)"
  {
    printf 'instance HOME (short symlink): %s\ninstance socket bytes: %s\n' "$rinst" "$(printf '%s' "$rinst/.config/herdr/herdr.sock" | wc -c | tr -d ' ')"
    printf 'idle server (5 s after ensure, no panes): %s\n' "${idle:-not measured}"
    printf 'pane id: %s\npane read:\n%s\n' "$rpane" "$pane_text"
    printf 'job log:\n%s\nexit_code: %s\n' "$(cat "$rhome/jobs/$rjob/log")" "$(cat "$rhome/jobs/$rjob/exit_code")"
    printf 'config.toml:\n%s\n' "$(cat "$rhome/herdr/home/.config/herdr/config.toml")"
  } > "$EVIDENCE_DIR/smoke.txt"
  cleanup_dir "$real_root"
else
  printf 'SKIP: real herdr smoke test (herdr not on PATH)\n'
fi

d bash "$SCRIPT" herdr stop >/dev/null 2>&1
cleanup_dir "$root"
finish
