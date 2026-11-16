#!/usr/bin/env bash
# check-herdr-web.sh [url] - the herdr-web pad answers and renders. Default url is the Tailscale pad.
set -u
url="${1:-${HERDR_WEB_URL:-http://100.69.220.91:1111/pad}}"; s=verify-web
code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$url"); [ "$code" = 200 ] && echo "PASS $url -> 200" || { echo "FAIL $url -> $code"; exit 1; }
playwright-cli -s=$s open "$url" >/dev/null 2>&1 || { echo "FAIL browser cannot open"; exit 1; }
sleep 3; n=$(playwright-cli -s=$s eval "() => document.body.innerText.length" 2>/dev/null | tr -dc 0-9)
[ "${n:-0}" -gt 20 ] && echo "PASS rendered ($n chars)" || { echo "FAIL page empty"; playwright-cli -s=$s close >/dev/null 2>&1; exit 1; }
playwright-cli -s=$s close >/dev/null 2>&1
