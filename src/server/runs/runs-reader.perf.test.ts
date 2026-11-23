import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { orchPaths } from "../files/paths";
import { listRunsCached, runExists } from "./runs-reader";

const homes: string[] = [];
const LIST_TTL_MS = 500;
/** A list holding a running run is reused this long (runs-reader RUNNING_SUMMARY_MS). */
const RUNNING_LIST_TTL_MS = 1000;

function homeWithRuns(runs: Readonly<Record<string, string>>): ReturnType<typeof orchPaths> {
  const home = mkdtempSync(join(tmpdir(), "orch-runs-perf-"));
  homes.push(home);
  for (const [id, status] of Object.entries(runs)) {
    mkdirSync(join(home, "runs", id), { recursive: true });
    writeFileSync(join(home, "runs", id, "state.json"), JSON.stringify({
      run_id: id,
      title: id,
      status,
      started: "2026-11-23T10:00:00.000Z",
      nodes: [],
    }));
  }
  return orchPaths(home);
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("listRunsCached memo", () => {
  test("reports miss, then hit, then fresh for bypass", () => {
    const paths = homeWithRuns({ "20261123-100000-aaaa": "done" });
    expect(listRunsCached(paths).cache.source).toBe("miss");
    expect(listRunsCached(paths).cache.source).toBe("hit");
    const bypass = listRunsCached(paths, true);
    expect(bypass.cache).toMatchObject({ mode: "bypass", source: "fresh" });
  });

  test("reuses the summary of an unchanged finished run after the list cache expires", async () => {
    const paths = homeWithRuns({ "20261123-100000-aaaa": "done", "20261123-100100-bbbb": "running" });
    const first = listRunsCached(paths).runs;
    await Bun.sleep(RUNNING_LIST_TTL_MS + 50);
    const second = listRunsCached(paths).runs;
    const done = (runs: typeof first) => runs.find((r) => r.run_id === "20261123-100000-aaaa");
    const running = (runs: typeof first) => runs.find((r) => r.run_id === "20261123-100100-bbbb");
    expect(done(second)).toBe(done(first) as NonNullable<ReturnType<typeof done>>);
    expect(running(second)).not.toBe(running(first) as NonNullable<ReturnType<typeof running>>);
  });

  test("re-reads a finished run whose state.json changed", async () => {
    const id = "20261123-100000-aaaa";
    const paths = homeWithRuns({ [id]: "done" });
    const first = listRunsCached(paths).runs[0];
    await Bun.sleep(LIST_TTL_MS + 50);
    writeFileSync(join(paths.runs, id, "state.json"), JSON.stringify({ run_id: id, title: "changed", status: "error", started: "2026-11-23T10:00:00.000Z", nodes: [] }));
    const second = listRunsCached(paths).runs[0];
    expect(second?.title).toBe("changed");
    expect(second).not.toBe(first as NonNullable<typeof first>);
  });

  test("bypass recomputes every run", () => {
    const paths = homeWithRuns({ "20261123-100000-aaaa": "done" });
    const first = listRunsCached(paths).runs[0];
    const bypass = listRunsCached(paths, true).runs[0];
    expect(bypass).not.toBe(first as NonNullable<typeof first>);
  });
});

describe("listRunsCached under a running run", () => {
  test("a warm read with a running run is a hit in under 50 ms, and bypass stays fresh", () => {
    const paths = homeWithRuns({ "20261123-100000-aaaa": "done", "20261123-100100-bbbb": "running" });
    listRunsCached(paths);
    const started = performance.now();
    const warm = listRunsCached(paths);
    const elapsed = performance.now() - started;
    expect(warm.cache).toMatchObject({ mode: "cache", source: "hit" });
    expect(elapsed).toBeLessThan(50);
    expect(listRunsCached(paths, true).cache).toMatchObject({ mode: "bypass", source: "fresh" });
  });
});

describe("runExists", () => {
  test("is true only for a run id with a state.json", () => {
    const paths = homeWithRuns({ "20261123-100000-aaaa": "done" });
    expect(runExists(paths, "20261123-100000-aaaa")).toBe(true);
    expect(runExists(paths, "20261123-100999-zzzz")).toBe(false);
    expect(runExists(paths, "../etc")).toBe(false);
  });
});
