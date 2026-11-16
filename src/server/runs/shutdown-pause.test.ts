import { afterEach, describe, expect, test } from "bun:test";

import { TempHome } from "../test-support/temp-home";
import { pauseRunsOnShutdown, runningRunIds } from "./shutdown-pause";

const homes: TempHome[] = [];

function homeWith(runs: Record<string, string>): TempHome {
  const home = TempHome.create();
  homes.push(home);
  for (const [id, text] of Object.entries(runs)) {
    home.write(`runs/${id}/state.json`, text);
  }
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    home.dispose();
  }
});

const RUNS: Record<string, string> = {
  "r-running": JSON.stringify({ status: "running", paused: false }),
  "r-running2": JSON.stringify({ status: "running" }),
  "r-paused": JSON.stringify({ status: "running", paused: true, auto_resume: false }),
  "r-stopped": JSON.stringify({ status: "running", stopped: true }),
  "r-done": JSON.stringify({ status: "done" }),
  "r-error": JSON.stringify({ status: "error" }),
  "r-broken": "{not json",
};

function recorder(): { calls: string[]; pause: (id: string) => Promise<number> } {
  const calls: string[] = [];
  return {
    calls,
    pause: (id) => {
      calls.push(id);
      return Promise.resolve(0);
    },
  };
}

describe("shutdown pause", () => {
  test("lists only running runs that are neither paused nor stopped", () => {
    const home = homeWith(RUNS);
    expect(runningRunIds(home.path)).toEqual(["r-running", "r-running2"]);
  });

  test("a missing runs dir yields no ids", () => {
    expect(runningRunIds("/nonexistent-orch-home")).toEqual([]);
  });

  test("pauses each running run once and never a stopped one", async () => {
    const home = homeWith(RUNS);
    const { calls, pause } = recorder();
    const ids = await pauseRunsOnShutdown(home.path, pause, () => {});
    expect(ids).toEqual(["r-running", "r-running2"]);
    expect(calls.sort()).toEqual(["r-running", "r-running2"]);
  });

  test("a throwing, rejecting or failing pause never rejects and is logged", async () => {
    const home = homeWith({
      a: JSON.stringify({ status: "running" }),
      b: JSON.stringify({ status: "running" }),
      c: JSON.stringify({ status: "running" }),
    });
    const lines: string[] = [];
    const pause = (id: string): Promise<number> => {
      if (id === "a") {
        throw new Error("spawn failed");
      }
      return id === "b" ? Promise.reject(new Error("boom")) : Promise.resolve(3);
    };
    const ids = await pauseRunsOnShutdown(home.path, pause, (l) => lines.push(l));
    expect(ids).toEqual(["a", "b", "c"]);
    const text = lines.join("");
    expect(text).toContain("a: spawn failed");
    expect(text).toContain("b: boom");
    expect(text).toContain("c: run pause exited 3");
  });

  test("gives up after the timeout when a pause hangs", async () => {
    const home = homeWith({ slow: JSON.stringify({ status: "running" }) });
    const lines: string[] = [];
    const started = Date.now();
    const ids = await pauseRunsOnShutdown(
      home.path,
      () => new Promise<number>(() => {}),
      (l) => lines.push(l),
      50,
    );
    expect(ids).toEqual(["slow"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines.join("")).toContain("gave up waiting after 50 ms");
  });

  test("no runs: resolves at once with no calls", async () => {
    const home = homeWith({});
    const { calls, pause } = recorder();
    expect(await pauseRunsOnShutdown(home.path, pause, () => {})).toEqual([]);
    expect(calls).toEqual([]);
  });
});
