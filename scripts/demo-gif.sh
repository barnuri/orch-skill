#!/usr/bin/env bash
# Records docs/demo.gif: seeds mock runs, serves the dashboard against them, drives a real
# Chrome window through a storyboard, and assembles the frames with ffmpeg.
#
#   scripts/demo-gif.sh [--out FILE] [--port P] [--keep-frames]
#
# Re-runnable and self-contained. It never touches your real state dir — everything is seeded
# into a scratch HARNESS_ORCH_HOME that is trashed on exit — and it never calls a harness, so
# recording the GIF costs nothing.
#
# Chrome runs with a VISIBLE window on purpose: `chrome --screenshot` implies headless, and the
# frames are captured over the DevTools protocol instead (see scripts/lib/cdp-session.ts). You
# can watch the whole recording happen.
#
# Requires ffmpeg and Google Chrome. Missing either is a SKIP, not a failure, so this stays safe
# to call from a checkout that has neither.

set -u

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
SKILL_DIR="$REPO_DIR/skills/orch"
DISPATCH="$SKILL_DIR/scripts/dispatch.sh"
RECORDER="$SKILL_DIR/scripts/lib/demo-record.ts"

OUT_FILE="$REPO_DIR/docs/demo.gif"
SERVE_PORT=6931
CHROME_PORT=9331
KEEP_FRAMES=0
GIF_FPS=8
GIF_WIDTH=1280

WORK_DIR=""
CHROME_PID=""
DEMO_HOME=""

log() { printf 'demo-gif: %s\n' "$1" >&2; }
skip() { printf 'SKIP: %s\n' "$1" >&2; exit 0; }
die() { printf 'demo-gif: %s\n' "$1" >&2; exit 1; }

# Never `rm`: scratch dirs go to the Trash when possible (repo rule), else are left for the OS.
discard() {
  [ -n "${1:-}" ] && [ -e "$1" ] || return 0
  trash "$1" 2>/dev/null || true
}

cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$DEMO_HOME" ] && HARNESS_ORCH_HOME="$DEMO_HOME" bash "$DISPATCH" serve --stop >/dev/null 2>&1
  [ -n "$DEMO_HOME" ] && discard "$DEMO_HOME"
  if [ "$KEEP_FRAMES" -eq 0 ]; then
    discard "$WORK_DIR"
  else
    [ -n "$WORK_DIR" ] && log "frames kept in $WORK_DIR"
  fi
}
trap cleanup EXIT

find_chrome() {
  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT_FILE="${1:-$OUT_FILE}" ;;
    --port) shift; SERVE_PORT="${1:-$SERVE_PORT}" ;;
    --keep-frames) KEEP_FRAMES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

command -v ffmpeg >/dev/null 2>&1 || skip "ffmpeg not found — install it to record the GIF"
CHROME_BIN=$(find_chrome) || skip "no Chrome/Chromium found — install one to record the GIF"
command -v bun >/dev/null 2>&1 || skip "bun not found — needed to drive the browser"

WORK_DIR=$(mktemp -d)
DEMO_HOME="$WORK_DIR/home"
FRAME_DIR="$WORK_DIR/frames"
mkdir -p "$DEMO_HOME" "$FRAME_DIR"

log "seeding mock runs (no harness is called)"
HARNESS_ORCH_HOME="$DEMO_HOME" bash "$DISPATCH" init >/dev/null || die "init failed"
HARNESS_ORCH_HOME="$DEMO_HOME" bash "$DISPATCH" demo seed >/dev/null || die "demo seed failed"

# The storyboard opens the run that is still in flight.
RUN_ID=$(HARNESS_ORCH_HOME="$DEMO_HOME" bash "$DISPATCH" run list \
  | awk -F'\t' '$2 == "running" { print $1; exit }')
[ -n "$RUN_ID" ] || die "no running demo run to record"

log "serving the dashboard on 127.0.0.1:$SERVE_PORT"
HARNESS_ORCH_HOME="$DEMO_HOME" nohup bash "$DISPATCH" serve --host 127.0.0.1 --port "$SERVE_PORT" \
  >"$WORK_DIR/serve.log" 2>&1 &
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$SERVE_PORT/" && break
  sleep 0.25
done
curl -sf -o /dev/null "http://127.0.0.1:$SERVE_PORT/" || die "dashboard did not come up — see $WORK_DIR/serve.log"

log "opening Chrome (a window will appear — that is the recording)"
"$CHROME_BIN" \
  --remote-debugging-port="$CHROME_PORT" \
  --user-data-dir="$WORK_DIR/chrome-profile" \
  --no-first-run --no-default-browser-check \
  --window-size=1280,800 \
  "about:blank" >"$WORK_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

log "recording the storyboard"
FRAME_COUNT=$(bun "$RECORDER" \
  --port="$CHROME_PORT" \
  --base-url="http://127.0.0.1:$SERVE_PORT" \
  --run="$RUN_ID" \
  --out="$FRAME_DIR" \
  --dispatch="$DISPATCH" \
  --home="$DEMO_HOME") || die "recording failed"
[ "${FRAME_COUNT:-0}" -gt 0 ] || die "no frames captured"
log "captured $FRAME_COUNT frames"

mkdir -p "$(dirname "$OUT_FILE")"
# Two passes: a palette built from the whole clip, then applied — a single pass would dither
# each frame against its own palette and the UI's flat surfaces would visibly crawl.
log "encoding $OUT_FILE"
ffmpeg -y -loglevel error \
  -framerate "$GIF_FPS" -i "$FRAME_DIR/frame-%04d.png" \
  -vf "scale=$GIF_WIDTH:-1:flags=lanczos,palettegen=stats_mode=diff" \
  "$WORK_DIR/palette.png" || die "palettegen failed"
ffmpeg -y -loglevel error \
  -framerate "$GIF_FPS" -i "$FRAME_DIR/frame-%04d.png" -i "$WORK_DIR/palette.png" \
  -lavfi "scale=$GIF_WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$OUT_FILE" || die "gif encode failed"

log "wrote $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1 | tr -d ' '))"
