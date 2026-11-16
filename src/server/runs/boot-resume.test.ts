import { afterEach, describe, expect, test } from "bun:test";

import { TempHome } from "../test-support/temp-home";
import { autoResumeRunIds, startBootResume } from "./boot-resume";

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
  "r-auto": JSON.stringify({ paused: true, auto_resume: true }),
  "r-manual": JSON.stringify({ paused: true }),
  "r-cleared": JSON.stringify({ paused: false, auto_resume: true }),
  "r-active": JSON.stringify({ status: "running" }),
  "r-stopped": JSON.stringify({ paused: true, auto_resume: true, stopped: true }),
  "r-broken": "{not json",
};

describe("boot resume", () => {
  test("lists only runs that are paused with auto_resume and not stopped", () => {
    const home = homeWith(RUNS);
    expect(autoResumeRunIds(home.path)).toEqual(["r-auto"]);
  });

  test("a home without runs/ lists nothing", () => {
    expect(autoResumeRunIds("/nonexistent-orch-home")).toEqual([]);
  });

  test("starts `run resume <run>` for each auto_resume run, without waiting", () => {
    const home = homeWith({ ...RUNS, "r-auto2": JSON.stringify({ paused: true, auto_resume: true }) });
    const calls: string[][] = [];
    const lines: string[] = [];
    const started = startBootResume(
      home.path,
      (args) => {
        calls.push([...args]);
        return new Promise<number>(() => {});
      },
      (l) => lines.push(l),
    );
    expect(started).toEqual(["r-auto", "r-auto2"]);
    expect(calls).toEqual([
      ["run", "resume", "r-auto"],
      ["run", "resume", "r-auto2"],
    ]);
  });

  test("a failing or throwing resume is logged, never thrown", async () => {
    const home = homeWith({
      a: JSON.stringify({ paused: true, auto_resume: true }),
      b: JSON.stringify({ paused: true, auto_resume: true }),
      c: JSON.stringify({ paused: true, auto_resume: true }),
    });
    const lines: string[] = [];
    const started = startBootResume(
      home.path,
      async (args) => {
        if (args[2] === "a") {
          throw new Error("spawn failed");
        }
        if (args[2] === "b") {
          return 1;
        }
        return 0;
      },
      (l) => lines.push(l),
    );
    expect(started).toEqual(["a", "b", "c"]);
    await Bun.sleep(10);
    expect(lines.some((l) => l.includes("a: spawn failed"))).toBe(true);
    expect(lines.some((l) => l.includes("b: run resume exited 1"))).toBe(true);
    expect(lines.some((l) => l.includes("c: run resume exited"))).toBe(false);
  });

  test("a synchronously throwing spawner does not stop the other runs", () => {
    const home = homeWith({
      a: JSON.stringify({ paused: true, auto_resume: true }),
      b: JSON.stringify({ paused: true, auto_resume: true }),
    });
    const calls: string[] = [];
    const lines: string[] = [];
    startBootResume(
      home.path,
      (args) => {
        calls.push(args[2] ?? "");
        if (args[2] === "a") {
          throw new Error("boom");
        }
        return Promise.resolve(0);
      },
      (l) => lines.push(l),
    );
    expect(calls).toEqual(["a", "b"]);
    expect(lines.some((l) => l.includes("a: boom"))).toBe(true);
  });
});
