import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { orch, seedHome, readJson, readText, runCmd, DISPATCH, cleanEnv, autoCleanup } from "../helpers";
autoCleanup();

test("concurrent writers never lose a batch add", async () => {
  const home = seedHome(), o = orch(home, { ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "state lock").out.trim();
  o("node", "add", R, "base", "Base"); o("node", "update", R, "base", "running");
  const ADDS = Number(process.env.ORCH_TEST_LOCK_ADDS ?? 25);
  let stop = false;
  const writer = async () => {
    while (!stop) {
      const p = Bun.spawn(["bun", DISPATCH, "node", "ping", R, "base", "--progress", `p${Math.random()}`], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ORCH_OWNER_FILL: "0" }), stdout: "ignore", stderr: "ignore" });
      await p.exited;
    }
  };
  const ws = [writer(), writer()];
  const errs: string[] = [];
  for (let i = 1; i <= ADDS; i++) {
    const p = Bun.spawn(["bun", DISPATCH, "node", "batch", R], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ORCH_OWNER_FILL: "0" }), stdin: new Blob([`{"op":"add","id":"n${i}","goal":"node ${i}"}\n`]), stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) !== 0) errs.push(`n${i}: ${await new Response(p.stderr).text()}`);
  }
  stop = true;
  await Promise.all(ws);
  expect(errs).toEqual([]);
  const file = join(home, "runs", R, "state.json");
  const st = readJson(file);
  const missing = Array.from({ length: ADDS }, (_, i) => `n${i + 1}`).filter((n) => !st.nodes.some((x: any) => x.id === n));
  expect(missing).toEqual([]);
  expect(st.nodes[0].id).toBe("base");
  expect(readdirSync(join(home, "runs", R)).filter((f) => f.startsWith("state.json.tmp.")).length).toBe(0);
  expect(readText(join(home, "locks", `run-${R}.pid`)).trim()).toBe("");
}, 300000);
