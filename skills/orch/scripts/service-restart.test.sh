#!/usr/bin/env bash
# service.sh restart safety: a supervisor restart must kill only the server, never the jobs it started.
# launchd: real throwaway label (never the real service). systemd: generated unit text only.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-lib.sh"

SVC="$SCRIPT_DIR/../../../scripts/service.sh"
T=$(new_tmp)
LABELS_FILE="$T/labels"
cleanup() {
  local l
  for l in $(cat "$LABELS_FILE" 2>/dev/null); do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null; trash "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null; done
  cleanup_dir "$T"
}
trap cleanup EXIT

# Source the functions without running main (last line is `main "$@"`).
load_service() { eval "$(sed '$d' "$SVC")"; }
export HOME_REAL="$HOME"

# --- generated unit text ---
export HOME="$T/home" HARNESS_ORCH_HOME="$T/orch" ORCH_BUN="$(command -v bun || echo /usr/bin/true)"
mkdir -p "$HOME"
load_service
bun_path() { printf '%s\n' "$ORCH_BUN"; }
log_file() { printf '%s\n' "$T/log"; }
XDG_CONFIG_HOME="$T/xdg"
u1=$(systemd_write_unit); a=$(cat "$u1")
u2=$(systemd_write_unit); b=$(cat "$u2")
expect_match "systemd unit KillMode=process" '^KillMode=process$' "$a"
expect_no_match "systemd unit has no SendSIGKILL=no" 'SendSIGKILL' "$a"
expect_match "systemd unit idempotent" '^Restart=always$' "$a"
[ "$a" = "$b" ] && pass_count=$((pass_count + 1)) || { echo "FAIL: systemd unit not idempotent" >&2; failures=$((failures + 1)); }
p1=$(launchd_write_plist); pa=$(cat "$p1")
p2=$(launchd_write_plist); pb=$(cat "$p2")
expect_match "plist AbandonProcessGroup true" '<key>AbandonProcessGroup</key>[[:space:]]*<true/>' "$(tr '\n' ' ' <<<"$pa")"
[ "$pa" = "$pb" ] && pass_count=$((pass_count + 1)) || { echo "FAIL: plist not idempotent" >&2; failures=$((failures + 1)); }
export HOME="$HOME_REAL"

# --- real launchd survival probe (macOS only) ---
survive() { # label with_abandon -> prints "plain=<alive|dead> setsid=<alive|dead>"
  local label="$1" abandon="$2" d="$T/$1" plist="$HOME/Library/LaunchAgents/$1.plist"
  mkdir -p "$d"
  cat > "$d/server.sh" <<EOS
#!/bin/bash
echo \$\$ > "$d/server.pid"
[ -e "$d/setsid.pid" ] && exec sleep 300
sleep 300 & echo \$! > "$d/plain.pid"
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sleep 300 </dev/null >/dev/null 2>&1 &
echo \$! > "$d/setsid.pid"
wait
EOS
  python3 - "$plist" "$label" "$d/server.sh" "$abandon" <<'EP'
import plistlib, sys
p, label, script, ab = sys.argv[1:]
d = {"Label": label, "ProgramArguments": ["/bin/bash", script], "KeepAlive": True, "ThrottleInterval": 1, "RunAtLoad": True}
if ab == "1": d["AbandonProcessGroup"] = True
plistlib.dump(d, open(p, "wb"))
EP
  echo "$label" >> "$LABELS_FILE"
  launchctl bootstrap "gui/$(id -u)" "$plist" || return 1
  wait_until "test -s '$d/setsid.pid'" 15
  sleep 1
  local s1; s1=$(cat "$d/server.pid")
  launchctl kickstart -k "gui/$(id -u)/$label"
  wait_until "[ \"\$(cat '$d/server.pid')\" != '$s1' ]" 20
  sleep 1
  local r="" n
  for n in plain setsid; do
    kill -0 "$(cat "$d/$n.pid")" 2>/dev/null && r="$r $n=alive" || r="$r $n=dead"
  done
  kill $(cat "$d/plain.pid" "$d/setsid.pid") 2>/dev/null
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  printf '%s\n' "${r# }"
}
if [ "$(uname -s)" = Darwin ]; then
  rid=$RANDOM$RANDOM
  before=$(survive "com.orch.test.before$rid" 0); echo "label com.orch.test.before$rid: $before" >&2
  after=$(survive "com.orch.test.after$rid" 1); echo "label com.orch.test.after$rid: $after" >&2
  expect_match "launchd without Abandon: plain child dies" 'plain=dead' "$before"
  expect_match "launchd with Abandon: plain child survives" 'plain=alive setsid=alive' "$after"
fi
finish
