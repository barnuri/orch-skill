import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRunOverviewHandler, resetOverviewCache, type OverviewSpawner } from "./overview-route";
import type { ServerContext } from "../types/server-context";

test("concurrent and repeated overview requests share one dispatch build", async () => {
  resetOverviewCache();
  const home = mkdtempSync(join(tmpdir(), "ov-cache-"));
  const runs = join(home, "runs");
  mkdirSync(join(runs, "r1"), { recursive: true });
  writeFileSync(join(runs, "r1", "state.json"), JSON.stringify({ run_id: "r1", title: "t", status: "running", nodes: [] }));
  let calls = 0;
  const spawn: OverviewSpawner = async () => {
    calls += 1;
    await Bun.sleep(50);
    return { code: 0, stdout: JSON.stringify({ run_id: "r1", nodes: [] }) };
  };
  const ctx = { paths: { home, runs } } as unknown as ServerContext;
  const handler = readRunOverviewHandler(ctx, spawn);
  const responses = await Promise.all([1, 2, 3].map(() => handler(new Request("http://x/"), { id: "r1" })));
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  await handler(new Request("http://x/"), { id: "r1" });
  expect(calls).toBe(1);
});

test("an overview older than the cache window is served stale while one background build refreshes it", async () => {
  resetOverviewCache();
  const home = mkdtempSync(join(tmpdir(), "ov-swr-"));
  const runs = join(home, "runs");
  mkdirSync(join(runs, "r1"), { recursive: true });
  writeFileSync(join(runs, "r1", "state.json"), JSON.stringify({ run_id: "r1", title: "t", status: "running", nodes: [] }));
  let calls = 0;
  const spawn: OverviewSpawner = async () => {
    calls += 1;
    await Bun.sleep(30);
    return { code: 0, stdout: JSON.stringify({ run_id: "r1", nodes: [], build: calls }) };
  };
  const ctx = { paths: { home, runs } } as unknown as ServerContext;
  const handler = readRunOverviewHandler(ctx, spawn);
  const read = async (): Promise<{ build: number }> => (await handler(new Request("http://x/"), { id: "r1" })).json() as Promise<{ build: number }>;
  expect((await read()).build).toBe(1);
  writeFileSync(join(runs, "r1", "state.json"), JSON.stringify({ run_id: "r1", title: "t2", status: "running", nodes: [] }));
  expect((await read()).build).toBe(1);
  expect(calls).toBe(1);
  const realNow = Date.now;
  Date.now = () => realNow() + 20_000;
  try {
    expect((await read()).build).toBe(1);
    expect((await read()).build).toBe(1);
    await Bun.sleep(80);
    expect(calls).toBe(2);
  } finally {
    Date.now = realNow;
  }
});
