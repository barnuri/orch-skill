#!/usr/bin/env bash
# Captures docs/orch-graph-mod.png: the Claude Code orch-graph pane drawing a detailed mock run.
#
#   scripts/mod-screenshot.sh [--out FILE] [--keep]
#
# Seeds the run with `dispatch.sh demo seed --graph` in a scratch HARNESS_ORCH_HOME (trashed on
# exit) and never calls a harness. The picture is the mod's own drawGraph output, styled as a
# terminal, captured from a VISIBLE Chrome window over CDP, as demo-gif.sh does.
#
# Requires bun and Google Chrome (or Chromium). Missing either is a SKIP, not a failure.

set -u

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
DISPATCH="$REPO_DIR/skills/orch/scripts/dispatch.sh"
CAPTURE="$REPO_DIR/mods/orch-graph/scripts/screenshot.ts"

OUT_FILE="$REPO_DIR/docs/orch-graph-mod.png"
CHROME_PORT=9332
KEEP=0
WORK_DIR=""
CHROME_PID=""

log() { printf 'mod-screenshot: %s\n' "$1" >&2; }
skip() { printf 'SKIP: %s\n' "$1" >&2; exit 0; }
die() { printf 'mod-screenshot: %s\n' "$1" >&2; exit 1; }

# Never `rm`: scratch dirs go to the Trash when possible (repo rule), else are left for the OS.
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  if [ "$KEEP" -eq 1 ]; then
    [ -n "$WORK_DIR" ] && log "scratch kept in $WORK_DIR"
  elif [ -n "$WORK_DIR" ] && [ -e "$WORK_DIR" ]; then
    trash "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

find_chrome() {
  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT_FILE="${1:-$OUT_FILE}" ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

CHROME_BIN=$(find_chrome) || skip "no Chrome/Chromium found"
command -v bun >/dev/null 2>&1 || skip "bun not found"

WORK_DIR=$(mktemp -d)
export HARNESS_ORCH_HOME="$WORK_DIR/home"
mkdir -p "$HARNESS_ORCH_HOME"
orch() { bash "$DISPATCH" "$@"; }

log "seeding the detailed graph run (no harness is called)"
orch init >/dev/null || die "init failed"
RUN=$(orch demo seed --graph | sed -n 's/^demo: seeded graph run \([^ ]*\) .*/\1/p')
[ -n "$RUN" ] || die "demo seed --graph failed"

log "opening Chrome (a window will appear — that is the capture)"
"$CHROME_BIN" \
  --remote-debugging-port="$CHROME_PORT" \
  --user-data-dir="$WORK_DIR/chrome-profile" \
  --no-first-run --no-default-browser-check \
  --window-size=1600,900 \
  "about:blank" >"$WORK_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

mkdir -p "$(dirname "$OUT_FILE")"
bun "$CAPTURE" --home="$HARNESS_ORCH_HOME" --run="$RUN" --port="$CHROME_PORT" --out="$OUT_FILE" \
  || die "capture failed"
log "wrote $OUT_FILE"
