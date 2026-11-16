import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { orch, seedHome, tempDir, readText, readJson, runCmd, DISPATCH, cleanEnv, opencodeFixture, waitUntil, autoCleanup } from "../helpers";
autoCleanup();
const base = { ORCH_WAIT_POLL_SECS: "0.1", ORCH_WAIT_HEALTH_SECS: "1", ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_CACHE_SECS: "0" };
const spawnWait = (home: string, env: Record<string, string>, ...args: string[]) =>
  Bun.spawn(["bun", DISPATCH, "run", "wait", ...args], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ...env }), stdout: "pipe", stderr: "pipe" });
const afterCursor = (home: string, R: string, fn: () => void) => (async () => { await waitUntil(() => existsSync(join(home, "runs", R, "wait.cursor")), 90); fn(); })();

test("wait --follow: restart without loss or duplicates, rescan", async () => {
  const home = seedHome();
  const env = { ...base, ORCH_OPENCODE_DB: join(tempDir(), "none.db"), ORCH_OWNER_FILL: "0" };
  const o = orch(home, env);
  const R = o("run", "start", "follow").out.trim();
  for (const n of ["a", "b", "c", "d", "e"]) { o("node", "add", R, n, n); o("node", "update", R, n, "running", "--owner", "coordinator"); }
  const fcur = join(home, "runs", R, "wait.follow.cursor");
  const logs: string[] = [];
  const start = async (extra: Record<string, string> = {}) => {
    const p = spawnWait(home, { ...env, ...extra }, R, "--follow");
    let buf = "";
    (async () => { for await (const c of p.stdout as any) buf += new TextDecoder().decode(c); })();
    await waitUntil(() => existsSync(fcur), 90);
    return { p, buf: () => buf };
  };
  const printed = (f: { buf: () => string }, line: string) => waitUntil(() => f.buf().split("\n").includes(line), 40);
  let f = await start();
  o("node", "update", R, "a", "done");
  expect(await printed(f, "a running->done")).toBe(true);
  o("node", "update", R, "b", "error", "--error", "boom");
  expect(await printed(f, "b running->error: boom")).toBe(true);
  o("node", "update", R, "c", "waiting");
  expect(await printed(f, "c running->waiting")).toBe(true);
  o("node", "update", R, "c", "running", "--owner", "coordinator");
  expect(await printed(f, "c waiting->running")).toBe(true);
  o("node", "update", R, "d", "done");
  o("run", "wait", R, "--timeout", "10");
  expect(await printed(f, "d running->done")).toBe(true);
  f.p.kill(); await f.p.exited;
  const first = f.buf();
  o("node", "update", R, "e", "done");
  f = await start();
  expect(await printed(f, "e running->done")).toBe(true);
  o("node", "update", R, "c", "done");
  expect(await printed(f, "c running->done")).toBe(true);
  f.p.kill(); await f.p.exited;
  const all = first + f.buf();
  for (const l of ["a running->done", "d running->done", "e running->done"]) expect(all.split("\n").filter((x) => x === l).length).toBe(1);

  const sf = join(home, "runs", R, "state.json");
  o("node", "add", R, "s", "s");
  writeFileSync(sf, JSON.stringify(readJson(sf), null, 2));
  f = await start({ ORCH_WAIT_RESCAN_SECS: "2" });
  await waitUntil(() => { try { return readJson(fcur).snap.nodes.s.s === "waiting"; } catch { return false; } }, 60);
  const st = statSync(sf), size0 = st.size;
  const text = readText(sf).replace('"id": "s"', '"id": "s"');
  const j = readJson(sf); j.nodes.find((n: any) => n.id === "s").status = "skipped";
  let out = JSON.stringify(j, null, 2);
  // keep the byte size and mtime identical so only a rescan can notice
  const pad = size0 - Buffer.byteLength(out);
  if (pad > 0) out = out.replace(/\n$/, "") + " ".repeat(pad);
  writeFileSync(sf, out);
  utimesSync(sf, st.atime, st.mtime);
  expect(await printed(f, "s waiting->skipped")).toBe(true);
  f.p.kill(); await f.p.exited;
}, 400000);
