#!/usr/bin/env bun
// check-api.ts [base-url] - service build, watchdog and run summary. Exit 1 on any FAIL.
const base = process.argv[2] ?? "http://127.0.0.1:6724";
let fail = false;
const ok = (m: string): void => console.log(`PASS ${m}`);
const bad = (m: string): void => {
  console.log(`FAIL ${m}`);
  fail = true;
};
const get = async (p: string): Promise<any> => (await fetch(base + p, { signal: AbortSignal.timeout(10000) })).json();

let b: any;
try {
  b = await get("/api/build");
} catch {
  bad(`service not reachable at ${base}`);
  process.exit(1);
}
if (b.stale === false) ok(`build stale:false (head ${String(b.head).slice(0, 7)})`);
else bad(`build stale:true: ${JSON.stringify(b.reasons)}`);
try {
  const w = await get("/api/watchdog");
  if (w.state === "on") ok(`watchdog on, last action: ${w.last_actions?.[0]?.action ?? "none"}`);
  else bad(`watchdog not on: ${JSON.stringify(w)}`);
} catch (e) {
  bad(`watchdog not on: ${e}`);
}
try {
  const r = await get("/api/runs");
  ok(`runs api answers (${Array.isArray(r) ? r.length : "?"} runs)`);
} catch {
  bad("runs api");
}
process.exit(fail ? 1 : 0);
