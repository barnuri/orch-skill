#!/usr/bin/env bun
// check-watchdog-pill.ts - throwaway server (temp home, temp port, ORCH_STALL_MIN=1) and a headless browser
// (playwright-cli): the header watchdog pill is green with no flag, amber for a stalled node, red only for an
// infra-retry flag (retry already used), and every flag clears itself when its node leaves the flagged status.
// Reads the pill's class and its computed colour and compares it with the token the CSS says it must use.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, run, sleep, tmpDir, trashPath } from "../lib/util.ts";

let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const root = realpathSync(mkdtempSync(join(tmpDir(), "wdpill-")));
const home = join(root, "h");
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);
const base = `http://127.0.0.1:${port}`;
const env = { HARNESS_ORCH_HOME: home, ORCH_HERDR: "0" };
const d = (...a: string[]) => run([process.execPath, DISPATCH, ...a], { env });
const pw = (...a: string[]) => run(["playwright-cli", "-s=wdpill", ...a]);
const api = async () => (await (await fetch(`${base}/api/watchdog`)).json()) as any;
const until = async (f: () => boolean | Promise<boolean>, secs: number) => { for (let i = 0; i < secs * 2; i++) { if (await f()) return true; await sleep(500); } return false; };
const pill = () => {
  const r = pw("eval", `() => { const e = document.getElementById("watchdog-pill"); if (!e) return "none"; const s = getComputedStyle(document.documentElement); const c = getComputedStyle(e).color; const probe = document.createElement("span"); document.body.appendChild(probe); const res = (v) => { probe.style.color = "var(" + v + ")"; return getComputedStyle(probe).color; }; const o = { cls: e.className, color: c, ok: res("--ok"), stale: res("--status-stale"), er: res("--er"), mute: res("--mute") }; probe.remove(); return JSON.stringify(o); }`).out;
  const line = r.split("\n").find((l) => l.startsWith('"{')) ?? "";
  try { return JSON.parse(JSON.parse(line)); } catch { return null; }
};
const state = () => (pill()?.cls ?? "").match(/is-(\w+)/)?.[1] ?? "none";

d("init");
d("serve", "config", "set", "--host", "127.0.0.1", "--port", String(port));
d("run", "start", "wd", "--id", "w1");
d("node", "add", "w1", "ok1", "fake");
const server = Bun.spawn([process.execPath, DISPATCH, "serve"], { env: { ...process.env, ...env, ORCH_STALL_MIN: "1" }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
check(await until(async () => (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)), 40), `server up on ${port}`);
check(pw("open", `${base}/`).code === 0, "browser opened the dashboard");
check(await until(() => state() !== "none", 30), "watchdog pill rendered");
let p = pill();
check(state() === "ok" && p.color === p.ok, `no flag: pill is-${state()}, colour ${p?.color} = --ok ${p?.ok}`);

d("node", "update", "w1", "ok1", "running", "--at", "2020-01-01T00:00:00Z");
check(await until(async () => (await api()).flags?.some((f: any) => f.rule === "stalled"), 90), "watchdog flagged the idle running node: stalled");
check(await until(() => state() === "stalled", 40), "pill is-stalled");
p = pill();
check(p.color === p.stale && p.color !== p.er, `stalled pill is amber: ${p.color} = --status-stale ${p.stale}, not red ${p.er}`);

d("node", "add", "w1", "bad", "fake");
mkdirSync(join(home, "watchdog", "w1", "claims"), { recursive: true });
writeFileSync(join(home, "watchdog", "w1", "claims", "retry-bad"), "seeded: the one automatic retry is already used");
d("node", "update", "w1", "bad", "error", "--error", "dispatch exit 1");
check(await until(async () => (await api()).flags?.some((f: any) => f.rule === "infra-retry"), 60), "watchdog flagged the failed node: infra-retry");
check(await until(() => state() === "error", 40), "pill is-error");
p = pill();
check(p.color === p.er, `out-of-retries pill is red: ${p.color} = --er ${p.er}`);

d("node", "update", "w1", "bad", "skipped", "--force");
check(await until(async () => !(await api()).flags?.some((f: any) => f.rule === "infra-retry"), 30), "infra-retry flag cleared itself when the node left error");
check(await until(() => state() === "stalled", 40), "pill back to amber while the stalled node remains");
d("node", "update", "w1", "ok1", "done", "--force");
check(await until(async () => ((await api()).flags ?? []).length === 0, 30), "stalled flag cleared itself when the node finished");
check(await until(() => state() === "ok", 40), "pill back to green");
p = pill();
check(p.color === p.ok, `green again: ${p.color} = --ok ${p.ok}`);
console.log(`shot ${pw("screenshot", `--filename=${tmpDir()}/verify-watchdog-pill.png`).code === 0 ? tmpDir() + "/verify-watchdog-pill.png" : "failed"}`);
pw("close");
server.kill();
await server.exited;
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
