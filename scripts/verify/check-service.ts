#!/usr/bin/env bun
// check-service.ts - the real service commands (macOS launchd) against a THROWAWAY label, temp HOME, temp home dir
// and a temp port, so the user's service (io.github.barnuri.orch, port 6724) is never touched: install, plist keys,
// status, logs, restart (SIGTERM pauses a running run, boot resumes it), boot recovery (a paused run with
// auto_resume resumes, a stopped run does not), /api/build, uninstall. PASS or FAIL per check; exit 1 on any FAIL.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, REPO_DIR, run, sleep, tmpDir, trashPath } from "../lib/util.ts";

if (process.platform !== "darwin") (console.log("SKIP check-service: launchd only (macOS)"), process.exit(0));
let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const root = realpathSync(mkdtempSync(join(tmpDir(), "svc-")));
const home = join(root, "h");
const fakeHome = join(root, "home");
mkdirSync(fakeHome);
const label = `io.github.barnuri.orch.verify${process.pid}`;
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);
const uid = run(["id", "-u"]).out.trim();
const real = () => run(["launchctl", "print", `gui/${uid}/io.github.barnuri.orch`]).out.match(/\bpid = (\d+)/)?.[1] ?? "none";
const realPidBefore = real();
const env = { HOME: fakeHome, ORCH_SERVICE_LABEL: label, HARNESS_ORCH_HOME: home };
const svc = (...a: string[]) => run([process.execPath, join(REPO_DIR, "scripts/service.ts"), ...a], { env });
const d = (...a: string[]) => run([process.execPath, DISPATCH, ...a], { env: { HARNESS_ORCH_HOME: home, ORCH_HERDR: "0" } });
const st = (id: string) => JSON.parse(readFileSync(join(home, "runs", id, "state.json"), "utf8"));
const plist = join(fakeHome, "Library/LaunchAgents", `${label}.plist`);
const pidNow = () => run(["launchctl", "print", `gui/${uid}/${label}`]).out.match(/\bpid = (\d+)/)?.[1] ?? "none";
const api = async (p: string) => { try { return await (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) })).json() as any; } catch { return null; } };
const until = async (f: () => boolean | Promise<boolean>, secs: number) => { for (let i = 0; i < secs * 2; i++) { if (await f()) return true; await sleep(500); } return false; };

d("init");
for (const id of ["rpaused", "rstopped", "rrunning"]) d("run", "start", id, "--id", id);
d("run", "pause", "rpaused");
d("run", "stop", "rstopped");
check(st("rpaused").paused === true && st("rpaused").auto_resume === true, "seed: rpaused paused with auto_resume");
check(st("rstopped").stopped === true && st("rstopped").auto_resume === false, "seed: rstopped stopped, no auto_resume");

const inst = svc("install", "--home", home, "--host", "127.0.0.1", "--port", String(port));
check(inst.code === 0 && inst.out.includes(`installed launchd agent ${label}`), `install: ${inst.out.split("\n")[0]} ${inst.err.trim().slice(0, 120)}`);
check(existsSync(plist) && plist.startsWith(fakeHome), `plist under the temp HOME: ${plist}`);
const lint = run(["plutil", "-lint", plist]);
check(lint.code === 0, `plutil -lint: ${lint.out.trim()}`);
const text = readFileSync(plist, "utf8");
check(/<key>AbandonProcessGroup<\/key>\s*<true\/>/.test(text), "plist has AbandonProcessGroup true");
check(text.includes(`<string>${label}</string>`) && !text.includes("<string>io.github.barnuri.orch</string>"), "plist carries the temp label, not the real one");
check(await until(async () => (await api("/api/health")) != null, 40), `server answers on temp port ${port}`);
const s1 = svc("status");
check(/state = running/.test(s1.out) && /answering/.test(s1.out), `status: ${s1.out.split("\n").filter((l) => /state =|pid =|listener/.test(l)).map((l) => l.trim()).join(" | ")}`);
check(await until(() => st("rpaused").paused === false, 30), `boot recovery: rpaused resumed (paused=${st("rpaused").paused})`);
check(st("rstopped").stopped === true, `boot recovery: rstopped not resumed (stopped=${st("rstopped").stopped}, paused=${st("rstopped").paused})`);
const b = await api("/api/build");
check(b?.stale === false, `/api/build stale:${b?.stale}`);
const lg = svc("logs", "-n", "40");
check(lg.code === 0 && /boot-resume: resuming rpaused/.test(lg.out) && !/boot-resume: resuming rstopped/.test(lg.out), `logs: ${(lg.out.match(/boot-resume: resuming \S+/g) ?? []).join(", ")}`);

const pid1 = pidNow();
check(st("rrunning").status === "running" && st("rrunning").paused !== true, "before restart: rrunning is running");
const rs = svc("restart");
check(rs.code === 0 && rs.out.includes("restarted"), `restart: ${rs.out.trim()} ${rs.err.trim().slice(0, 100)}`);
check(await until(() => pidNow() !== pid1 && pidNow() !== "none", 30), `new server pid ${pid1} -> ${pidNow()}`);
check(await until(async () => (await api("/api/health")) != null, 40), "server answers again after the restart");
check(await until(() => st("rrunning").paused !== true, 30), `after restart rrunning is not left paused (paused=${st("rrunning").paused})`);
const log2 = svc("logs", "-n", "60").out;
const gaps = st("rrunning").pauses ?? [];
check(/shutdown-pause: pausing rrunning/.test(log2) && /boot-resume: resuming rrunning/.test(log2) && gaps.length >= 1, `SIGTERM paused rrunning, boot resumed it: pause gap ${gaps[0]?.from} -> ${gaps[0]?.to}`);
check(st("rstopped").stopped === true, "after restart rstopped is still stopped, not resumed");
check((await api("/api/build"))?.stale === false, "/api/build stale:false after restart");

const un = svc("uninstall");
check(un.code === 0 && !existsSync(plist), `uninstall: ${un.out.trim().split("\n").pop()}`);
check(await until(() => pidNow() === "none", 20), "uninstall: the temp label is no longer loaded");
check(await until(async () => (await api("/api/health")) == null, 20), `uninstall: port ${port} no longer answers`);
check(real() === realPidBefore, `the real service untouched: pid ${realPidBefore} -> ${real()}`);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
