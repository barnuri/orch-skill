import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dispatch, seedHome, readJson, autoCleanup, runCmd, DISPATCH } from "../helpers";
autoCleanup();

test("use and the . run id", () => {
  const home = seedHome();
  const o = (...a: string[]) => runCmd([process.execPath, DISPATCH, ...a], { home, env: { ORCH_OWNER_FILL: "0" } });
  let r = o("node", "update", ".", "a", "running");
  expect(r.rc).toBe(1);
  expect(r.all).toMatch(/no current run/);
  expect(o("use", "nope-run").rc).toBe(1);

  const R = o("run", "start", "current run").out.trim();
  o("node", "add", R, "a", "A");
  expect(o("use", R).out.trim()).toBe(R);
  expect(readFileSync(join(home, "current-run"), "utf8").trim()).toBe(R);
  expect(o("use").out.trim()).toBe(R);

  expect(o("node", "update", ".", "a", "running").rc).toBe(0);
  const st = () => readJson(join(home, "runs", R, "state.json")).nodes;
  expect(st().find((n: any) => n.id === "a").status).toBe("running");

  const b = runCmd([process.execPath, DISPATCH, "node", "batch", "."], { home, env: { ORCH_OWNER_FILL: "0" }, stdin: '{"op":"add","id":"b","goal":"node b"}\n' });
  expect(b.rc).toBe(0);
  expect(st().some((n: any) => n.id === "b")).toBe(true);
  expect(o("run", "sync", ".").rc).toBe(0);
});
