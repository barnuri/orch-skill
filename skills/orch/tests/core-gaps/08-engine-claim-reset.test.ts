import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempHome } from "../../../../src/server/test-support/temp-home";
import { RunEngine } from "../../../../src/server/runs/auto-dispatch";

const state = (updated: string) => ({
  run_id: "r1", status: "running", auto_dispatch: true,
  nodes: [{ id: "b", status: "waiting", label: "B", profile: "p", updated }],
  edges: [],
});

test("a node reset to waiting by hand releases its engine claim and starts again", async () => {
  const home = TempHome.create();
  const file = home.resolve("runs/r1/state.json");
  home.write("runs/r1/state.json", JSON.stringify(state("t1")));
  const starts: string[][] = [];
  const engine = new RunEngine(home.path, { log: () => {}, start: async (a) => (starts.push(a), 0) });
  engine.evaluate("r1");
  await Promise.all([...engine.inflight]);
  engine.evaluate("r1");
  await Promise.all([...engine.inflight]);
  expect(starts.length).toBe(1);

  writeFileSync(file, JSON.stringify(state("t2")));
  engine.evaluate("r1");
  await Promise.all([...engine.inflight]);
  expect(starts.length).toBe(2);
  const claims = home.resolve("autodispatch/r1/claims");
  const names = readdirSync(claims);
  expect(names.some((n) => n.includes(".reset-"))).toBe(true);
  expect(existsSync(join(claims, "b@0"))).toBe(true);
  expect(JSON.parse(readFileSync(join(claims, "b@0"), "utf8")).node_updated).toBe("t2");
  home.dispose();
});
