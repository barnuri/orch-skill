import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { orch, seedHome, readJson, autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("demo seed writes statuses through the real node status path", () => {
  const home = seedHome();
  const o = orch(home);
  expect(o("demo", "seed").rc).toBe(0);
  const runs = readdirSync(join(home, "runs")).map((r) => readJson(join(home, "runs", r, "state.json")));
  const nodes = runs.flatMap((r: any) => r.nodes);
  const errored = nodes.find((n: any) => n.id === "probe");
  expect(errored.status).toBe("error");
  expect(typeof errored.next_retry_at).toBe("string");
  const running = nodes.find((n: any) => n.id === "handlers");
  expect(running.next_retry_at ?? null).toBeNull();
  expect(running.owner_kind).toBeTruthy();
  expect(running.seg_open).toBe(true);
  const done = nodes.find((n: any) => n.id === "survey");
  expect(done.finished_at).toBeTruthy();
  expect(done.next_retry_at ?? null).toBeNull();
});
