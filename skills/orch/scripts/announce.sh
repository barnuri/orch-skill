#!/usr/bin/env bash
# announce.sh: show orch activity in Herdr (display-only metadata) and in the status line files.
# Never fails the caller. See references/status-bridge.md.
set -u

RUN_ID="" TTL=120 DRY=0 CLEAR=0 QUIET=0 MODE=once
while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN_ID="${2:-}"; shift 2 ;;
    --ttl-sec) TTL="${2:-120}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --clear) CLEAR=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --daemon) MODE=daemon; shift ;;
    --stop) MODE=stop; shift ;;
    *) shift ;;
  esac
done
case "$TTL" in ''|*[!0-9]*) TTL=120 ;; esac

HOME_DIR="${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"
HERDR_TIMEOUT="${ANNOUNCE_HERDR_TIMEOUT:-5}"
SELF="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=$(cd "$(dirname "$SELF")" 2>/dev/null && pwd -P) || SCRIPT_DIR="."
REPO_ROOT=$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd -P) || REPO_ROOT=""
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/hooks/agent-env.sh" ]; then
  # shellcheck source=/dev/null
  . "$REPO_ROOT/hooks/agent-env.sh" 2>/dev/null || true
fi
type agent_session_id >/dev/null 2>&1 || agent_session_id() { printf '%s\n' "${CLAUDE_CODE_SESSION_ID:-${OPENCODE_SESSION_ID:-pid-$PPID}}"; }
type agent_harness >/dev/null 2>&1 || agent_harness() {
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then echo claude; elif [ -n "${OPENCODE_SESSION_ID:-}" ]; then echo opencode; else echo unknown; fi
}

out() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
run_limited() {
  local secs="$1"; shift
  if command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$secs" "$@"; else "$@"; fi
}
alive() { [ -n "${1:-}" ] && [ "$1" != null ] && kill -0 "$1" 2>/dev/null; }

# scan: ONE jq call over every run, loop and watch state file. Lines: R<TAB>running<TAB>done<TAB>total,
# L<TAB>pid<TAB>demo, W<TAB>pid. A corrupt file makes the batch fail, then each file is read alone.
scan_batch() {
  jq -rn --arg run "$RUN_ID" '
    inputs | input_filename as $f | ($f | split("/")) as $p | $p[-3] as $k | $p[-2] as $id
    | if $k == "runs" then
        select(.status == "running" and ($run == "" or $run == $id))
        | "R\t\(.nodes // [] | map(select(.status=="running")) | length)\t\(.nodes // [] | map(select(.status=="done")) | length)\t\(.nodes // [] | length)"
      elif $k == "loops" then select(.status == "running") | "L\t\(.pid // "")\t\(.demo // false)"
      elif $k == "watches" then select(.status == "running") | "W\t\(.pid // "")\t"
      else empty end' "$@"
}
scan_slow() {
  local f
  for f in "$@"; do
    scan_batch "$f" 2>/dev/null || true
  done
}

main() {
  command -v jq >/dev/null 2>&1 || return 0
  local running=0 done_n=0 total=0 loops=0 watches=0 f k pid demo a b c
  local -a files=()
  for f in "$HOME_DIR"/runs/*/state.json "$HOME_DIR"/loops/*/state.json "$HOME_DIR"/watches/*/state.json; do
    [ -f "$f" ] && files+=("$f")
  done
  if [ "${#files[@]}" -gt 0 ]; then
    local rows
    rows=$(scan_batch "${files[@]}" 2>/dev/null) || rows=$(scan_slow "${files[@]}")
    while IFS=$'\t' read -r k a b c; do
      case "$k" in
        R) running=$((running + ${a:-0})); done_n=$((done_n + ${b:-0})); total=$((total + ${c:-0})) ;;
        L) if alive "$a" || [ "$b" = true ]; then loops=$((loops + 1)); fi ;;
        W) alive "$a" && watches=$((watches + 1)) ;;
      esac
    done <<< "$rows"
  fi
  COUNT_BUSY=$((running + loops + watches))

  local summary="" active=false parts=""
  if [ "$CLEAR" -eq 0 ] && [ $((running + loops + watches)) -gt 0 ]; then
    active=true
    summary="orch: $running running, $done_n/$total done"
    [ "$loops" -gt 0 ] && summary="$summary · $loops loop$([ "$loops" -gt 1 ] && echo s)"
    [ "$watches" -gt 0 ] && summary="$summary · $watches monitor$([ "$watches" -gt 1 ] && echo s)"
    summary=$(printf '%s' "$summary" | cut -c1-120)
  fi

  local sid harness now json
  sid="${ANNOUNCE_SID:-$(agent_session_id 2>/dev/null)}"; [ -n "$sid" ] && [ "$sid" != unknown ] || sid="pid-$PPID"
  harness="${ANNOUNCE_HARNESS:-$(agent_harness 2>/dev/null)}"
  now=$(date +%s)
  json=$(jq -cn --argjson a "$active" --argjson t "$now" --argjson r "$running" --argjson d "$done_n" --argjson n "$total" --arg s "$summary" --arg pane "${HERDR_PANE_ID:-}" --arg h "$harness" \
    '{active:$a,updated_at:$t,running:$r,done:$d,total:$n,summary:$s,pane:$pane,harness:$h}')
  local wf_json="{\"active\":$active,\"updated_at\":$now}"

  # Herdr
  local bin="" pane="${HERDR_PANE_ID:-}" label="orch" cmd_desc=""
  if [ "${HERDR_ENV:-}" = 1 ] && [ -n "$pane" ]; then
    if [ -n "${HERDR_BIN_PATH:-}" ] && [ -x "$HERDR_BIN_PATH" ]; then bin="$HERDR_BIN_PATH"
    elif command -v herdr >/dev/null 2>&1; then bin=$(command -v herdr); fi
  fi
  if [ -n "$bin" ]; then
    local a
    local tmpc="${TMPDIR:-/tmp}/orch-announce-pane-$(id -u)"
    run_limited "$HERDR_TIMEOUT" "$bin" pane current >"$tmpc" 2>/dev/null </dev/null || true
    a=$(jq -r '.result.pane.agent // empty' "$tmpc" 2>/dev/null)
    [ -n "$a" ] && label="$a"
    local -a args
    if [ "$active" = true ]; then
      args=(pane report-metadata "$pane" --source user:orch --agent "$label" --state-label "idle=$summary" --state-label "working=$summary" --token "orch=$summary" --ttl-ms $((TTL * 1000)))
    else
      args=(pane report-metadata "$pane" --source user:orch --agent "$label" --clear-state-labels --clear-token orch --clear-title)
    fi
    if [ "$DRY" -eq 1 ]; then
      out "herdr: $bin ${args[*]}"
    else
      run_limited "$HERDR_TIMEOUT" "$bin" "${args[@]}" >/dev/null 2>&1 || true
    fi
  else
    [ "$DRY" -eq 1 ] && out "herdr: skipped (not in Herdr or no binary)"
  fi

  # Files
  local adir="$HOME_DIR/activity" wdir="$HOME/.claude/workflow-active"
  write_atomic() {
    local path="$1" body="$2" dir tmp
    dir=$(dirname "$path")
    if [ "$DRY" -eq 1 ]; then out "file: $path"; out "  $body"; return 0; fi
    ( umask 077; mkdir -p "$dir" && tmp=$(mktemp "$dir/.tmp.XXXXXX") && printf '%s\n' "$body" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$path" ) 2>/dev/null || true
  }
  write_atomic "$adir/$sid.json" "$json"
  [ "$harness" = claude ] && write_atomic "$wdir/$sid" "$wf_json"
  [ "$DRY" -eq 1 ] && out "summary: ${summary:-<none, clears>}"
  return 0
}

# --- daemon: refreshes every activity file and Herdr label on a fixed interval, so the TTL is never missed ---
PIDFILE="$HOME_DIR/announce.pid"
LOGFILE="$HOME_DIR/announce.log"
INTERVAL="${ANNOUNCE_INTERVAL:-20}"
IDLE_SECS="${ANNOUNCE_IDLE_SECS:-600}"
LOG_CAP=102400

dlog() {
  local size
  size=$(wc -c < "$LOGFILE" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$LOG_CAP" ]; then
    tail -c 50000 "$LOGFILE" > "$LOGFILE.tmp.$$" 2>/dev/null && mv -f "$LOGFILE.tmp.$$" "$LOGFILE" 2>/dev/null
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOGFILE" 2>/dev/null || true
}

pid_is_daemon() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -p "$1" -o command= 2>/dev/null)" in *announce.sh*) return 0 ;; *) return 1 ;; esac
}

claim_pidfile() {
  mkdir -p "$HOME_DIR" 2>/dev/null
  local cur
  if ( set -C; printf '%s\n' "$$" > "$PIDFILE" ) 2>/dev/null; then return 0; fi
  cur=$(cat "$PIDFILE" 2>/dev/null)
  if [ "$cur" != "$$" ] && pid_is_daemon "$cur"; then return 1; fi
  printf '%s\n' "$$" > "$PIDFILE" 2>/dev/null
  [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ]
}

daemon_tick() {
  local f sid pane h row
  for f in "$HOME_DIR"/activity/*.json; do
    [ -f "$f" ] || continue
    [ -z "$(find "$f" -mmin +60 2>/dev/null)" ] || continue
    sid=$(basename "$f" .json)
    row=$(jq -r '[.pane // "", .harness // ""] | @tsv' "$f" 2>/dev/null) || continue
    IFS=$'\t' read -r pane h <<< "$row"
    ( ANNOUNCE_IN_DAEMON=1 ANNOUNCE_SID="$sid" ANNOUNCE_HARNESS="$h" HERDR_PANE_ID="$pane"; \
      if [ -n "$pane" ]; then export HERDR_ENV=1; else export HERDR_ENV=0; fi; QUIET=1; main ) || true
  done
}

daemon_active() {
  local f any=1
  for f in "$HOME_DIR"/activity/*.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.active // false' "$f" 2>/dev/null)" = true ] && any=0
  done
  return $any
}

daemon_run() {
  claim_pidfile || exit 0
  trap '[ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ] && : > "$PIDFILE"; dlog "daemon $$ stopped"; exit 0' TERM INT EXIT
  dlog "daemon $$ started (interval ${INTERVAL}s, idle ${IDLE_SECS}s)"
  local idle_since now
  idle_since=$(date +%s)
  while :; do
    [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ] || { dlog "daemon $$ lost the pidfile"; break; }
    daemon_tick
    now=$(date +%s)
    if daemon_active; then idle_since=$now; elif [ $((now - idle_since)) -ge "$IDLE_SECS" ]; then dlog "daemon $$ idle, exiting"; break; fi
    sleep "$INTERVAL"
  done
  exit 0
}

ensure_daemon() {
  local cur
  cur=$(cat "$PIDFILE" 2>/dev/null)
  pid_is_daemon "$cur" && return 0
  mkdir -p "$HOME_DIR" 2>/dev/null
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' bash "$SELF" --daemon </dev/null >/dev/null 2>&1 &
  return 0
}

stop_daemon() {
  local cur
  cur=$(cat "$PIDFILE" 2>/dev/null)
  pid_is_daemon "$cur" && kill -TERM "$cur" 2>/dev/null
  return 0
}

case "$MODE" in
  daemon) daemon_run ;;
  stop) stop_daemon; exit 0 ;;
esac
main || true
if [ "$CLEAR" -eq 1 ]; then
  stop_daemon
elif [ "$DRY" -eq 0 ] && [ -z "${ANNOUNCE_IN_DAEMON:-}" ] && [ -z "${ANNOUNCE_NO_DAEMON:-}" ] && [ "${COUNT_BUSY:-0}" -gt 0 ]; then
  ensure_daemon
fi
exit 0
