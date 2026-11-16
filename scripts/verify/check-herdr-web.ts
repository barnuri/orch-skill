#!/usr/bin/env bun
// check-herdr-web.ts [url] - the herdr-web pad answers and renders. Default url is the Tailscale pad.
import { run, sleep } from "../lib/util.ts";

const url = process.argv[2] ?? process.env["HERDR_WEB_URL"] ?? "http://100.69.220.91:1111/pad";
const s = "-s=verify-web";
const pw = (...a: string[]) => run(["playwright-cli", s, ...a]);
let code = 0;
try {
  code = (await fetch(url, { signal: AbortSignal.timeout(8000) })).status;
} catch {}
if (code === 200) console.log(`PASS ${url} -> 200`);
else (console.log(`FAIL ${url} -> ${code}`), process.exit(1));
if (pw("open", url).code !== 0) (console.log("FAIL browser cannot open"), process.exit(1));
await sleep(3000);
const n = Number(pw("eval", "() => document.body.innerText.length").out.replace(/\D/g, "")) || 0;
if (n > 20) console.log(`PASS rendered (${n} chars)`);
else (console.log("FAIL page empty"), pw("close"), process.exit(1));
pw("close");
